import {
  ClipSchema,
  STEM_LABELS_ES,
  STEM_NAMES,
  STEMS_JOB_TYPE,
  STEMS_SAMPLE_RATE,
  StemsRequestSchema,
  TrackSchema,
  tracksInZOrder,
  WorkerStemsResultSchema,
  type Clip,
  type MediaAsset,
  type Project,
  type StemName,
  type StemOutput,
  type StemsRequest,
  type StemsResult,
  type Track,
  type VisionTask,
  type WorkerStemsResult,
} from "@studio/shared";
import { nanoid } from "nanoid";
import { HttpError } from "../../lib/errors.js";
import { applyInheritedAiProvenance } from "../../services/ai-provenance.js";
import { projectContentHash } from "../../services/agent/project-hash.js";
import { WorkersError } from "../../services/workers-client.js";
import { registerAudioAsset, requireMediaAsset } from "../../voice-ai/media-bridge.js";
import { JobAbortedError } from "../state.js";
import type { JobContext, JobHandler } from "../types.js";
import { cancelWorkerTaskOnAbort, looseTaskDetail } from "./util.js";
import { toPackRequired, viaPacks, type AiDeps, type AiHandlerOptions } from "./ai.js";

/**
 * Sprint 3b job `audio.stems` (docs/trabajo/sprint3b-contratos.md §C): Demucs htdemucs in the
 * workers (POST /audio/stems, task polled on GET /audio/tasks/{id}) -> one audio asset per stem
 * (+ media.probe for the waveform). With `target.projectId` the stems go on new audio tracks
 * («Voz», «Música» or the 4 instruments) aligned to the source clip (start, in/out, speed, fades)
 * and the source clip is muted (volume 0). The project before that edit is stored as an agent
 * snapshot (plan id `stems:<jobId>`) so «Deshacer separación» restores it.
 */

/** Tag of the undo snapshot (agent_snapshots.plan_id) of a separation job. */
export const stemsSnapshotTag = (jobId: string) => `stems:${jobId}`;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new JobAbortedError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new JobAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Clip `clipId` of `project` with its track index, or undefined. */
export function findProjectClip(
  project: Project,
  clipId: string,
): { clip: Clip; track: Track; trackIndex: number } | undefined {
  for (const [trackIndex, track] of project.tracks.entries()) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track, trackIndex };
  }
  return undefined;
}

/** The asset a request separates: `assetId`, or the clip's asset in the target project. */
export function resolveStemsSource(
  deps: Pick<AiDeps, "repos">,
  req: StemsRequest,
): { asset: MediaAsset; project?: Project; clip?: Clip } {
  let project: Project | undefined;
  let clip: Clip | undefined;
  if (req.target) {
    project = deps.repos.projects.get(req.target.projectId);
    if (!project) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
  }
  if (req.clipId) {
    clip = project ? findProjectClip(project, req.clipId)?.clip : undefined;
    if (!clip) throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
    if (!clip.assetId) throw new HttpError(400, "BAD_REQUEST", "El clip no tiene medio");
    if (req.assetId && req.assetId !== clip.assetId)
      throw new HttpError(400, "BAD_REQUEST", "assetId no coincide con el medio del clip");
  }
  const asset = requireMediaAsset(deps, clip?.assetId ?? req.assetId!);
  if (asset.kind !== "audio" && asset.kind !== "video")
    throw new HttpError(400, "BAD_REQUEST", "Solo se separa el audio de un audio o video");
  if (asset.hasAudio === false)
    throw new HttpError(400, "BAD_REQUEST", "El medio no tiene audio para separar");
  return { asset, ...(project && { project }), ...(clip && { clip }) };
}

export interface StemPlacement {
  name: StemName;
  assetId: string;
  durationSec?: number;
}

/**
 * Explicit z-order (Track.order, sprint 3b layers): when the project already uses it, the stem tracks
 * go right after the source track in z-order (else on top) and every track is renumbered 0..n-1,
 * so the timeline rows (= z-order) show them next to the source. Projects without `order` keep the
 * array order (index = z) and an unchanged block hash.
 */
function withStemsZ(
  spliced: Track[],
  before: readonly Track[],
  added: readonly Track[],
  sourceTrackId: string | undefined,
): Track[] {
  if (!before.some((t) => t.order !== undefined)) return spliced;
  const byId = new Map(spliced.map((t) => [t.id, t]));
  const z = tracksInZOrder(before).map((t) => byId.get(t.id)!);
  const src = sourceTrackId ? z.findIndex((t) => t.id === sourceTrackId) : -1;
  z.splice(src >= 0 ? src + 1 : z.length, 0, ...added);
  return z.map((t, i) => ({ ...t, order: i }));
}

/**
 * Pure edit: new audio tracks right below the source clip's track (or at the end), one clip per
 * stem aligned to the source clip, and the source clip muted. Without a clip the stems start at 0 s
 * with their full length. Returns the new project plus the ids of what was created.
 */
export function placeStems(
  project: Project,
  stems: readonly StemPlacement[],
  sourceClipId: string | undefined,
  newId: () => string = () => nanoid(),
): {
  project: Project;
  placed: { name: StemName; trackId: string; clipId: string }[];
  previousVolume?: number;
} {
  const found = sourceClipId ? findProjectClip(project, sourceClipId) : undefined;
  const src = found?.clip;
  const volume = src && src.volume > 0 ? src.volume : 1;
  const placed: { name: StemName; trackId: string; clipId: string }[] = [];
  const newTracks: Track[] = stems.map((s) => {
    const trackId = newId();
    const clipId = newId();
    placed.push({ name: s.name, trackId, clipId });
    const clip = ClipSchema.parse({
      id: clipId,
      trackId,
      assetId: s.assetId,
      start: src?.start ?? 0,
      in: src?.in ?? 0,
      out: src?.out ?? Math.max(0.04, s.durationSec ?? 0.04),
      speed: src?.speed ?? 1,
      volume,
      ...(src?.transitionIn && { transitionIn: src.transitionIn }),
      ...(src?.transitionOut && { transitionOut: src.transitionOut }),
    });
    return TrackSchema.parse({
      id: trackId,
      kind: "audio",
      name: STEM_LABELS_ES[s.name],
      clips: [clip],
    });
  });
  const tracks = project.tracks.map((t) =>
    found && src && t.id === found.track.id
      ? { ...t, clips: t.clips.map((c) => (c.id === src.id ? { ...c, volume: 0 } : c)) }
      : t,
  );
  const at = found ? found.trackIndex + 1 : tracks.length;
  tracks.splice(at, 0, ...newTracks);
  return {
    project: { ...project, tracks: withStemsZ(tracks, project.tracks, newTracks, found?.track.id) },
    placed,
    ...(src && { previousVolume: src.volume }),
  };
}

/** Poll GET /audio/tasks/{id} until done/error; progress mapped to [from, to]. */
async function pollStemsTask(
  deps: AiDeps,
  taskId: string,
  ctx: JobContext,
  o: AiHandlerOptions & { from: number; to: number },
): Promise<WorkerStemsResult> {
  const dispose = cancelWorkerTaskOnAbort(deps.workers, "audio", taskId, ctx);
  try {
    return await pollStemsLoop(deps, taskId, ctx, o);
  } finally {
    dispose();
  }
}

async function pollStemsLoop(
  deps: AiDeps,
  taskId: string,
  ctx: JobContext,
  o: AiHandlerOptions & { from: number; to: number },
): Promise<WorkerStemsResult> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? 3 * 3600_000;
  let failures = 0;
  for (;;) {
    let task: VisionTask | undefined;
    try {
      task = await deps.workers.audioTask(taskId, ctx.signal);
      failures = 0;
    } catch (err) {
      if (ctx.signal.aborted) throw new JobAbortedError();
      if (err instanceof WorkersError && (err.statusCode === 404 || err.packRequired))
        throw toPackRequired(err);
      if (++failures >= 10) throw toPackRequired(err);
    }
    if (task) {
      const pct = Math.round(task.progress * 100);
      ctx.reportProgress(
        o.from + task.progress * (o.to - o.from),
        `Separando audio ${pct} %${task.message ? ` · ${task.message}` : ""}`,
        looseTaskDetail(task),
      );
      if ((task.status as string) === "canceled") throw new JobAbortedError();
      if (task.status === "error")
        throw new Error(`Separar audio: ${task.error ?? "error desconocido en los workers"}`);
      if (task.status === "done") return WorkerStemsResultSchema.parse(task.result ?? {});
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("Separar audio: la tarea no terminó a tiempo");
    await sleep(o.pollMs ?? 1000, ctx.signal);
  }
}

export function createAudioStemsHandler(
  deps: AiDeps,
  o: AiHandlerOptions = {},
): JobHandler<StemsRequest, StemsResult> {
  return {
    type: STEMS_JOB_TYPE,
    parse: (p) => StemsRequestSchema.parse(p),
    async run(req, ctx, job) {
      const { asset } = resolveStemsSource(deps, req);
      ctx.reportProgress(0.02, "Preparando la separación (Demucs htdemucs)");
      const { task_id } = await viaPacks(() =>
        deps.workers.audioStems({
          path: asset.path,
          mode: req.mode,
          output_base: `renders/stems-${job.id}`,
        }),
      );
      ctx.log(`Tarea de separación ${task_id} (${req.mode})`);
      const res = await pollStemsTask(deps, task_id, ctx, { ...o, from: 0.04, to: 0.9 });
      const warnings = [...(res.warnings ?? [])];
      for (const w of warnings) ctx.log(`AVISO: ${w}`);
      ctx.reportProgress(0.92, "Registrando las pistas separadas");
      const durationSec = res.duration_s ?? asset.durationSec;
      const stems: StemOutput[] = [];
      for (const name of STEM_NAMES[req.mode]) {
        const path = res.stems[name];
        if (!path) throw new Error(`Separar audio: los workers no devolvieron «${name}»`);
        const label = STEM_LABELS_ES[name];
        const registered = await registerAudioAsset(deps, {
          path,
          name: `${asset.name} (${label.toLowerCase()})`,
          sampleRate: res.sample_rate,
          ...(durationSec !== undefined && { durationSec }),
        });
        // Sprint 4: stems of a synthetic/cloned voice (or of a face-swapped video) inherit it.
        const created = applyInheritedAiProvenance(deps, registered, asset, { jobId: job.id });
        stems.push({ name, label, assetId: created.id, path });
      }
      const base: StemsResult = {
        mode: req.mode,
        sourceAssetId: asset.id,
        stems,
        sampleRate: res.sample_rate ?? STEMS_SAMPLE_RATE,
        device: res.device,
        ...(warnings.length > 0 && { warnings }),
      };
      if (!req.target) return base;

      // Re-read the project: it may have been edited while the workers separated the audio.
      const projectId = req.target.projectId;
      const current = deps.repos.projects.get(projectId);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      if (req.clipId && !findProjectClip(current, req.clipId)) {
        ctx.log("El clip de origen ya no está en el proyecto: las pistas quedan solo en Media");
        return { ...base, projectId, warnings: [...warnings, "source_clip_missing"] };
      }
      const edit = placeStems(
        current,
        stems.map((s) => ({ name: s.name, assetId: s.assetId, durationSec })),
        req.clipId,
      );
      const undoSnapshotId = deps.repos.agentPlans.snapshot(current, stemsSnapshotTag(job.id));
      const saved = deps.repos.projects.save(projectId, edit.project);
      if (!saved) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      const byName = new Map(edit.placed.map((p) => [p.name, p]));
      ctx.log(`Pistas nuevas: ${stems.map((s) => s.label).join(", ")}`);
      return {
        ...base,
        stems: stems.map((s) => ({
          ...s,
          trackId: byName.get(s.name)!.trackId,
          clipId: byName.get(s.name)!.clipId,
        })),
        projectId,
        ...(req.clipId && { sourceClipId: req.clipId }),
        ...(edit.previousVolume !== undefined && { previousVolume: edit.previousVolume }),
        undoSnapshotId,
        postEditHash: projectContentHash(saved),
      };
    },
  };
}

export function registerAudioStemsHandler(deps: AiDeps, o: AiHandlerOptions = {}): void {
  deps.queue.register(createAudioStemsHandler(deps, o) as JobHandler);
}
