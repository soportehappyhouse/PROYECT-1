import { createReadStream, existsSync } from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES, CreateReportRequestSchema } from "@studio/shared";
import { errorBody } from "../lib/errors.js";
import { buildReport, listReports, reportZipPath } from "../reports/builder.js";
import { collectEnvironment } from "../reports/environment.js";

/** Error reports (docs/REPORTAR-ERRORES.md): build, list and download diagnostic bundles. */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.post(API_ROUTES.reports, async (req, reply) => {
    const body = CreateReportRequestSchema.parse(req.body);
    const { config, jobs, repos, ffmpeg, queue } = app.ctx;
    const report = await buildReport(
      {
        config,
        jobs,
        repos,
        collectEnvironment: () => collectEnvironment({ config, ffmpeg, queue }),
      },
      body,
    );
    req.log.warn(
      { report: report.id, severity: report.severity, jobIds: body.jobIds },
      `Reporte de error creado: ${report.title}`,
    );
    return reply.code(201).send(report);
  });

  app.get(API_ROUTES.reports, async () => listReports(app.ctx.config.storageDir));

  app.get<{ Params: { id: string } }>(API_ROUTES.reportDownload, async (req, reply) => {
    const zip = reportZipPath(app.ctx.config.storageDir, req.params.id);
    if (!zip || !existsSync(zip))
      return reply.code(404).send(errorBody("NOT_FOUND", "Reporte no encontrado"));
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="studio-reporte-${req.params.id}.zip"`)
      .send(createReadStream(zip));
  });
};
