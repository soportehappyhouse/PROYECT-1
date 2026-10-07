import { stat } from "node:fs/promises";
import {
  coveredPhotos,
  FACE_SWAPPER_INFO,
  FacePreviewRequestSchema,
  FaceSwapRequestSchema,
  IdSchema,
  LicenceIdSchema,
  MediaAssetSchema,
  SPRINT4_ERRORS,
  TOOL_MISSING_PYTHON_ES,
  TOOL_NAME_ES,
  TOOL_STATE_ES,
  type Clip,
  type Consent,
  type FacePreviewRequest,
  type FacePreviewResult,
  type FaceSelector,
  type FaceSwapRequest,
  type FaceSwapResult,
  type MediaAsset,
  type Pack,
  type Person,
  type Project,
  type Sprint4ErrorCode,
  type ToolMissingDetails,
} from "@studio/shared";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { errorBody, HttpError, PackRequiredError, sprint4Error } from "../../lib/errors.js";
import {
  createFaceWorkers,
  WorkerFaceTaskResultSchema,
  type FaceWorkers,
  type WorkerFaceSwapRequest,
  type WorkerFaceTaskResult,
} from "../../services/persons/face-workers.js";
import {
  consentRequired,
  createConsentGate,
  type PersonsService,
} from "../../services/persons/gate.js";
import { resolveStoragePath } from "../../services/storage.js";
import { JobAbortedError } from "../state.js";
import type { JobContext, JobHandler } from "../types.js";

/**
 * Sprint 4 M1 jobs `face.preview` / `face.swap` (lane workers; docs/trabajo/sprint4-contratos.md
 * «M1 · Jobs»): FaceFusion 3.9.1 runs in the workers as an isolated subprocess. The same preflight
 * (licence «faceswap» -> pack faceswap (+ faceswap-extra) -> face consent of the Person -> isolated
 * venv ready -> limits) runs when the job is enqueued (routes/face.ts) and again when it starts, so
 * a consent revoked or a licence withdrawn while the job waited in the queue blocks it.
 */

export const FACE_PACK_ID = "faceswap";
export const FACE_LICENCE = "faceswap" as const;
export const MAX_FACE_SECONDS = 600;
export const MAX_FACE_LONG_SIDE = 3840;
export const MAX_FACE_SHORT_SIDE = 2160;
export const FACEFUSION_VERSION = "3.9.1";

/** Job payloads = the route requests + what the enqueue preflight found (audit / provenance). */
export const FaceSwapJobPayloadSchema = FaceSwapRequestSchema.extend({
  consentId: IdSchema.optional(),
  licences: z.array(LicenceIdSchema).optional(),
});
export type FaceSwapJobPayload = z.infer<typeof FaceSwapJobPayloadSchema>;
export const FacePreviewJobPayloadSchema = FacePreviewRequestSchema.extend({
  consentId: IdSchema.optional(),
  licences: z.array(LicenceIdSchema).optional(),
});
export type FacePreviewJobPayload = z.infer<typeof FacePreviewJobPayloadSchema>;

export type FaceDeps = Pick<AppContext, "config" | "repos" | "queue" | "workers"> & {
  gate: PersonsService;
  face: FaceWorkers;
};

export interface FaceHandlerOptions {
  /** Polling interval of GET /face/tasks/{id} (ms, default 1000). */
  pollMs?: number;
  timeoutMs?: number;
}

/** A failed job carries the ApiError body as `result` (the web reads the code from it). */
export function withJobResult(err: unknown): unknown {
  if (err instanceof HttpError && !("jobResult" in err))
    Object.assign(err, { jobResult: errorBody(err.code, err.message, err.details) });
  return err;
}

export function findClip(
  project: Project,
  clipId: string,
): { clip: Clip; kind: string } | undefined {
  for (const t of project.tracks) {
    const clip = t.clips.find((c) => c.id === clipId);
    if (clip) return { clip, kind: t.kind };
  }
  return undefined;
}

export interface FacePreflight {
  person: Person;
  consent: Consent;
  asset: MediaAsset;
  /** Photos of the Person used as FaceFusion sources (STORAGE_DIR-relative, consent/...). */
  photos: string[];
  /** Seconds of the asset processed by face.swap (undefined for the preview). */
  range?: { start: number; end: number };
  project?: Project;
  clip?: Clip;
  packs?: readonly Pack[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function toolMissing(state: ToolMissingDetails["state"]): HttpError {
  const details: ToolMissingDetails = { tool: "facefusion", state, packId: FACE_PACK_ID };
  if (state === "python")
    return new HttpError(
      SPRINT4_ERRORS.TOOL_MISSING.status,
      "TOOL_MISSING",
      TOOL_MISSING_PYTHON_ES,
      details,
    );
  return sprint4Error(
    "TOOL_MISSING",
    { herramienta: TOOL_NAME_ES.facefusion, estado: TOOL_STATE_ES[state] },
    details,
  );
}

/**
 * The checks of the contract, in order: licence -> pack(s) -> consent -> tool venv -> limits.
 * `packs`: GET /packs of the workers (undefined = unreachable: pack/tool checks are skipped here and
 * the workers check again). Throws HttpError / PackRequiredError.
 */
export function facePreflight(
  deps: Pick<FaceDeps, "repos" | "gate">,
  req: (FaceSwapRequest | FacePreviewRequest) & { t?: number },
  kind: "preview" | "swap",
  packs: readonly Pack[] | undefined,
): FacePreflight {
  const asset = deps.repos.media.get(req.assetId);
  if (!asset) throw new HttpError(404, "NOT_FOUND", `Medio ${req.assetId} no encontrado`);
  if (asset.kind !== "video" || asset.hasVideo === false)
    throw new HttpError(400, "BAD_REQUEST", "El cambio de cara necesita un clip de video");

  // 1. licence accepted on screen (current text version)
  deps.gate.assertLicence(FACE_LICENCE);
  // 2. packs: faceswap, plus faceswap-extra for ghost / inswapper
  const needPacks = [FACE_PACK_ID];
  const extra = FACE_SWAPPER_INFO[req.options.model].pack;
  if (extra !== FACE_PACK_ID) needPacks.push(extra);
  for (const id of needPacks) {
    const pack = packs?.find((p) => p.id === id);
    if (pack && !pack.installed)
      throw new PackRequiredError(pack.id, pack.name_es, pack.size_bytes);
  }
  // 3. face consent of the Person (404 / 403 CONSENT_REQUIRED with the reason)
  const { person, consent } = deps.gate.assertConsent(req.personId, "face");
  // 4. isolated FaceFusion venv (tools/facefusion/.venv) ready
  const tool = packs?.find((p) => p.id === FACE_PACK_ID)?.tool;
  if (tool && tool.state !== "ready") throw toolMissing(tool.state);
  // 5. limits (≤ 10 min and ≤ 4K per job)
  const long = Math.max(asset.width ?? 0, asset.height ?? 0);
  const short = Math.min(asset.width ?? 0, asset.height ?? 0);
  if (long > MAX_FACE_LONG_SIDE || short > MAX_FACE_SHORT_SIDE) throw sprint4Error("CLIP_TOO_LONG");
  const duration = asset.durationSec;
  let range: { start: number; end: number } | undefined;
  let project: Project | undefined;
  let clip: Clip | undefined;
  if (kind === "swap") {
    const sreq = req as FaceSwapRequest;
    if (sreq.target) {
      project = deps.repos.projects.get(sreq.target.projectId);
      if (!project) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      const found = findClip(project, sreq.target.clipId);
      if (!found) throw new HttpError(404, "NOT_FOUND", "Clip no encontrado en el proyecto");
      clip = found.clip;
      if (clip.assetId !== asset.id)
        throw new HttpError(400, "BAD_REQUEST", "assetId no coincide con el medio del clip");
      range = { start: clip.in, end: clip.out };
    } else if (sreq.range) range = { ...sreq.range };
    else range = { start: 0, end: duration ?? 0 };
    if (duration !== undefined && range.end > duration + 0.05) range.end = duration;
    range = { start: round3(Math.max(0, range.start)), end: round3(range.end) };
    if (!(range.end - range.start >= 0.04))
      throw new HttpError(400, "BAD_REQUEST", "El tramo a procesar no tiene duración");
    if (range.end - range.start > MAX_FACE_SECONDS) throw sprint4Error("CLIP_TOO_LONG");
    if (
      sreq.selector.mode === "reference" &&
      (sreq.selector.t < range.start - 0.05 || sreq.selector.t > range.end + 0.05)
    )
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "El fotograma de referencia de la cara tiene que estar dentro del tramo",
      );
  } else {
    const t = (req as FacePreviewRequest).t;
    if (duration !== undefined && t > duration + 0.05)
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "El momento de la vista previa queda fuera del video",
      );
  }
  // Audit fix 3: only the photos the consent covers (captured when it was accepted).
  const photos = coveredPhotos(person)
    .filter((p) => p.faces !== 0)
    .map((p) => p.path);
  if (photos.length === 0) {
    if (person.photos.some((p) => p.faces !== 0)) throw consentRequired(person, "face", "scope");
    throw sprint4Error("NO_FACE", { donde: `las fotos de «${person.name}» (subí al menos una)` });
  }
  return {
    person,
    consent,
    asset,
    photos,
    ...(range && { range }),
    ...(project && { project }),
    ...(clip && { clip }),
    ...(packs && { packs }),
  };
}

/** Workers selector (seconds of the asset). */
export function workerSelector(sel: FaceSelector): WorkerFaceSwapRequest["selector"] {
  return sel.mode === "reference"
    ? { mode: "reference", t: sel.t, face_index: sel.faceIndex, distance: sel.distance }
    : { mode: "one" };
}

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

const SPRINT4_CODES = new Set(Object.keys(SPRINT4_ERRORS));

/** A workers task that ended in error -> the api error (same code / status / details). */
export function taskError(task: {
  error?: string | null;
  code?: string | null;
  details?: unknown;
}): Error {
  const message = task.error || "error desconocido en los workers";
  const code = task.code ?? undefined;
  if (code === "PACK_REQUIRED") {
    const d = (task.details ?? {}) as {
      packId?: string;
      pack_id?: string;
      name_es?: string;
      size_bytes?: number;
    };
    const packId = d.packId ?? d.pack_id ?? FACE_PACK_ID;
    return new PackRequiredError(packId, d.name_es ?? packId, Number(d.size_bytes ?? 0));
  }
  if (code && SPRINT4_CODES.has(code)) {
    const c = code as Sprint4ErrorCode;
    const details =
      c === "TOOL_FAILED"
        ? {
            logTail: ((task.details as { logTail?: unknown; log_tail?: unknown } | undefined)
              ?.logTail ??
              (task.details as { log_tail?: unknown } | undefined)?.log_tail ??
              []) as unknown,
          }
        : task.details;
    return new HttpError(SPRINT4_ERRORS[c].status, c, message, details);
  }
  return new Error(`Cambio de cara: ${message}`);
}

async function pollFaceTask(
  deps: FaceDeps,
  taskId: string,
  ctx: JobContext,
  o: FaceHandlerOptions & { label: string; from: number; to: number },
): Promise<WorkerFaceTaskResult> {
  const t0 = Date.now();
  const timeoutMs = o.timeoutMs ?? 6 * 3600_000;
  let failures = 0;
  for (;;) {
    if (ctx.signal.aborted) {
      await deps.face.cancel(taskId);
      throw new JobAbortedError();
    }
    let task;
    try {
      task = await deps.face.task(taskId);
      failures = 0;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) throw err;
      if (++failures >= 10) throw err;
    }
    if (task) {
      const pct = Math.round(task.progress * 100);
      ctx.reportProgress(
        o.from + Math.min(1, Math.max(0, task.progress)) * (o.to - o.from),
        `${o.label} ${pct} %${task.message ? ` · ${task.message}` : ""}`,
      );
      if (task.status === "error") throw taskError(task);
      if (task.status === "done") return WorkerFaceTaskResultSchema.parse(task.result ?? {});
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${o.label}: la tarea no terminó a tiempo`);
    try {
      await sleep(o.pollMs ?? 1000, ctx.signal);
    } catch (err) {
      await deps.face.cancel(taskId);
      throw err;
    }
  }
}

async function runPreflight(
  deps: FaceDeps,
  req: FaceSwapJobPayload | FacePreviewJobPayload,
  kind: "preview" | "swap",
): Promise<FacePreflight> {
  const packs = await deps.workers.packs().catch(() => undefined);
  return facePreflight(deps, req, kind, packs);
}

const toolLabel = (model: string) => `facefusion ${FACEFUSION_VERSION} ${model}`;

/** face.preview: one frame before/after (PNGs in renders/face/<jobId>/, served by /files). */
export function createFacePreviewHandler(
  deps: FaceDeps,
  o: FaceHandlerOptions = {},
): JobHandler<FacePreviewJobPayload, FacePreviewResult> {
  return {
    type: "face.preview",
    parse: (p) => FacePreviewJobPayloadSchema.parse(p),
    async run(req, ctx, job) {
      const t0 = Date.now();
      try {
        const pre = await runPreflight(deps, req, "preview");
        deps.gate.audit({
          action: "face.preview",
          personId: pre.person.id,
          consentId: pre.consent.id,
          jobId: job.id,
          assetId: pre.asset.id,
          data: { t: req.t, model: req.options.model },
        });
        ctx.reportProgress(0.03, "Preparando la vista previa (FaceFusion)");
        const { task_id } = await deps.face.swap({
          source_paths: pre.photos,
          target_path: pre.asset.path,
          output_base: `renders/face/${job.id}/`,
          preview_t: req.t,
          selector: workerSelector(req.selector),
          model: req.options.model,
          enhancer: req.options.enhancer,
          enhancer_blend: req.options.enhancerBlend,
          strength: req.options.strength,
          consent_id: pre.consent.id,
          licence_ids: [FACE_LICENCE],
        });
        ctx.log(`Tarea de cambio de cara ${task_id} (vista previa en ${req.t} s)`);
        const res = await pollFaceTask(deps, task_id, ctx, {
          ...o,
          label: "Vista previa del cambio de cara",
          from: 0.05,
          to: 0.98,
        });
        for (const w of res.warnings) ctx.log(`AVISO: ${w}`);
        return {
          beforePath: res.before_path ?? res.output_path,
          afterPath: res.output_path,
          device: res.device,
          ms: Date.now() - t0,
          ...(res.warnings.length > 0 && { warnings: res.warnings }),
        };
      } catch (err) {
        throw withJobResult(err);
      }
    },
  };
}

/** Clip after the swap: new asset in [0, len], `faceSwap.prev` keeps what it had (undo). */
export function swappedClip(
  clip: Clip,
  o: {
    assetId: string;
    length: number;
    personId: string;
    consentId: string;
    jobId: string;
    /** project.publish.flags.aiFace before the swap (restored by undo). */
    prevAiFace?: boolean;
  },
): { clip: Clip; droppedMatte: boolean } {
  const maskIsAsset = clip.maskRef?.type === "asset";
  const prev = {
    assetId: clip.assetId!,
    in: clip.in,
    out: clip.out,
    ...(clip.matte && { matte: clip.matte }),
    ...(maskIsAsset && clip.maskRef && { maskRef: clip.maskRef }),
  };
  const next: Clip = {
    ...clip,
    assetId: o.assetId,
    in: 0,
    out: round3(o.length),
    faceSwap: {
      prev,
      personId: o.personId,
      consentId: o.consentId,
      jobId: o.jobId,
      ...(o.prevAiFace !== undefined && { prevAiFace: o.prevAiFace }),
    },
  };
  delete next.matte;
  if (maskIsAsset) delete next.maskRef;
  return { clip: next, droppedMatte: !!clip.matte || maskIsAsset };
}

/** «Deshacer cambio de cara»: back to `faceSwap.prev` (the generated asset stays in Medios). */
export function restoreClip(clip: Clip): Clip {
  const fs = clip.faceSwap;
  if (!fs) return clip;
  const next: Clip = { ...clip, assetId: fs.prev.assetId, in: fs.prev.in, out: fs.prev.out };
  delete next.faceSwap;
  if (fs.prev.matte) next.matte = fs.prev.matte;
  if (fs.prev.maskRef) next.maskRef = fs.prev.maskRef;
  return next;
}

/** face.swap: the processed range becomes a new video asset (aiAltered) and, with `target`, the clip shows it. */
export function createFaceSwapHandler(
  deps: FaceDeps,
  o: FaceHandlerOptions = {},
): JobHandler<FaceSwapJobPayload, FaceSwapResult> {
  return {
    type: "face.swap",
    parse: (p) => FaceSwapJobPayloadSchema.parse(p),
    async run(req, ctx, job) {
      try {
        const pre = await runPreflight(deps, req, "swap");
        const range = pre.range!;
        deps.gate.audit({
          action: "face.swap",
          personId: pre.person.id,
          consentId: pre.consent.id,
          jobId: job.id,
          assetId: pre.asset.id,
          data: { range, model: req.options.model, ...(req.target && { target: req.target }) },
        });
        ctx.reportProgress(0.02, "Preparando el cambio de cara (FaceFusion)");
        const outputBase = `renders/face/${job.id}/`;
        const { task_id } = await deps.face.swap({
          source_paths: pre.photos,
          target_path: pre.asset.path,
          output_base: outputBase,
          range: [range.start, range.end],
          selector: workerSelector(req.selector),
          model: req.options.model,
          enhancer: req.options.enhancer,
          enhancer_blend: req.options.enhancerBlend,
          strength: req.options.strength,
          consent_id: pre.consent.id,
          licence_ids: [FACE_LICENCE],
        });
        ctx.log(
          `Tarea de cambio de cara ${task_id} (${range.start}–${range.end} s, ${req.options.model})`,
        );
        const res = await pollFaceTask(deps, task_id, ctx, {
          ...o,
          label: "Cambiando la cara",
          from: 0.04,
          to: 0.93,
        });
        const warnings = [...res.warnings];
        for (const w of warnings) ctx.log(`AVISO: ${w}`);
        ctx.reportProgress(0.95, "Registrando el video con la cara cambiada");
        const length = range.end - range.start;
        const info = await stat(resolveStoragePath(deps.config.storageDir, res.output_path));
        const now = new Date().toISOString();
        const asset = deps.repos.media.insert(
          MediaAssetSchema.parse({
            id: nanoid(),
            kind: "video",
            name: `${pre.asset.name} (cara cambiada con IA)`.slice(0, 200),
            path: res.output_path,
            mimeType: "video/mp4",
            sizeBytes: info.size,
            durationSec: round3(length),
            ...(pre.asset.width &&
              pre.asset.height && { width: pre.asset.width, height: pre.asset.height }),
            ...((res.fps || pre.asset.fps) && { fps: res.fps || pre.asset.fps }),
            hasVideo: true,
            ...(pre.asset.hasAudio !== undefined && { hasAudio: pre.asset.hasAudio }),
            videoCodec: "h264",
            aiAltered: true,
            aiProvenance: {
              kind: "face",
              tool: toolLabel(res.model || req.options.model),
              personId: pre.person.id,
              consentId: pre.consent.id,
              licences: [FACE_LICENCE],
              jobId: job.id,
              sourceAssetId: pre.asset.id,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
        if (deps.queue.hasHandler("media.probe"))
          deps.queue.enqueue({ type: "media.probe", payload: { assetId: asset.id }, priority: 1 });
        if (deps.queue.hasHandler("media.proxy"))
          deps.queue.enqueue({ type: "media.proxy", payload: { assetId: asset.id } });
        deps.gate.audit({
          action: "face.swap.done",
          personId: pre.person.id,
          consentId: pre.consent.id,
          jobId: job.id,
          assetId: asset.id,
          data: { frames: res.frames, device: res.device },
        });
        let clipId: string | undefined;
        if (req.target) {
          // Re-read: the project may have been edited while FaceFusion ran.
          const current = deps.repos.projects.get(req.target.projectId);
          const found = current && findClip(current, req.target.clipId);
          if (!current || !found || found.clip.assetId !== pre.asset.id) {
            warnings.push("source_clip_missing");
            ctx.log("El clip ya no está (o cambió de medio): el video queda solo en Medios");
          } else {
            const edit = swappedClip(found.clip, {
              assetId: asset.id,
              length,
              personId: pre.person.id,
              consentId: pre.consent.id,
              jobId: job.id,
              prevAiFace: current.publish?.flags.aiFace ?? false,
            });
            if (edit.droppedMatte) {
              warnings.push("matte_removed");
              ctx.log("AVISO: el recorte de fondo/máscara se quitó: volvé a recortar el fondo");
            }
            const publish = current.publish ?? {
              forSocial: false,
              aiLabel: false,
              flags: {
                aiFace: false,
                aiVoice: false,
                aiOther: false,
                music: false,
                thirdParty: false,
              },
            };
            const project: Project = {
              ...current,
              tracks: current.tracks.map((t) => ({
                ...t,
                clips: t.clips.map((c) => (c.id === edit.clip.id ? edit.clip : c)),
              })),
              publish: { ...publish, flags: { ...publish.flags, aiFace: true } },
            };
            if (!deps.repos.projects.save(current.id, project))
              throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
            clipId = edit.clip.id;
          }
        }
        return {
          assetId: asset.id,
          path: asset.path,
          frames: res.frames,
          fps: res.fps,
          device: res.device,
          model: res.model || req.options.model,
          consentId: pre.consent.id,
          licences: [FACE_LICENCE],
          ...(clipId && { clipId }),
          ...(warnings.length > 0 && { warnings }),
        };
      } catch (err) {
        throw withJobResult(err);
      }
    },
  };
}

export function faceDeps(ctx: AppContext): FaceDeps {
  return {
    config: ctx.config,
    repos: ctx.repos,
    queue: ctx.queue,
    workers: ctx.workers,
    gate: createConsentGate(ctx.db, ctx.config.storageDir),
    face: createFaceWorkers(ctx.config.workersUrl),
  };
}

export function registerFaceHandlers(deps: FaceDeps, o: FaceHandlerOptions = {}): void {
  deps.queue
    .register(createFacePreviewHandler(deps, o) as JobHandler)
    .register(createFaceSwapHandler(deps, o) as JobHandler);
}
