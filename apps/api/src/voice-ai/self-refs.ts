import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { VOICE_SAMPLE_LIMITS, type MediaAsset } from "@studio/shared";
import type { FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import type { AppContext } from "../context.js";
import { HttpError, sprint4Error } from "../lib/errors.js";
import { safeInputArgs, sniffAudio } from "../services/audio-upload.js";
import { resolveStoragePath } from "../services/storage.js";
import { registerAudioAsset } from "./media-bridge.js";

/**
 * Sprint 4 M2 «Voz propia» (docs/trabajo/sprint4-contratos.md «M2»): the user's own voice sample,
 * a MediaAsset of kind "voice-ref" (WAV 24 kHz mono, edges without silence, loudness normalized,
 * at most 30 s kept). The upload must say `attestSelf=true` («Soy yo: es mi propia voz»); no
 * consent record is needed for one's own voice (decision D9), but the route is HUMAN_ONLY and the
 * declaration is audited (`voice.self.attest` with the sample's sha256, audit fix 1). Deleted with
 * DELETE /api/media/:id.
 */

const FILE_TOO_LARGE = "FST_REQ_FILE_TOO_LARGE";
const EDGE_TRIM = "silenceremove=start_periods=1:start_duration=0.1:start_threshold=-45dB";

export type SelfRefDeps = Pick<AppContext, "config" | "repos" | "queue" | "ffmpeg">;

export interface SelfRefUpload {
  data: Buffer;
  filename: string;
  attestSelf: string | undefined;
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Multipart `audio` (or `file`) + field `attestSelf`, in any order; ≤ 25 MB. */
export async function readSelfRefUpload(req: FastifyRequest): Promise<SelfRefUpload> {
  if (!req.isMultipart())
    throw new HttpError(400, "BAD_REQUEST", "Mandá la muestra como multipart (campo «audio»)");
  let data: Buffer | undefined;
  let filename = "voz";
  let attestSelf: string | undefined;
  try {
    for await (const part of req.parts({ limits: { fileSize: VOICE_SAMPLE_LIMITS.maxBytes } })) {
      if (part.type === "file") {
        if ((part.fieldname === "audio" || part.fieldname === "file") && !data) {
          data = await part.toBuffer();
          filename = part.filename || filename;
        } else {
          await part.toBuffer(); // drain anything else
        }
      } else if (part.fieldname === "attestSelf") {
        attestSelf = String(part.value);
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === FILE_TOO_LARGE)
      throw new HttpError(
        413,
        "FILE_TOO_LARGE",
        `La muestra de voz supera ${mb(VOICE_SAMPLE_LIMITS.maxBytes)}`,
      );
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "BAD_REQUEST", `No se pudo leer la muestra de voz: ${String(err)}`);
  }
  if (!data?.length)
    throw new HttpError(400, "BAD_REQUEST", "Falta la muestra de voz (campo «audio»)");
  return { data, filename, attestSelf };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Decode → check 5–60 s with audio → normalize (≤ 30 s) → `voice-ref` asset. Decoding first makes
 * the duration reliable for MediaRecorder WebM/Opus files, which often carry no duration.
 */
export async function createSelfVoiceRef(
  deps: SelfRefDeps,
  upload: SelfRefUpload,
): Promise<MediaAsset & { sha256: string; uploadSha256: string }> {
  if (upload.attestSelf !== "true")
    throw new HttpError(
      400,
      "ATTEST_SELF_REQUIRED",
      "Marcá «Soy yo: es mi propia voz» para guardar la muestra (para otra persona usá Ajustes → Personas).",
    );
  const storage = deps.config.storageDir;
  const id = nanoid();
  const tmpRel = `tmp/self-ref-${id}`;
  const tmpDir = resolveStoragePath(storage, tmpRel);
  // Audit fix 20: demuxer from the real type (magic bytes), not from the client's file name.
  const type = sniffAudio(upload.data);
  if (!type)
    throw sprint4Error("VOICE_SAMPLE_INVALID", {}, { reason: "formato de audio no reconocido" });
  const input = path.join(tmpDir, `input.${type.ext}`);
  const decoded = path.join(tmpDir, "decoded.wav");
  const rel = `media/${id}.wav`;
  const out = resolveStoragePath(storage, rel);
  const invalid = (reason: string) =>
    sprint4Error("VOICE_SAMPLE_INVALID", {}, { reason: reason.slice(0, 300) });
  await mkdir(tmpDir, { recursive: true });
  try {
    await writeFile(input, upload.data);
    try {
      await deps.ffmpeg.run([
        ...safeInputArgs(type),
        "-i",
        input,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(VOICE_SAMPLE_LIMITS.sampleRate),
        "-t",
        String(VOICE_SAMPLE_LIMITS.maxSec + 1),
        "-c:a",
        "pcm_s16le",
        decoded,
      ]);
    } catch (err) {
      throw invalid(`no se pudo decodificar: ${String(err)}`);
    }
    const src = await deps.ffmpeg.probe(decoded).catch(() => undefined);
    const dur = src?.durationSec ?? 0;
    if (
      !src?.hasAudio ||
      dur < VOICE_SAMPLE_LIMITS.minSec ||
      dur > VOICE_SAMPLE_LIMITS.maxSec + 0.05
    )
      throw invalid(`duración ${dur.toFixed(1)} s`);
    await mkdir(path.dirname(out), { recursive: true });
    await deps.ffmpeg.run([
      "-i",
      decoded,
      "-af",
      `${EDGE_TRIM},areverse,${EDGE_TRIM},areverse,loudnorm=I=-20:TP=-2:LRA=11`,
      "-ar",
      String(VOICE_SAMPLE_LIMITS.sampleRate),
      "-ac",
      "1",
      "-t",
      String(VOICE_SAMPLE_LIMITS.keepSec),
      "-c:a",
      "pcm_s16le",
      out,
    ]);
    const norm = await deps.ffmpeg.probe(out).catch(() => undefined);
    const kept = norm?.durationSec ?? 0;
    if (kept < VOICE_SAMPLE_LIMITS.minSec) {
      await rm(out, { force: true });
      throw invalid(`sin voz suficiente (${kept.toFixed(1)} s útiles)`);
    }
    const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const asset = await registerAudioAsset(deps, {
      id,
      path: rel,
      name: `Voz propia (${stamp()})`,
      kind: "voice-ref",
      durationSec: Math.round(kept * 100) / 100,
      sampleRate: VOICE_SAMPLE_LIMITS.sampleRate,
      channels: 1,
      mimeType: "audio/wav",
    });
    return { ...asset, sha256: digest(await readFile(out)), uploadSha256: digest(upload.data) };
  } catch (err) {
    await rm(out, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** «Voz propia» samples, newest first. */
export function listSelfVoiceRefs(deps: Pick<AppContext, "repos">): MediaAsset[] {
  return deps.repos.media.list({ kind: "voice-ref", limit: 50 });
}
