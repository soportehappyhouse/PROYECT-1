import { statSync } from "node:fs";
import {
  clipsOfAsset,
  clipsSignature,
  SPRINT6_ERRORS,
  SUGGESTION_THRESHOLDS,
  SuggestionKindSchema,
  SuggestionSettingsSchema,
  suggestionsFromAnalysis,
  validateEditPlan,
  type AgentPlanRecord,
  type ImportAnalysis,
  type ImportSuggestion,
  type Job,
  type MediaAsset,
  type Project,
  type SuggestionSettings,
} from "@studio/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../lib/errors.js";
import { resolvePlanForRecord } from "../agent/aspect.js";
import { resolvePlan } from "../agent/resolve.js";
import { resolveStoragePath } from "../storage.js";
import { SuggestionsRepo, type SuggestionRow } from "./store.js";

/**
 * Sprint 6 M3 (docs/trabajo/sprint6-contratos.md): suggestions after an import.
 * - media.probe of a video/audio with sound succeeded → `suggest.analyze` (lane background,
 *   priority −10) when the suggestions are enabled, the medium lasts ≤ 30 min and fewer than 3
 *   analyses are active (the rest wait in memory and start when one ends).
 * - GET …/suggestions recomputes the cards of the project from the stored analyses (pure
 *   suggestionsFromAnalysis): new cards open, cards whose clips changed are recomputed, cards that
 *   no longer apply or whose file changed become `stale`, cards whose plan was applied become
 *   `applied` (and open again when that plan is undone).
 * - «Aplicar» = an AgentPlanRecord validated and resolved like any other plan (Asistente history,
 *   «Deshacer todo»). Nothing is applied here.
 */

export const SUGGESTION_SETTINGS_KEY = "suggestions.settings";
const PV = SUGGESTION_THRESHOLDS.params_version;
const KINDS = SuggestionKindSchema.options;

const err = (code: "SUGGESTION_NOT_FOUND" | "SUGGESTION_STALE") =>
  new HttpError(SPRINT6_ERRORS[code].status, code, SPRINT6_ERRORS[code].message_es);

export function fileSigOf(abs: string): ImportAnalysis["file_sig"] | undefined {
  try {
    const st = statSync(abs);
    return { size: st.size, mtime_ms: Math.round(st.mtimeMs) };
  } catch {
    return undefined;
  }
}

/** Assets of the project's sounding clips (video/audio tracks, not muted). */
export function projectAssetIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const t of project.tracks) {
    if (t.muted || (t.kind !== "video" && t.kind !== "audio")) continue;
    for (const c of t.clips) if (c.assetId) ids.add(c.assetId);
  }
  return [...ids];
}

export class SuggestionsService {
  readonly repo: SuggestionsRepo;
  /** Assets waiting for a free slot of the automatic analysis (max_parallel_imports). */
  readonly #pending: string[] = [];

  constructor(private readonly app: AppContext) {
    this.repo = new SuggestionsRepo(app.db);
  }

  settings(): SuggestionSettings {
    return SuggestionSettingsSchema.parse(
      this.app.repos.settings.get<unknown>(SUGGESTION_SETTINGS_KEY) ?? {},
    );
  }

  saveSettings(body: unknown): SuggestionSettings {
    const next = SuggestionSettingsSchema.parse(body);
    next.mutedKinds = [...new Set(next.mutedKinds)];
    this.app.repos.settings.set(SUGGESTION_SETTINGS_KEY, next);
    return next;
  }

  mute(kind: ImportSuggestion["kind"]): void {
    const s = this.settings();
    if (!s.mutedKinds.includes(kind))
      this.saveSettings({ ...s, mutedKinds: [...s.mutedKinds, kind] });
  }

  fileSig(asset: Pick<MediaAsset, "path">): ImportAnalysis["file_sig"] | undefined {
    return fileSigOf(resolveStoragePath(this.app.config.storageDir, asset.path));
  }

  /** Active (queued/running) suggest.analyze jobs. */
  activeJobs(): Job[] {
    return (["running", "queued"] as const).flatMap((status) =>
      this.app.jobs.list({ status, type: "suggest.analyze", limit: 200 }),
    );
  }

  analyzingAssets(): Set<string> {
    const out = new Set<string>(this.#pending);
    for (const j of this.activeJobs()) {
      const id = (j.payload as { assetId?: unknown } | undefined)?.assetId;
      if (typeof id === "string") out.add(id);
    }
    return out;
  }

  /** Whether the asset is worth an automatic analysis (sound, ≤ 30 min). */
  eligible(asset: MediaAsset | undefined): asset is MediaAsset {
    if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) return false;
    if (asset.hasAudio === false) return false;
    return (asset.durationSec ?? 0) <= SUGGESTION_THRESHOLDS.long_video_s;
  }

  /** Queue the analysis of `assetId` (manual = POST /api/media/:id/analyze: no auto limits). */
  enqueueAnalysis(assetId: string, opts: { projectId?: string; force?: boolean } = {}): Job {
    const active = this.app.queue.activeJob("suggest.analyze", (p) => p.assetId === assetId);
    if (active && !opts.force) return active;
    return this.app.queue.enqueue({
      type: "suggest.analyze",
      payload: {
        assetId,
        ...(opts.projectId && { projectId: opts.projectId }),
        force: opts.force ?? false,
      },
      priority: SUGGESTION_THRESHOLDS.background_priority,
    });
  }

  /** Automatic analysis after media.probe (enabled, eligible, not analyzed, ≤ 3 active). */
  autoAnalyze(assetId: string): Job | undefined {
    if (!this.settings().enabled) return undefined;
    const asset = this.app.repos.media.get(assetId);
    if (!this.eligible(asset)) return undefined;
    const sig = this.fileSig(asset);
    if (sig && this.repo.analysis(assetId, PV, sig)) return undefined;
    if (this.app.queue.activeJob("suggest.analyze", (p) => p.assetId === assetId)) return undefined;
    if (this.activeJobs().length >= SUGGESTION_THRESHOLDS.max_parallel_imports) {
      if (!this.#pending.includes(assetId)) this.#pending.push(assetId);
      return undefined;
    }
    return this.enqueueAnalysis(assetId);
  }

  /** A suggest.analyze ended: start the next waiting asset. */
  drainPending(): void {
    while (
      this.#pending.length &&
      this.activeJobs().length < SUGGESTION_THRESHOLDS.max_parallel_imports
    ) {
      const next = this.#pending.shift()!;
      this.autoAnalyze(next);
    }
  }

  /** Recompute and store the cards of the project; returns every stored card of it. */
  refresh(project: Project): ImportSuggestion[] {
    const settings = this.settings();
    const now = new Date().toISOString();
    const inProject = projectAssetIds(project);
    for (const assetId of inProject) {
      const asset = this.app.repos.media.get(assetId);
      if (!asset) continue;
      const sig = this.fileSig(asset);
      const analysis = sig ? this.repo.analysis(assetId, PV, sig) : undefined;
      const drafts = analysis
        ? suggestionsFromAnalysis(analysis, project, asset, settings.mutedKinds)
        : [];
      for (const kind of KINDS) {
        const row = this.repo.find(project.id, assetId, kind);
        const draft = drafts.find((d) => d.kind === kind);
        const sigNow = draft ? clipsSignature(project, draft.clipIds) : "";
        const planStatus = row?.planId
          ? this.app.repos.agentPlans.get(row.planId)?.status
          : undefined;
        if (!row) {
          if (!draft) continue;
          this.repo.save(
            { ...draft, id: nanoid(), status: "open", created_at: now, updated_at: now },
            sigNow,
          );
          continue;
        }
        const status = row.suggestion.status;
        if (status === "dismissed" || settings.mutedKinds.includes(kind)) continue;
        if (status === "applied") {
          // «Deshacer todo» put the plan back to proposed: the card comes back when still valid.
          if (planStatus !== "applied" && draft)
            this.#update(row, draft, sigNow, "open", now, null);
          continue;
        }
        if (planStatus === "applied") {
          this.repo.setStatus(row, "applied");
          continue;
        }
        if (draft) {
          const same =
            status === "open" &&
            row.signature === sigNow &&
            JSON.stringify(row.suggestion.plan) === JSON.stringify(draft.plan);
          if (!same) this.#update(row, draft, sigNow, "open", now, row.planId);
        } else if (status === "open") {
          this.repo.setStatus(row, "stale");
        }
      }
    }
    // Cards of assets that left the project.
    for (const row of this.repo.list(project.id))
      if (row.suggestion.status === "open" && !inProject.includes(row.suggestion.assetId))
        this.repo.setStatus(row, "stale");
    return this.repo
      .list(project.id)
      .map((r) => r.suggestion)
      .filter((s) => !settings.mutedKinds.includes(s.kind));
  }

  #update(
    row: SuggestionRow,
    draft: Omit<ImportSuggestion, "id" | "status" | "created_at" | "updated_at">,
    signature: string,
    status: ImportSuggestion["status"],
    now: string,
    planId: string | null,
  ): void {
    this.repo.save(
      {
        ...draft,
        id: row.suggestion.id,
        status,
        created_at: row.suggestion.created_at,
        updated_at: now,
      },
      signature,
      planId,
    );
  }

  /** Card of the project or 404 SUGGESTION_NOT_FOUND. */
  require(projectId: string, sid: string): SuggestionRow {
    const row = this.repo.get(sid);
    if (!row || row.suggestion.projectId !== projectId) throw err("SUGGESTION_NOT_FOUND");
    return row;
  }

  /** «Aplicar»: validated + resolved AgentPlanRecord (proposed) linked to the card. */
  async plan(project: Project, sid: string): Promise<AgentPlanRecord> {
    this.require(project.id, sid);
    this.refresh(project);
    const row = this.require(project.id, sid);
    const s = row.suggestion;
    if (s.status === "stale") throw err("SUGGESTION_STALE");
    if (s.status !== "open") throw err("SUGGESTION_NOT_FOUND");
    if (clipsSignature(project, s.clipIds) !== row.signature) throw err("SUGGESTION_STALE");
    if (!s.clipIds.every((id) => clipsOfAsset(project, s.assetId).some((c) => c.id === id)))
      throw err("SUGGESTION_STALE");
    const validation = validateEditPlan(s.plan);
    if (!validation.ok)
      throw new HttpError(500, "PLAN_INVALID", `Plan inválido: ${validation.errors.join("; ")}`);
    const packs = await this.app.workers.packs().catch(() => undefined);
    const media = (id: string) => this.app.repos.media.get(id);
    const r = resolvePlanForRecord(
      validation.plan,
      {
        project,
        media,
        presets: this.app.repos.presets.list(),
        assets: this.app.repos.media.list({ limit: 500 }),
        ...(packs && { packs }),
      },
      resolvePlan,
    );
    const record: AgentPlanRecord = {
      id: nanoid(),
      projectId: project.id,
      command: s.title_es,
      status: "proposed",
      created_at: new Date().toISOString(),
      model: null,
      route: "deterministic",
      latency_ms: 0,
      attempts: 0,
      warnings: [`suggestion:${s.id}`],
      ok: r.unresolved.length === 0 && validation.plan.ops.length > 0,
      plan: validation.plan,
      added: [],
      choices: [],
      ...r,
      errors: [],
    };
    this.app.repos.agentPlans.insert(record);
    this.repo.save({ ...s, updated_at: new Date().toISOString() }, row.signature, record.id);
    return record;
  }

  dismiss(projectId: string, sid: string, muteKind: boolean): ImportSuggestion {
    const row = this.require(projectId, sid);
    if (muteKind) this.mute(row.suggestion.kind);
    return this.repo.setStatus(row, "dismissed");
  }
}

const services = new WeakMap<AppContext, SuggestionsService>();

/** One service per app (routes, media hook and the job handler share the pending list). */
export function suggestionsService(app: AppContext): SuggestionsService {
  let s = services.get(app);
  if (!s) {
    s = new SuggestionsService(app);
    services.set(app, s);
  }
  return s;
}

const hooked = new WeakSet<AppContext>();

/**
 * Listen to the job events once per app: a succeeded media.probe queues the automatic analysis;
 * a finished suggest.analyze starts the next waiting asset. Returns the disposer.
 */
export function installSuggestionHooks(app: AppContext): () => void {
  if (hooked.has(app)) return () => undefined;
  hooked.add(app);
  const svc = suggestionsService(app);
  const onJob = (ev: { jobId: string; status: string }) => {
    if (ev.status !== "succeeded" && ev.status !== "failed" && ev.status !== "canceled") return;
    const job = app.jobs.get(ev.jobId);
    if (!job) return;
    try {
      if (job.type === "media.probe" && ev.status === "succeeded") {
        const id = (job.payload as { assetId?: unknown } | undefined)?.assetId;
        if (typeof id === "string") svc.autoAnalyze(id);
      } else if (job.type === "suggest.analyze") {
        svc.drainPending();
      }
    } catch {
      // A failing background analysis must never break the import (it only logs).
    }
  };
  app.queue.on("job", onJob);
  return () => {
    app.queue.off("job", onJob);
    hooked.delete(app);
  };
}
