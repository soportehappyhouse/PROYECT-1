import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import { API_ROUTES, ExportPresetSchema } from "@studio/shared";
import { errorBody } from "../lib/errors.js";

/** Editable export presets (built-ins seeded on startup; editable but not deletable). */
export const exportPresetRoutes: FastifyPluginAsync = async (app) => {
  const { presets } = app.ctx.repos;

  app.get(API_ROUTES.exportPresets, async () => presets.list());

  app.post(API_ROUTES.exportPresets, async (req, reply) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id && !presets.get(raw.id) ? raw.id : nanoid();
    const preset = ExportPresetSchema.parse({ ...raw, id, builtIn: false });
    return reply.code(201).send(presets.upsert(preset));
  });

  app.put<{ Params: { id: string } }>(API_ROUTES.exportPreset, async (req, reply) => {
    const current = presets.get(req.params.id);
    if (!current) return reply.code(404).send(errorBody("NOT_FOUND", "Preset no encontrado"));
    const preset = ExportPresetSchema.parse({
      ...(req.body as object),
      id: current.id,
      builtIn: current.builtIn,
    });
    return presets.upsert(preset);
  });

  app.delete<{ Params: { id: string } }>(API_ROUTES.exportPreset, async (req, reply) => {
    const current = presets.get(req.params.id);
    if (!current) return reply.code(404).send(errorBody("NOT_FOUND", "Preset no encontrado"));
    if (current.builtIn)
      return reply
        .code(409)
        .send(
          errorBody("BUILT_IN_PRESET", "Los presets incluidos no se pueden borrar (duplícalo)"),
        );
    presets.delete(current.id);
    return reply.code(204).send();
  });
};
