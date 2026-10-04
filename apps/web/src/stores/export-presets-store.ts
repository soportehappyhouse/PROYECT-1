import { DEFAULT_EXPORT_PRESETS, ExportPresetSchema, type ExportPreset } from "@studio/shared";
import { z } from "zod";
import { create } from "zustand";
import { api, errorMessage, isNotImplemented } from "@/lib/api";
import { readJson, STORAGE_KEYS, writeJson } from "@/lib/storage";

export type PresetsSource = "loading" | "api" | "local";

interface ExportPresetsState {
  presets: ExportPreset[];
  source: PresetsSource;
  error: string | undefined;
  load: () => Promise<void>;
  save: (preset: ExportPreset) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

function localCustom(): ExportPreset[] {
  const parsed = z.array(ExportPresetSchema).safeParse(readJson(STORAGE_KEYS.exportPresets));
  return parsed.success ? parsed.data : [];
}

function writeLocalCustom(presets: readonly ExportPreset[]): void {
  writeJson(
    STORAGE_KEYS.exportPresets,
    presets.filter((p) => !p.builtIn),
  );
}

/** Built-ins + user presets; the api is the source of truth, localStorage while it answers 501. */
export const useExportPresetsStore = create<ExportPresetsState>()((set, get) => ({
  presets: [...DEFAULT_EXPORT_PRESETS],
  source: "loading",
  error: undefined,
  load: async () => {
    try {
      const presets = await api.listExportPresets();
      // Keep local-only custom presets created while the api was in development.
      const local = localCustom().filter((l) => !presets.some((p) => p.id === l.id));
      set({
        presets: [...presets, ...local],
        source: local.length ? "local" : "api",
        error: undefined,
      });
    } catch (err) {
      set({
        presets: [...DEFAULT_EXPORT_PRESETS, ...localCustom()],
        source: "local",
        error: isNotImplemented(err) ? undefined : errorMessage(err),
      });
    }
  },
  save: async (preset) => {
    const valid = ExportPresetSchema.parse({ ...preset, builtIn: false });
    const exists = get().presets.some((p) => p.id === valid.id);
    const next = exists
      ? get().presets.map((p) => (p.id === valid.id ? valid : p))
      : [...get().presets, valid];
    set({ presets: next });
    try {
      if (exists) await api.updateExportPreset(valid);
      else await api.createExportPreset(valid);
    } catch (err) {
      writeLocalCustom(next);
      set({ source: "local" });
      if (!isNotImplemented(err)) throw err;
    }
  },
  remove: async (id) => {
    const target = get().presets.find((p) => p.id === id);
    if (!target || target.builtIn) return;
    const next = get().presets.filter((p) => p.id !== id);
    set({ presets: next });
    writeLocalCustom(next);
    try {
      await api.deleteExportPreset(id);
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
    }
  },
}));
