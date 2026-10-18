import {
  SuggestAnalyzePayloadSchema,
  SUGGESTION_THRESHOLDS,
  WorkerSuggestAnalyzeResultSchema,
  type ImportAnalysis,
  type SuggestAnalyzePayload,
} from "@studio/shared";
import type { AppContext } from "../../context.js";
import { suggestionsService } from "../../services/suggestions/service.js";
import { createSuggestWorkers, type SuggestWorkers } from "../../services/suggestions/workers.js";
import type { JobHandler } from "../types.js";
import { checkAborted, pollWorkerTask, requireAsset } from "./util.js";

/** Result of the suggest.analyze job (the cards come from GET …/suggestions). */
export interface SuggestAnalyzeJobResult {
  assetId: string;
  cached: boolean;
  skipped?: "no_audio";
  analysis?: ImportAnalysis;
  projects: string[];
}

export interface SuggestHandlerOptions {
  workers?: SuggestWorkers;
  pollMs?: number;
}

/**
 * Sprint 6 M3: suggest.analyze (lane background, priority −10). One pass of the workers
 * (/analyze/suggest, TaskQueue priority 5: ebur128 + relative silences) → ImportAnalysis stored by
 * (asset, params_version, file_sig) and never repeated; the cards of every project that uses the
 * asset are recomputed. Cancel reaches the workers (the ffmpeg is killed). Without workers it
 * fails with WORKERS_UNAVAILABLE (background job: the web shows no toast for it).
 */
export function createSuggestAnalyzeHandler(
  app: AppContext,
  o: SuggestHandlerOptions = {},
): JobHandler<SuggestAnalyzePayload, SuggestAnalyzeJobResult> {
  const workers = o.workers ?? createSuggestWorkers(app.config.workersUrl, app.workers);
  const T = SUGGESTION_THRESHOLDS;
  return {
    type: "suggest.analyze",
    lane: "background",
    parse: (p) => SuggestAnalyzePayloadSchema.parse(p),
    async run(payload, ctx, job) {
      const svc = suggestionsService(app);
      const asset = requireAsset(app, payload.assetId);
      const projects = app.repos.projects.usingAsset(asset.id).map((p) => p.id);
      const refresh = () => {
        for (const id of projects) {
          const project = app.repos.projects.get(id);
          if (project) svc.refresh(project);
        }
      };
      if (asset.kind !== "video" && asset.kind !== "audio")
        throw new Error("Solo se analizan videos o audios");
      if (asset.hasAudio === false)
        return { assetId: asset.id, cached: false, skipped: "no_audio", projects };
      const sig = svc.fileSig(asset);
      if (!sig) throw new Error(`No se encontró el archivo de «${asset.name}»`);
      const cached = svc.repo.analysis(asset.id, T.params_version, sig);
      if (cached && !payload.force) {
        refresh();
        return { assetId: asset.id, cached: true, analysis: cached, projects };
      }
      ctx.reportProgress(0.01, "Midiendo silencios y volumen", {
        stage_es: "Midiendo silencios y volumen",
      });
      const accepted = await workers.suggest(
        {
          input_path: asset.path,
          job_id: job.id,
          silence_min_ms: T.silence_min_ms,
          silence_rel_db: T.silence_rel_db,
          priority: 5,
        },
        ctx.signal,
      );
      ctx.log(`workers /analyze/suggest task ${accepted.task_id}`);
      const task = await pollWorkerTask(workers, "analyze", accepted.task_id, ctx, {
        pollMs: o.pollMs ?? 1000,
        unit: "seconds",
        to: 0.98,
      });
      checkAborted(ctx);
      const res = WorkerSuggestAnalyzeResultSchema.parse(task.result);
      const analysis: ImportAnalysis = {
        assetId: asset.id,
        params_version: T.params_version,
        file_sig: sig,
        duration_s: res.duration_s,
        noise_floor_db: res.noise_floor_db,
        silence_threshold_db: res.silence_threshold_db,
        silences: res.silences.slice(0, 2000).map(([start, end]) => ({ start, end })),
        lufs_i: res.lufs_i,
        lra: res.lra,
        true_peak_db: res.true_peak_db,
        analyzed_at: new Date().toISOString(),
      };
      svc.repo.saveAnalysis(analysis);
      refresh();
      ctx.log(
        `análisis: ${analysis.silences.length} silencios, ${analysis.lufs_i ?? "—"} LUFS, pico ${analysis.true_peak_db ?? "—"} dBTP`,
      );
      return { assetId: asset.id, cached: false, analysis, projects };
    },
  };
}
