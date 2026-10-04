import type { FastifyPluginAsync } from "fastify";
import { API_ROUTES } from "@studio/shared";
import { notImplemented } from "../lib/errors.js";

/** TODO(module-b): CRUD over `projects` table validated with ProjectSchema / CreateProjectSchema. */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get(API_ROUTES.projects, async (_req, reply) => notImplemented(reply, "module-b"));
  app.post(API_ROUTES.projects, async (_req, reply) => notImplemented(reply, "module-b"));
  app.get(API_ROUTES.project, async (_req, reply) => notImplemented(reply, "module-b"));
  app.put(API_ROUTES.project, async (_req, reply) => notImplemented(reply, "module-b"));
  app.delete(API_ROUTES.project, async (_req, reply) => notImplemented(reply, "module-b"));
  // TODO(module-b): validate ExportRequestSchema, enqueue "project.export".
  app.post(API_ROUTES.projectExport, async (_req, reply) => notImplemented(reply, "module-b"));
};
