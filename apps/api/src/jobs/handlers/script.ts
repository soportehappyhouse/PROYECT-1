import { rm } from "node:fs/promises";
import {
  IdSchema,
  ScriptTranscribeRequestSchema,
  WorkerSttWordsResultSchema,
  type Clip,
  type Project,
  type SubtitleSegment,
} from "@studio/shared";
import type { z } from "zod";
import type { AppContext } from "../../context.js";
import { HttpError } from "../../lib/errors.js";
import { recordScriptAudio } from "../../services/script/store.js";
import { resolveStoragePath } from "../../services/storage.js";
import { extractSpeechWav } from "../../voice-ai/proc.js";
import type { JobHandler } from "../types.js";
import { pollWorkerTask, WorkerTaskError } from "./util.js";

/**
 * Sprint 6 M1 job `script.transcribe` (lane workers): 16 kHz mono WAV of the clip's asset ->
 * workers POST /transcribe/words (no VAD, word timestamps, RMS envelope + gaps) -> poll
 * /transcribe/tasks/{id} (progress in seconds, cancel goes to the worker) -> the words, mapped to
 * the timeline through the clip, replace `project.subtitles` inside the clip's span (saved) and the
 * audio artifact is recorded in `script_audio`. The web applies `segments` from the result in one
 * undo step (it does not adopt the whole saved project, so a concurrent autosave cannot lose them).
 */

export const ScriptTranscribePayloadSchema = ScriptTranscribeRequestSchema.extend({
  projectId: IdSchema,
});
export type ScriptTranscribePayload = z.infer<typeof ScriptTranscribePayloadSchema>;

export interface ScriptTranscribeResult {
  projectId: string;
  clipId: string;
  assetId: string;
  /** Timeline span whose subtitles were replaced. */
  range: { start: number; end: number };
  /** New subtitles of that span (timeline seconds, with words). */
  segments: SubtitleSegment[];
  words: number;
  noise_floor_db: number;
  gaps: number;
  voiced_gaps: number;
  audioPath: string;
  warnings?: string[];
}

const clipEnd = (c: Pick<Clip, "start" | "in" | "out" | "speed">) =>
  c.start + Math.max(0, (c.out - c.in) / (c.speed || 1));
const round = (t: number) => Math.round(t * 1e6) / 1e6;

/** Transcript segments (source seconds) -> timeline segments of `clip` (outside the clip dropped). */
export function segmentsToTimeline(
  segments: readonly SubtitleSegment[],
  clip: Pick<Clip, "start" | "in" | "out" | "speed">,
): SubtitleSegment[] {
  const speed = clip.speed || 1;
  const map = (t: number) => round(clip.start + (t - clip.in) / speed);
  const end = clipEnd(clip);
  return segments
    .filter((s) => s.end > clip.in && s.start < clip.out)
    .map((s) => {
      const words = s.words
        ?.filter((w) => (w.start + w.end) / 2 >= clip.in && (w.start + w.end) / 2 <= clip.out)
        .map((w) => ({ ...w, start: map(w.start), end: map(w.end) }));
      return {
        ...s,
        start: Math.max(clip.start, map(s.start)),
        end: Math.min(round(end), map(s.end)),
        ...(words && { words }),
      };
    })
    .filter((s) => s.end > s.start);
}

/** Replace the subtitles inside [start, end) by `segments` (others kept), sorted. */
export function replaceSubtitlesInRange(
  subtitles: readonly SubtitleSegment[],
  range: { start: number; end: number },
  segments: readonly SubtitleSegment[],
): SubtitleSegment[] {
  const kept = subtitles.filter((s) => s.end <= range.start + 1e-6 || s.start >= range.end - 1e-6);
  return [...kept, ...segments].sort((a, b) => a.start - b.start);
}

function findClip(project: Project, clipId: string): Clip {
  for (const t of project.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  throw new HttpError(404, "NOT_FOUND", "El clip ya no está en el proyecto");
}

interface WorkersErrorBody {
  detail?: unknown;
  code?: string;
}

/** POST /transcribe/words on the workers -> task id (Spanish error with its code otherwise). */
async function submitWords(
  workersUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${workersUrl.replace(/\/$/, "")}/transcribe/words`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new HttpError(
      503,
      "WORKERS_UNAVAILABLE",
      "La IA local no responde: abrí Studio con scripts\\windows\\start.cmd y probá de nuevo.",
    );
  }
  const json = (await res.json().catch(() => ({}))) as WorkersErrorBody & { task_id?: string };
  if (!res.ok || typeof json.task_id !== "string") {
    const detail = typeof json.detail === "string" ? json.detail : `HTTP ${res.status}`;
    throw new HttpError(res.status >= 400 ? res.status : 502, json.code ?? "WORKERS_ERROR", detail);
  }
  return json.task_id;
}

export function createScriptTranscribeHandler(
  app: Pick<AppContext, "config" | "repos" | "workers" | "db">,
): JobHandler<ScriptTranscribePayload, ScriptTranscribeResult> {
  return {
    type: "script.transcribe",
    parse: (payload) => ScriptTranscribePayloadSchema.parse(payload),
    async run(payload, ctx, job) {
      const project = app.repos.projects.get(payload.projectId);
      if (!project) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
      const clip = findClip(project, payload.clipId);
      if (!clip.assetId) throw new HttpError(400, "BAD_REQUEST", "El clip no tiene audio");
      const asset = app.repos.media.get(clip.assetId);
      if (!asset || (asset.kind !== "video" && asset.kind !== "audio") || asset.hasAudio === false)
        throw new HttpError(400, "BAD_REQUEST", "El clip no tiene audio para transcribir");
      const storage = app.config.storageDir;
      const wavRel = `tmp/${job.id}.wav`;
      const outputBase = `renders/${job.id}`;
      const seconds = Math.max(1, Math.round(clip.out - clip.in));
      ctx.reportProgress(0.02, "Extrayendo audio (16 kHz mono)", {
        stage_es: "Extrayendo audio (16 kHz mono)",
      });
      try {
        await extractSpeechWav(
          app.config.ffmpegPath,
          resolveStoragePath(storage, asset.path),
          resolveStoragePath(storage, wavRel),
          ctx.signal,
        );
        ctx.reportProgress(0.06, "Transcribiendo palabras", {
          stage_es: "Transcribiendo palabras",
          done: 0,
          total: seconds,
          unit: "seconds",
        });
        const taskId = await submitWords(
          app.config.workersUrl,
          {
            input_path: wavRel,
            language: payload.language,
            ...(payload.model && { model: payload.model }),
            job_id: job.id,
            clip_in_s: clip.in,
            clip_out_s: clip.out,
            output_base: outputBase,
          },
          ctx.signal,
        );
        let task;
        try {
          task = await pollWorkerTask(app.workers, "transcribe", taskId, ctx, {
            from: 0.06,
            to: 0.96,
            unit: "seconds",
          });
        } catch (err) {
          if (err instanceof WorkerTaskError)
            throw new HttpError(500, err.code ?? "WORKER_TASK_FAILED", err.message);
          throw err;
        }
        const result = WorkerSttWordsResultSchema.parse(task.result);
        ctx.reportProgress(0.97, "Guardando el guion", { stage_es: "Guardando el guion" });
        // Re-read the project: the user may have edited it while Whisper ran.
        const fresh = app.repos.projects.get(payload.projectId) ?? project;
        const now = (() => {
          try {
            return findClip(fresh, payload.clipId);
          } catch {
            return clip;
          }
        })();
        const segments = segmentsToTimeline(result.transcript.segments, now);
        const range = { start: now.start, end: round(clipEnd(now)) };
        const saved = app.repos.projects.save(payload.projectId, {
          ...fresh,
          subtitles: replaceSubtitlesInRange(fresh.subtitles, range, segments),
        });
        if (!saved) throw new HttpError(404, "NOT_FOUND", "Proyecto no encontrado");
        recordScriptAudio(app.db, {
          project_id: payload.projectId,
          asset_id: asset.id,
          clip_id: payload.clipId,
          job_id: job.id,
          path: `${outputBase}/script-audio.json`,
          noise_floor_db: result.audio.noise_floor_db,
        });
        const warnings = (task as { warnings?: unknown }).warnings;
        const words = segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
        ctx.log(`Guion: ${words} palabras, ${result.audio.gaps.length} huecos medidos`);
        return {
          projectId: payload.projectId,
          clipId: payload.clipId,
          assetId: asset.id,
          range,
          segments,
          words,
          noise_floor_db: result.audio.noise_floor_db,
          gaps: result.audio.gaps.length,
          voiced_gaps: result.audio.gaps.filter((g) => g.voiced).length,
          audioPath: `${outputBase}/script-audio.json`,
          ...(Array.isArray(warnings) && warnings.length && { warnings: warnings.map(String) }),
        };
      } finally {
        await rm(resolveStoragePath(storage, wavRel), { force: true });
      }
    },
  };
}
