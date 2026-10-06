import { readFile, writeFile } from "node:fs/promises";
import {
  StyleAnalysisSchema,
  StyleAnalyzeRequestSchema,
  StyleInferRequestSchema,
  validateStylePreset,
  type MediaAsset,
  type StyleAnalysis,
  type StyleAnalyzeJobResult,
  type StyleInferJobResult,
} from "@studio/shared";
import type { z } from "zod";
import type { AppContext } from "../../context.js";
import { PackRequiredError } from "../../lib/errors.js";
import { resolveStoragePath } from "../../services/storage.js";
import {
  createStyleWorkers,
  type StyleTask,
  type StyleWorkers,
} from "../../services/style/workers.js";
import { registerFileAsset } from "../../services/vision-assets.js";
import { WorkersError } from "../../services/workers-client.js";
import { JobAbortedError } from "../state.js";
import type { JobContext, JobHandler } from "../types.js";

/**
 * Sprint 3b «Perfil de estilo» jobs (docs/trabajo/sprint3b-contratos.md, B):
 * - style.analyze: workers /style/analyze (task) -> analysis.json + contact sheet under
 *   renders/style/<jobId>/ -> MediaAsset kind "analysis" (thumbnail = contact sheet, /files).
 * - style.infer: workers /style/infer (Ollama qwen2.5vl:3b, pack vision-llm) -> StylePreset draft
 *   (validated with zod); PACK_REQUIRED keeps the workers' text ("… o usá la Consola Claude").
 */

export interface StyleHandlerOptions {
  /** Replaces the HTTP client (tests). */
  workers?: StyleWorkers;
  pollMs?: number;
  timeoutMs?: number;
}

type AnalyzePayload = z.infer<typeof StyleAnalyzeRequestSchema>;
type InferPayload = z.infer<typeof StyleInferRequestSchema>;

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

/** A workers PACK_REQUIRED keeps its Spanish detail (vision-llm: "… o usá la Consola Claude"). */
export function stylePackRequired(err: WorkersError): PackRequiredError {
  const p = err.packRequired!;
  const out = new PackRequiredError(p.packId, p.name_es, p.size_bytes);
  if (err.message) out.message = err.message;
  return out;
}

/** Segments of the newest successful transcription of `assetId` (speech ratio + excerpt). */
export function latestTranscript(
  app: Pick<AppContext, "jobs">,
  assetId: string,
): { start: number; end: number; text: string }[] | undefined {
  const job = app.jobs
    .list({ type: "subtitles.transcribe", status: "succeeded", limit: 500 })
    .find((j) => (j.payload as { assetId?: string } | undefined)?.assetId === assetId);
  const segs = (job?.result as { transcript?: { segments?: unknown[] } } | undefined)?.transcript
    ?.segments;
  if (!Array.isArray(segs) || !segs.length) return undefined;
  return segs
    .map((s) => s as { start?: unknown; end?: unknown; text?: unknown })
    .filter((s) => typeof s.start === "number" && typeof s.end === "number")
    .slice(0, 400)
    .map((s) => ({ start: s.start as number, end: s.end as number, text: String(s.text ?? "") }));
}

/** Parsed analysis.json of an asset kind "analysis". */
export async function readAnalysis(storageDir: string, asset: MediaAsset): Promise<StyleAnalysis> {
  const raw = JSON.parse(await readFile(resolveStoragePath(storageDir, asset.path), "utf8"));
  return StyleAnalysisSchema.parse(raw);
}

export function requireAnalysisAsset(app: Pick<AppContext, "repos">, id: string): MediaAsset {
  const asset = app.repos.media.get(id);
  if (!asset || asset.kind !== "analysis") throw new Error(`Análisis ${id} no encontrado`);
  return asset;
}

export function createStyleAnalyzeHandler(
  app: AppContext,
  o: StyleHandlerOptions = {},
): JobHandler<AnalyzePayload, StyleAnalyzeJobResult> {
  const sw = o.workers ?? createStyleWorkers(app.config.workersUrl);
  const pollMs = o.pollMs ?? 500;
  const timeoutMs = o.timeoutMs ?? 30 * 60_000;
  return {
    type: "style.analyze",
    parse: (p) => StyleAnalyzeRequestSchema.parse(p),
    async run(payload, ctx: JobContext, job) {
      const asset = app.repos.media.get(payload.assetId);
      if (!asset) throw new Error(`Asset ${payload.assetId} no encontrado`);
      if (asset.kind !== "video") throw new Error("El perfil de estilo analiza un video");
      const outRel = `renders/style/${job.id}`;
      const transcript = latestTranscript(app, asset.id);
      ctx.reportProgress(0.01, "Enviando el video al análisis");
      let accepted: { task_id: string };
      try {
        accepted = await sw.analyze({
          path: asset.path,
          output_dir: outRel,
          max_frames: 24,
          ...(payload.ocr !== undefined && { ocr: payload.ocr }),
          ...(transcript && { transcript }),
        });
      } catch (err) {
        if (err instanceof WorkersError && err.packRequired) throw stylePackRequired(err);
        throw err;
      }
      ctx.log(
        `workers /style/analyze task ${accepted.task_id}${transcript ? " (+ transcripción)" : ""}`,
      );
      const t0 = Date.now();
      let task: StyleTask;
      let failures = 0;
      for (;;) {
        try {
          task = await sw.task(accepted.task_id, ctx.signal);
          failures = 0;
          if (task.status === "running" || task.status === "queued")
            ctx.reportProgress(
              Math.min(0.97, Math.max(0.02, task.progress)),
              task.message ?? "Analizando la referencia",
            );
          if (task.status === "done" || task.status === "error") break;
        } catch (err) {
          if (ctx.signal.aborted) throw new JobAbortedError();
          if (err instanceof WorkersError && err.statusCode === 404)
            throw new Error("Los workers se reiniciaron y perdieron el análisis: probá de nuevo");
          if (++failures >= 10) throw err;
        }
        if (Date.now() - t0 > timeoutMs) throw new Error("El análisis no terminó a tiempo");
        await sleep(pollMs, ctx.signal);
      }
      if (task.status === "error") throw new Error(`Análisis falló: ${task.error ?? "error"}`);
      const result = task.result as { analysis_path?: string } | undefined;
      const analysisRel = result?.analysis_path ?? `${outRel}/analysis.json`;
      const abs = resolveStoragePath(app.config.storageDir, analysisRel);
      const raw = JSON.parse(await readFile(abs, "utf8")) as Record<string, unknown>;
      raw.source_asset_id = asset.id;
      await writeFile(abs, `${JSON.stringify(raw, null, 1)}\n`, "utf8");
      const analysis = StyleAnalysisSchema.parse(raw);
      const registered = await registerFileAsset(app, {
        kind: "analysis",
        path: analysisRel,
        name: `Perfil de estilo · ${asset.name}`,
        mimeType: "application/json",
        durationSec: analysis.duration_s,
        width: analysis.canvas.w,
        height: analysis.canvas.h,
      });
      app.repos.media.update(registered.id, { thumbnailPath: analysis.contact_sheet_path });
      ctx.reportProgress(1, "Análisis listo");
      return {
        analysisId: registered.id,
        path: analysisRel,
        contactSheetPath: analysis.contact_sheet_path,
        analysis,
      };
    },
  };
}

export function createStyleInferHandler(
  app: AppContext,
  o: StyleHandlerOptions = {},
): JobHandler<InferPayload, StyleInferJobResult> {
  const sw = o.workers ?? createStyleWorkers(app.config.workersUrl);
  return {
    type: "style.infer",
    parse: (p) => StyleInferRequestSchema.parse(p),
    async run(payload, ctx) {
      const asset = requireAnalysisAsset(app, payload.analysisId);
      const analysis = await readAnalysis(app.config.storageDir, asset);
      ctx.reportProgress(0.05, "El modelo de visión local está mirando la hoja de contactos");
      let res;
      try {
        res = await sw.infer(
          {
            analysis_path: asset.path,
            contact_sheet_path: analysis.contact_sheet_path,
            ...(payload.model && { model: payload.model }),
          },
          ctx.signal,
        );
      } catch (err) {
        if (ctx.signal.aborted) throw new JobAbortedError();
        if (err instanceof WorkersError && err.packRequired) throw stylePackRequired(err);
        throw err;
      }
      const v = validateStylePreset(res.preset);
      if (!v.ok)
        throw new Error(
          `El modelo devolvió un perfil inválido (${v.errors.slice(0, 3).join("; ")}): probá de nuevo o usá la Consola Claude`,
        );
      ctx.log(
        `style.infer: ${res.model ?? "?"} en ${res.latency_ms} ms, ${res.attempts} intento(s)`,
      );
      return {
        analysisId: asset.id,
        preset: v.preset,
        model: res.model ?? null,
        latency_ms: res.latency_ms,
        warnings: res.warnings,
      };
    },
  };
}

export function registerStyleHandlers(app: AppContext, o: StyleHandlerOptions = {}): void {
  app.queue.register(createStyleAnalyzeHandler(app, o));
  app.queue.register(createStyleInferHandler(app, o));
}
