import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_EVAL_RESULT_PATH,
  AgentApplyPayloadSchema,
  AgentEvalRequestSchema,
  CAPTION_STYLE_PRESETS,
  CreateReportRequestSchema,
  FEATURE_PACKS,
  MotionSpecSchema,
  PACK_REQUIRED,
  reframeWindow,
  VOICE_EFFECT_PRESETS,
  type AgentApplyPayload,
  type AgentApplyResult,
  type AgentEvalRequest,
  type AgentPlanRecord,
  type CaptionStyle,
  type Clip,
  type ClipKeyframes,
  type EditOp,
  type Job,
  type JobType,
  type PackRequiredBody,
  type Project,
  type SubtitleSegment,
  type Track,
  type TrackKind,
} from "@studio/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "../../context.js";
import { HttpError, PackRequiredError } from "../../lib/errors.js";
import { LibraryIndex } from "../../library/index-db.js";
import { buildReport } from "../../reports/builder.js";
import { collectEnvironment } from "../../reports/environment.js";
import { resolveOp, canvasSize, type ResolveContext } from "../../services/agent/resolve.js";
import { clipDuration, clipEnd, round3 } from "../../services/agent/summary.js";
import { exportBlockersMessage, findExportBlockers } from "../../services/ffmpeg/timeline.js";
import { resolveStoragePath } from "../../services/storage.js";
import { applyCuts } from "../../services/timeline-edit.js";
import { registerAudioAsset } from "../../voice-ai/media-bridge.js";
import { isAbortError, JobAbortedError } from "../state.js";
import type { JobContext, JobHandler } from "../types.js";
import { requirePack, viaPacks } from "./ai.js";

/**
 * Sprint 3 job `agent.apply` (lane edit): run the confirmed ops of a stored AgentPlan in order on
 * the saved project. Pure timeline edits are done inline (and saved after each op); AI/render work
 * is delegated to the existing jobs (sub-jobs of other lanes, awaited with their progress mapped
 * to "op i/n: <preview_es>"). Stops at the first error ({index, error}); the project as it was
 * before is kept as an undo snapshot (POST /api/agent/plans/:id/undo).
 */

export interface AgentHandlerOptions {
  /** Sub-job polling interval (ms, default 200). */
  pollMs?: number;
  /** Default Piper voice for `tts` without `voice`. */
  defaultVoice?: string;
}

const DEFAULT_VOICE = "es_AR-daniela-high";
const EPS = 1e-3;

class OpError extends Error {
  constructor(
    message: string,
    readonly packRequired?: PackRequiredBody,
  ) {
    super(message);
    this.name = "OpError";
  }
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

function isPackBody(v: unknown): v is PackRequiredBody {
  return !!v && typeof v === "object" && (v as { error?: unknown }).error === PACK_REQUIRED;
}

interface Located {
  project: Project;
  track: Track;
  clip: Clip;
}

function locate(project: Project, clipId: string): Located {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { project, track, clip };
  }
  throw new OpError("El clip ya no existe en el proyecto");
}

function assertUnlocked(track: Track): void {
  if (track.locked) throw new OpError(`La pista «${track.name}» está bloqueada`);
}

const overlaps = (clips: readonly Clip[], a: number, b: number) =>
  clips.some((c) => c.start < b - EPS && clipEnd(c) > a + EPS);

/** First unlocked track of `kind` free in [a, b), or a new one appended to the project. */
function freeTrack(project: Project, kind: TrackKind, a: number, b: number): Track {
  const hit = project.tracks.find((t) => t.kind === kind && !t.locked && !overlaps(t.clips, a, b));
  if (hit) return hit;
  const n = project.tracks.filter((t) => t.kind === kind).length + 1;
  const name = { video: "Video", audio: "Audio", text: "Texto", motion: "Motion" }[kind];
  const track: Track = {
    id: nanoid(),
    kind,
    name: `${name} ${n}`,
    muted: false,
    locked: false,
    hidden: false,
    clips: [],
  };
  project.tracks.push(track);
  return track;
}

const baseClip = (trackId: string, start: number, dur: number): Clip => ({
  id: nanoid(),
  trackId,
  start: round3(start),
  in: 0,
  out: round3(dur),
  speed: 1,
  volume: 1,
  opacity: 1,
  voiceEffects: [],
});

function shiftKeyframes(k: ClipKeyframes | undefined, dt: number): ClipKeyframes | undefined {
  if (!k) return undefined;
  const out: ClipKeyframes = {};
  for (const key of ["position", "scale", "opacity", "crop"] as const) {
    const list = k[key];
    if (list) out[key] = list.map((f) => ({ ...f, t: round3(f.t - dt) })).filter((f) => f.t >= 0);
  }
  return out;
}

/** Split `clip` at timeline `t` (mutates the project); returns the new right piece. */
function splitAt(loc: Located, t: number): Clip {
  const { track, clip } = loc;
  assertUnlocked(track);
  if (clip.motion) throw new OpError("No se puede dividir un gráfico animado (motion)");
  if (t <= clip.start + 0.04 || t >= clipEnd(clip) - 0.04)
    throw new OpError(`El corte en ${t} s cae fuera del clip`);
  const speed = clip.speed || 1;
  const cut = round3(clip.in + (t - clip.start) * speed);
  const left: Clip = { ...clip, out: cut };
  delete left.transitionOut;
  const right: Clip = { ...clip, id: nanoid(), start: round3(t), in: cut };
  delete right.transitionIn;
  const kf = shiftKeyframes(clip.keyframes, t - clip.start);
  if (kf) right.keyframes = kf;
  track.clips = track.clips
    .map((c) => (c.id === clip.id ? left : c))
    .concat(right)
    .sort((a, b) => a.start - b.start);
  return right;
}

/** Whisper segments (asset seconds) -> timeline segments of `clip` (same as the web). */
export function transcriptToTimeline(
  segments: readonly SubtitleSegment[],
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
): SubtitleSegment[] {
  const speed = clip.speed || 1;
  const toTimeline = (t: number) => round3(clip.start + (t - clip.in) / speed);
  const end = clipEnd(clip);
  return segments
    .filter((s) => s.end > clip.in && s.start < clip.out)
    .map((s) => ({
      ...s,
      start: Math.max(clip.start, toTimeline(s.start)),
      end: Math.min(end, toTimeline(s.end)),
      ...(s.words && {
        words: s.words.map((w) => ({ ...w, start: toTimeline(w.start), end: toTimeline(w.end) })),
      }),
    }))
    .filter((s) => s.end > s.start);
}

const ANIMATION_STYLE: Record<CaptionStyle["animation"], string> = {
  none: "highlight",
  fade: "highlight",
  pop: "pop",
  karaoke: "karaoke",
};

/** `animated-captions` props from the subtitles in [a, b] (port of the web helper). */
export function animatedCaptionsProps(
  segments: readonly SubtitleSegment[],
  style: CaptionStyle,
): { props: Record<string, unknown>; start: number; durationSec: number } | undefined {
  if (segments.length === 0) return undefined;
  const start = Math.min(...segments.map((s) => s.start));
  const end = Math.max(...segments.map((s) => s.end));
  if (end <= start) return undefined;
  const shift = (t: number) => round3(Math.max(0, t - start));
  const words = (s: SubtitleSegment) => {
    if (s.words?.some((w) => w.word.trim())) return s.words;
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / Math.max(1, tokens.length);
    return tokens.map((t, i) => ({
      start: s.start + i * step,
      end: i === tokens.length - 1 ? s.end : s.start + (i + 1) * step,
      word: ` ${t}`,
    }));
  };
  return {
    start,
    durationSec: round3(end - start),
    props: {
      transcript: {
        language: "es",
        durationSec: round3(end - start),
        segments: segments.map((s) => ({
          start: shift(s.start),
          end: shift(s.end),
          text: s.text,
          words: words(s).map((w) => ({ ...w, start: shift(w.start), end: shift(w.end) })),
        })),
      },
      style: ANIMATION_STYLE[style.animation] ?? "highlight",
      position: style.position,
      fontSize: Math.min(300, Math.max(16, style.fontSize)),
      uppercase: style.uppercase,
      textColor: style.color,
      highlightColor: style.highlightColor,
      ...(style.background.trim() && { boxColor: style.background.trim() }),
    },
  };
}

interface Env {
  ctx: JobContext;
  projectId: string;
  /** Progress inside the current op (0..1) with an optional detail. */
  progress(p: number, detail?: string): void;
  load(): Project;
  save(project: Project): Project;
  subJob(type: JobType, payload: unknown, label: string): Promise<unknown>;
}

export function createAgentApplyHandler(
  app: AppContext,
  o: AgentHandlerOptions = {},
): JobHandler<AgentApplyPayload, AgentApplyResult> {
  const pollMs = o.pollMs ?? 200;
  const { repos, queue, jobs, workers } = app;

  async function subJob(
    env: Pick<Env, "ctx" | "progress" | "projectId">,
    type: JobType,
    payload: unknown,
    label: string,
    onJob: (id: string) => void,
  ) {
    if (!queue.hasHandler(type)) throw new OpError(`${label}: función no disponible en esta API`);
    let job: Job;
    try {
      job = queue.enqueue({ type, payload, projectId: env.projectId });
    } catch (err) {
      throw new OpError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    onJob(job.id);
    env.ctx.log(`Sub-trabajo ${type} ${job.id}`);
    for (;;) {
      if (env.ctx.signal.aborted) {
        queue.cancel(job.id);
        throw new JobAbortedError();
      }
      const j = jobs.get(job.id);
      if (!j) throw new OpError(`${label}: el trabajo desapareció`);
      if (j.status === "succeeded") return j.result;
      if (j.status === "failed")
        throw new OpError(
          `${label}: ${j.error ?? "falló"}`,
          isPackBody(j.result) ? j.result : undefined,
        );
      if (j.status === "canceled") throw new OpError(`${label}: cancelado`);
      if (j.status === "running") env.progress(j.progress, j.message ?? label);
      try {
        await sleep(pollMs, env.ctx.signal);
      } catch (err) {
        queue.cancel(job.id);
        throw err;
      }
    }
  }

  const resolveCtx = (project: Project): ResolveContext => ({
    project,
    media: (id) => repos.media.get(id),
    presets: repos.presets.list(),
    assets: repos.media.list({ limit: 500 }),
  });

  /** Clips an op without `clip` works on (computed again on the current project). */
  function targets(op: EditOp, project: Project): string[] {
    const clip = (op as { clip?: { id?: string } }).clip;
    if (clip?.id) return [clip.id];
    const media = (id?: string) => (id ? repos.media.get(id) : undefined);
    const withAudio = (c: Clip, t: Track) => {
      const a = media(c.assetId);
      return (
        (t.kind === "video" || t.kind === "audio") &&
        !!a &&
        a.kind !== "image" &&
        a.hasAudio !== false
      );
    };
    const filter =
      op.op === "detect_scenes"
        ? (c: Clip, t: Track) => t.kind === "video" && media(c.assetId)?.kind === "video"
        : withAudio;
    const all = project.tracks.flatMap((t) =>
      t.clips.filter((c) => filter(c, t)).map((c) => ({ c, t })),
    );
    const video = all.filter((x) => x.t.kind === "video");
    return (video.length ? video : all).sort((a, b) => a.c.start - b.c.start).map((x) => x.c.id);
  }

  async function transcribeClip(env: Env, clipId: string): Promise<number> {
    const { clip } = locate(env.load(), clipId);
    if (!clip.assetId) throw new OpError("El clip no tiene medio para transcribir");
    const res = (await env.subJob(
      "subtitles.transcribe",
      { assetId: clip.assetId, language: "es", wordTimestamps: true },
      "Transcribir",
    )) as { transcript?: { segments?: SubtitleSegment[] } };
    const project = env.load();
    const now = locate(project, clipId).clip;
    const mapped = transcriptToTimeline(res.transcript?.segments ?? [], now);
    const end = clipEnd(now);
    const kept = project.subtitles.filter((s) => s.end <= now.start + EPS || s.start >= end - EPS);
    project.subtitles = [...kept, ...mapped].sort((a, b) => a.start - b.start);
    env.save(project);
    return mapped.length;
  }

  async function placeAudio(
    env: Env,
    assetId: string,
    t: number,
    durationSec: number,
    extra: Partial<Clip> = {},
  ) {
    const project = env.load();
    const track = freeTrack(project, "audio", t, t + durationSec);
    const clip: Clip = { ...baseClip(track.id, t, durationSec), assetId, ...extra };
    track.clips.push(clip);
    track.clips.sort((a, b) => a.start - b.start);
    env.save(project);
    return clip;
  }

  async function execute(op: EditOp, env: Env): Promise<unknown> {
    switch (op.op) {
      case "split": {
        const project = env.load();
        const right = splitAt(locate(project, op.clip.id!), op.t as number);
        env.save(project);
        return { pieceIds: [op.clip.id, right.id] };
      }
      case "trim": {
        const project = env.load();
        const { track, clip } = locate(project, op.clip.id!);
        assertUnlocked(track);
        const speed = clip.speed || 1;
        const a = (op.in as number | undefined) ?? clip.start;
        const b = (op.out as number | undefined) ?? clipEnd(clip);
        const nin = round3(clip.in + (a - clip.start) * speed);
        const nout = round3(clip.in + (b - clip.start) * speed);
        if (nout - nin < 0.04) throw new OpError("El recorte deja el clip sin duración");
        if (clip.assetId && nin < -EPS)
          throw new OpError("No hay material antes del inicio del clip");
        const dur = clip.assetId ? repos.media.get(clip.assetId)?.durationSec : undefined;
        if (
          dur !== undefined &&
          repos.media.get(clip.assetId!)?.kind !== "image" &&
          nout > dur + 0.05
        )
          throw new OpError("No hay material después del final del clip");
        const kf = shiftKeyframes(clip.keyframes, a - clip.start);
        Object.assign(clip, {
          start: round3(a),
          in: Math.max(0, nin),
          out: nout,
          ...(kf && { keyframes: kf }),
        });
        if (clip.motion) {
          clip.in = 0;
          clip.out = round3(b - a);
        }
        env.save(project);
        return { clipId: clip.id, start: clip.start, end: round3(clipEnd(clip)) };
      }
      case "delete_clip": {
        const project = env.load();
        const { track, clip } = locate(project, op.clip.id!);
        assertUnlocked(track);
        track.clips = track.clips.filter((c) => c.id !== clip.id);
        env.save(project);
        return { deleted: clip.id };
      }
      case "set_speed": {
        const project = env.load();
        const { track, clip } = locate(project, op.clip.id!);
        assertUnlocked(track);
        const oldEnd = clipEnd(clip);
        clip.speed = op.speed;
        const delta = clipEnd(clip) - oldEnd;
        // Ripple the following clips of the same track (no gap, no overlap).
        for (const c of track.clips)
          if (c.id !== clip.id && c.start >= oldEnd - EPS)
            c.start = round3(Math.max(0, c.start + delta));
        env.save(project);
        return { clipId: clip.id, speed: op.speed };
      }
      case "add_text": {
        const project = env.load();
        const t = op.t as number;
        const dur = op.duration_s ?? 3;
        const track = freeTrack(project, "text", t, t + dur);
        const clip: Clip = {
          ...baseClip(track.id, t, dur),
          text: op.text,
          textStyle: {
            fontFamily: op.style?.font_family ?? "Inter",
            fontSize: op.style?.font_size ?? 64,
            color: op.style?.color ?? "#ffffff",
            ...(op.style?.background && { background: op.style.background }),
            position: op.position ?? "bottom",
          },
        };
        track.clips.push(clip);
        track.clips.sort((a, b) => a.start - b.start);
        env.save(project);
        return { clipId: clip.id, trackId: track.id };
      }
      case "set_canvas": {
        const project = env.load();
        const size = canvasSize(project, op.preset);
        project.settings = { ...project.settings, width: size.w, height: size.h };
        env.save(project);
        return { width: size.w, height: size.h };
      }
      case "set_publish": {
        const project = env.load();
        const cur = project.publish;
        const f = op.flags ?? {};
        const flags = {
          aiFace: f.ai_face ?? cur?.flags.aiFace ?? false,
          aiVoice: f.ai_voice ?? cur?.flags.aiVoice ?? false,
          aiOther: f.ai_other ?? cur?.flags.aiOther ?? false,
          music: f.music ?? cur?.flags.music ?? false,
          thirdParty: f.third_party ?? cur?.flags.thirdParty ?? false,
        };
        project.publish = {
          ...cur,
          forSocial: op.for_social,
          flags,
          aiLabel: op.ai_label ?? cur?.aiLabel ?? false,
        };
        env.save(project);
        return { publish: project.publish };
      }
      case "voice_effect": {
        const project = env.load();
        const { track, clip } = locate(project, op.clip.id!);
        assertUnlocked(track);
        const preset = VOICE_EFFECT_PRESETS.find((p) => p.id === op.effect);
        if (!preset) throw new OpError(`Efecto «${op.effect}» desconocido`);
        clip.voiceEffects = preset.effects.map((e) => ({ ...e }));
        env.save(project);
        return { clipId: clip.id, effects: clip.voiceEffects.length };
      }
      case "transcribe": {
        const ids = targets(op, env.load());
        let segments = 0;
        for (const [k, id] of ids.entries()) {
          env.progress(k / ids.length, `Transcribiendo clip ${k + 1}/${ids.length}`);
          segments += await transcribeClip(env, id);
        }
        return { clips: ids.length, segments };
      }
      case "add_captions": {
        const ids = targets(op, env.load());
        for (const [k, id] of ids.entries()) {
          const p = env.load();
          const { clip } = locate(p, id);
          const has = p.subtitles.some((s) => s.end > clip.start && s.start < clipEnd(clip));
          if (!has) {
            env.progress((k / ids.length) * 0.7, `Transcribiendo clip ${k + 1}/${ids.length}`);
            await transcribeClip(env, id);
          }
        }
        const style =
          CAPTION_STYLE_PRESETS.find((s) => s.id === (op.style ?? "clasico")) ??
          CAPTION_STYLE_PRESETS[0]!;
        const project = env.load();
        project.captionStyle = { ...style };
        if (!op.animated) {
          project.burnSubtitles = true;
          env.save(project);
          return { style: style.id, animated: false, segments: project.subtitles.length };
        }
        const spans = ids.map((id) => locate(project, id).clip);
        const segs = project.subtitles.filter((s) =>
          spans.some((c) => s.end > c.start && s.start < clipEnd(c)),
        );
        const built = animatedCaptionsProps(segs, style);
        if (!built) throw new OpError("No hay subtítulos para animar");
        const spec = MotionSpecSchema.parse({
          engine: "remotion",
          template: "animated-captions",
          props: built.props,
          durationSec: built.durationSec,
          fps: Math.round(project.settings.fps),
          width: project.settings.width,
          height: project.settings.height,
          format: "webm-vp9-alpha",
        });
        const track = freeTrack(project, "motion", built.start, built.start + built.durationSec);
        const clip: Clip = { ...baseClip(track.id, built.start, built.durationSec), motion: spec };
        track.clips.push(clip);
        project.burnSubtitles = false; // the animated clip already shows them
        env.save(project);
        env.progress(0.75, "Renderizando subtítulos animados");
        await env.subJob(
          "motion.render",
          { ...spec, target: { projectId: env.projectId, clipId: clip.id } },
          "Subtítulos animados",
        );
        return { style: style.id, animated: true, clipId: clip.id };
      }
      case "cut_silences": {
        const ids = targets(op, env.load());
        let removed = 0;
        for (const [k, id] of ids.entries()) {
          env.progress(k / ids.length, `Buscando silencios ${k + 1}/${ids.length}`);
          const res = (await env.subJob(
            "analyze.silences",
            {
              projectId: env.projectId,
              clipId: id,
              options: {
                minSilenceMs: op.min_silence_ms ?? 500,
                noiseDb: -35,
                paddingMs: op.padding_ms ?? 120,
                fillers: op.fillers ?? true,
              },
            },
            "Cortar silencios",
          )) as { cuts?: { start: number; end: number }[] };
          if (!res.cuts?.length) continue;
          const project = env.load();
          try {
            const out = applyCuts(project, id, res.cuts, () => nanoid());
            env.save(out.project);
            removed += out.removedSec;
          } catch (err) {
            if (err instanceof HttpError && err.code === "NO_CUTS") continue;
            throw new OpError(err instanceof Error ? err.message : String(err));
          }
        }
        return { clips: ids.length, removedSec: round3(removed) };
      }
      case "detect_scenes": {
        const ids = targets(op, env.load());
        await requirePack(workers, FEATURE_PACKS.scenes);
        const assets = [...new Set(ids.map((id) => locate(env.load(), id).clip.assetId!))];
        for (const [k, assetId] of assets.entries()) {
          env.progress(k / assets.length, `Detectando escenas ${k + 1}/${assets.length}`);
          await env.subJob("analyze.scenes", { assetId }, "Detectar escenas");
        }
        let pieces = 0;
        if (op.split) {
          const project = env.load();
          for (const id of ids) {
            const { clip } = locate(project, id);
            const scenes = repos.media.get(clip.assetId!)?.scenes ?? [];
            const speed = clip.speed || 1;
            const cuts = scenes
              .map((s) => round3(clip.start + (s.start - clip.in) / speed))
              .filter((t) => t > clip.start + 0.04 && t < clipEnd(clip) - 0.04)
              .sort((a, b) => a - b);
            let current = locate(project, id);
            for (const t of cuts) {
              const right = splitAt(current, t);
              pieces++;
              current = locate(project, right.id);
            }
          }
          env.save(project);
        }
        const scenes = assets.reduce((n, a) => n + (repos.media.get(a)?.scenes?.length ?? 0), 0);
        return { assets: assets.length, scenes, splits: pieces };
      }
      case "tts": {
        const res = (await env.subJob(
          "voice.tts",
          { text: op.text, voice: op.voice ?? o.defaultVoice ?? DEFAULT_VOICE, provider: "piper" },
          "Texto a voz",
        )) as { assetId: string; durationSec?: number };
        const dur = res.durationSec ?? repos.media.get(res.assetId)?.durationSec;
        if (!dur) throw new OpError("La voz generada no tiene duración");
        const effects = op.effect
          ? VOICE_EFFECT_PRESETS.find((p) => p.id === op.effect)?.effects
          : undefined;
        const clip = await placeAudio(env, res.assetId, op.t as number, dur, {
          out: round3(dur),
          ...(effects && { voiceEffects: effects.map((e) => ({ ...e })) }),
        });
        return { assetId: res.assetId, clipId: clip.id };
      }
      case "denoise": {
        const { clip, track } = locate(env.load(), op.clip.id!);
        assertUnlocked(track);
        const res = (await env.subJob(
          "audio.denoise",
          { assetId: clip.assetId },
          "Limpiar voz",
        )) as {
          assetId: string;
        };
        const project = env.load();
        const now = locate(project, clip.id);
        if (now.track.kind === "audio") {
          now.clip.assetId = res.assetId;
          env.save(project);
          return { assetId: res.assetId, clipId: now.clip.id };
        }
        now.clip.volume = 0;
        const t = freeTrack(project, "audio", now.clip.start, clipEnd(now.clip));
        const audio: Clip = {
          ...baseClip(t.id, now.clip.start, clipDuration(now.clip)),
          assetId: res.assetId,
          in: now.clip.in,
          out: now.clip.out,
          speed: now.clip.speed,
        };
        t.clips.push(audio);
        t.clips.sort((a, b) => a.start - b.start);
        env.save(project);
        return { assetId: res.assetId, clipId: audio.id, mutedVideoClip: now.clip.id };
      }
      case "add_audio": {
        let assetId = op.asset?.id;
        let dur = assetId ? repos.media.get(assetId)?.durationSec : undefined;
        if (!assetId) {
          const index = new LibraryIndex(app.db, app.config.storageDir, app.config.ffmpegPath);
          const found = await index.search({
            q: op.query ?? "",
            provider: "local",
            page: 1,
            pageSize: 10,
          });
          const item = found.items.find((i) => i.path);
          if (!item)
            throw new OpError(`No encontré audio para «${op.query}» en la biblioteca local`);
          const id = nanoid();
          const rel = `media/${id}${path.extname(item.path!).toLowerCase()}`;
          const dest = resolveStoragePath(app.config.storageDir, rel);
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(resolveStoragePath(app.config.storageDir, item.path!), dest);
          const asset = await registerAudioAsset(app, {
            id,
            path: rel,
            name: item.name,
            ...(item.durationSec !== undefined && { durationSec: item.durationSec }),
          });
          assetId = asset.id;
          dur = item.durationSec ?? asset.durationSec;
        }
        if (!dur) throw new OpError("No se conoce la duración del audio (esperá a que se analice)");
        const db = op.volume_db ?? (op.duck ? -12 : 0);
        const volume = Math.min(4, Math.max(0, Math.round(10 ** (db / 20) * 1000) / 1000));
        const clip = await placeAudio(env, assetId, op.t as number, dur, {
          volume,
          out: round3(dur),
        });
        return { assetId, clipId: clip.id, volume };
      }
      case "remove_background": {
        const { clip } = locate(env.load(), op.clip.id!);
        const image = repos.media.get(clip.assetId!)?.kind === "image";
        await requirePack(workers, image ? FEATURE_PACKS.mattingImage : FEATURE_PACKS.matting);
        const bg = op.background;
        const res = await env.subJob(
          "vision.matte",
          {
            assetId: clip.assetId,
            background: {
              type: bg.type,
              ...(bg.type === "color" && { value: bg.value ?? "#00ff00" }),
              ...((bg.type === "image" || bg.type === "video") && bg.value && { value: bg.value }),
              ...(bg.type === "blur" &&
                bg.value &&
                /^\d+(\.\d+)?$/.test(bg.value) && { value: bg.value }),
            },
            target: { projectId: env.projectId, clipId: clip.id },
          },
          "Quitar fondo",
        );
        return res;
      }
      case "reframe": {
        const subject = op.subject ?? "face";
        if (subject === "center") {
          const project = env.load();
          const w = reframeWindow(project.settings, op.target);
          project.reframe = {
            target: op.target,
            mode: "manual",
            keyframes: [
              { t: 0, ease: "linear", v: { x: (1 - w.w) / 2, y: (1 - w.h) / 2, w: w.w, h: w.h } },
            ],
          };
          env.save(project);
          return { target: op.target, subject };
        }
        await requirePack(workers, FEATURE_PACKS.reframe);
        await env.subJob(
          "vision.reframe",
          { projectId: env.projectId, target: op.target, subject: "face" },
          "Reencuadrar",
        );
        return { target: op.target, subject };
      }
      case "add_motion": {
        const templates = await app.motion.listTemplates().catch(() => []);
        const info = templates.find((t) => t.id === op.template);
        if (!info) throw new OpError(`Plantilla «${op.template}» no disponible`);
        const project = env.load();
        const t = op.t as number;
        const dur = op.duration_s ?? info.defaultDurationSec ?? 3;
        const spec = MotionSpecSchema.parse({
          engine: info.engine,
          template: info.id,
          props: { ...info.defaultProps, ...(op.params ?? {}) },
          durationSec: dur,
          fps: Math.round(project.settings.fps),
          width: project.settings.width,
          height: project.settings.height,
          format: "webm-vp9-alpha",
        });
        const track = freeTrack(project, "motion", t, t + dur);
        const clip: Clip = { ...baseClip(track.id, t, dur), motion: spec };
        if (op.follow && op.follow !== "face") {
          const src = locate(project, op.follow.id!).clip;
          if (src.trackRef) clip.trackRef = { ...src.trackRef };
          else env.ctx.log("El clip a seguir no tiene seguimiento: el gráfico queda fijo");
        }
        track.clips.push(clip);
        track.clips.sort((a, b) => a.start - b.start);
        env.save(project);
        await env.subJob(
          "motion.render",
          { ...spec, target: { projectId: env.projectId, clipId: clip.id } },
          "Render motion",
        );
        return { clipId: clip.id, template: info.id };
      }
      case "export": {
        const project = env.load();
        const blocked = exportBlockersMessage(
          findExportBlockers(project, (id) => !!repos.media.get(id)),
        );
        if (blocked) throw new OpError(blocked);
        return env.subJob(
          "project.export",
          {
            projectId: env.projectId,
            presetId: op.preset,
            ...(op.name && { fileName: op.name }),
            ...(op.burn_subtitles !== undefined && { burnSubtitles: op.burn_subtitles }),
          },
          "Exportar",
        );
      }
      case "report_bug": {
        const report = await buildReport(
          {
            config: app.config,
            jobs: app.jobs,
            repos,
            collectEnvironment: () =>
              collectEnvironment({ config: app.config, ffmpeg: app.ffmpeg, queue: app.queue }),
          },
          CreateReportRequestSchema.parse({
            title: op.title,
            steps: op.steps_es,
            projectId: env.projectId,
          }),
        );
        const md = await workers
          .agentBugreport(
            { title: op.title, steps_text: op.steps_es, breadcrumbs: [], errors: [], env: {} },
            env.ctx.signal,
          )
          .catch(() => undefined);
        if (md?.markdown_es) await appendToReport(app.config.storageDir, report.id, md.markdown_es);
        return { reportId: report.id, zipPath: report.zipPath };
      }
    }
  }

  return {
    type: "agent.apply",
    lane: "edit",
    parse: (p) => AgentApplyPayloadSchema.parse(p),
    async run(payload, ctx) {
      const record = repos.agentPlans.get(payload.planId);
      if (!record) throw new Error(`Plan ${payload.planId} no encontrado`);
      const initial = repos.projects.get(record.projectId);
      if (!initial) throw new Error("Proyecto no encontrado");
      const plan = record.plan;
      if (!plan) throw new Error("El plan no es válido");
      const indexes = payload.ops ?? plan.ops.map((_, i) => i);
      const undoSnapshotId = repos.agentPlans.snapshot(initial, record.id);
      repos.agentPlans.update(record.id, { undoSnapshotId });
      const steps: AgentApplyResult["steps"] = [];
      let failed: AgentApplyResult["failed"];
      const n = indexes.length;
      for (const [k, index] of indexes.entries()) {
        const preview = record.preview_es[index] ?? plan.ops[index]?.op ?? "?";
        const head = `op ${k + 1}/${n}: ${preview}`;
        const progress = (p: number, detail?: string) =>
          ctx.reportProgress(
            Math.min(0.99, (k + Math.max(0, Math.min(1, p))) / n),
            detail && detail !== preview ? `${head} · ${detail}` : head,
          );
        progress(0);
        const jobIds: string[] = [];
        const env: Env = {
          ctx,
          projectId: record.projectId,
          progress,
          load: () => {
            const p = repos.projects.get(record.projectId);
            if (!p) throw new OpError("El proyecto ya no existe");
            return structuredClone(p);
          },
          save: (p) => {
            const saved = repos.projects.save(record.projectId, p);
            if (!saved) throw new OpError("El proyecto ya no existe");
            return saved;
          },
          subJob: (type, body, label) =>
            subJob({ ctx, progress, projectId: record.projectId }, type, body, label, (id) =>
              jobIds.push(id),
            ),
        };
        try {
          const source = record.resolved[index] ?? plan.ops[index];
          if (!source) throw new OpError(`La operación ${index + 1} no existe en el plan`);
          const r = resolveOp(source, resolveCtx(env.load()));
          if (!r.op) throw new OpError(r.unresolved.join(" "));
          const result = await viaPacks(() => execute(r.op!, env));
          steps.push({
            index,
            preview_es: preview,
            jobIds,
            ...(result !== undefined && { result }),
          });
          ctx.log(`OK ${head}`);
        } catch (err) {
          if (isAbortError(err) || ctx.signal.aborted) throw err;
          const message = err instanceof Error ? err.message : String(err);
          const pack =
            err instanceof PackRequiredError
              ? err.body
              : err instanceof OpError
                ? err.packRequired
                : undefined;
          failed = { index, error: message, ...(pack && { packRequired: pack }) };
          ctx.log(`ERROR ${head}: ${message}`);
          break;
        }
      }
      const result: AgentApplyResult = {
        applied: steps.length,
        ...(failed && { failed }),
        undoSnapshotId,
        steps,
      };
      const patch: Partial<AgentPlanRecord> = { applyResult: result, undoSnapshotId };
      if (steps.length > 0) patch.status = "applied";
      repos.agentPlans.update(record.id, patch);
      ctx.reportProgress(
        1,
        failed
          ? `Aplicadas ${steps.length}/${n}; falló la operación ${failed.index + 1}: ${failed.error}`
          : `Aplicadas ${steps.length}/${n} operaciones`,
      );
      return result;
    },
  };
}

/** Append the assistant's markdown to storage/reports/<id>/reporte.md (error reports channel). */
export async function appendToReport(
  storageDir: string,
  reportId: string,
  markdown: string,
): Promise<boolean> {
  if (!/^[\w-]{1,120}$/.test(reportId)) return false;
  const file = path.join(storageDir, "reports", reportId, "reporte.md");
  try {
    await stat(file);
  } catch {
    return false;
  }
  const current = await readFile(file, "utf8");
  await writeFile(
    file,
    `${current.trimEnd()}\n\n## Redactado por el asistente local\n\n${markdown.trim()}\n`,
    "utf8",
  );
  return true;
}

/** Last agent eval result (storage/run/agent-eval.json) or undefined. */
export async function readAgentEval(storageDir: string): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(resolveStoragePath(storageDir, AGENT_EVAL_RESULT_PATH), "utf8"),
    );
  } catch {
    return undefined;
  }
}

/** agent.eval: POST /agent/eval, then wait for storage/run/agent-eval.json to change. */
export function createAgentEvalHandler(
  app: AppContext,
  o: { pollMs?: number; timeoutMs?: number } = {},
): JobHandler<AgentEvalRequest, unknown> {
  const mtime = () =>
    stat(resolveStoragePath(app.config.storageDir, AGENT_EVAL_RESULT_PATH))
      .then((s) => s.mtimeMs)
      .catch(() => 0);
  return {
    type: "agent.eval",
    parse: (p) => AgentEvalRequestSchema.parse(p ?? {}),
    async run(req, ctx) {
      const before = await mtime();
      ctx.reportProgress(0.02, "Evaluando modelos del asistente");
      const { task_id } = await viaPacks(() =>
        app.workers.agentEval({ dataset: req.dataset, ...(req.models && { models: req.models }) }),
      );
      ctx.log(`Tarea de evaluación ${task_id}`);
      const t0 = Date.now();
      const timeout = o.timeoutMs ?? 4 * 3600_000;
      while ((await mtime()) <= before) {
        if (Date.now() - t0 > timeout) throw new Error("La evaluación no terminó a tiempo");
        ctx.reportProgress(0.5, "Evaluando modelos del asistente");
        await sleep(o.pollMs ?? 1000, ctx.signal);
      }
      const result = await readAgentEval(app.config.storageDir);
      if (!result)
        throw new Error("La evaluación terminó sin resultado (storage/run/agent-eval.json)");
      return result;
    },
  };
}

export function registerAgentHandlers(app: AppContext, o: AgentHandlerOptions = {}): void {
  app.queue
    .register(createAgentApplyHandler(app, o) as JobHandler)
    .register(createAgentEvalHandler(app) as JobHandler);
}
