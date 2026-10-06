import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_CONFIRM_OPS,
  CAPTION_STYLE_IDS,
  CAPTION_STYLE_PRESETS,
  DEFAULT_EXPORT_PRESETS,
  EDIT_OP_NAMES,
  EditPlanSchema,
  editPlanJsonSchema,
  EXTRA_EXPORT_PRESETS,
  AGENT_KNOWN_PRESET_IDS,
  REMOTION_TEMPLATE_IDS,
  VOICE_EFFECT_IDS,
  VOICE_EFFECT_PRESETS,
  validateEditPlan,
  type EditPlanInput,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const FULL: EditPlanInput = {
  version: 1,
  summary_es: "Corto silencios, agrego un título y exporto para Reels.",
  ops: [
    { op: "cut_silences", min_silence_ms: 400, fillers: true },
    { op: "detect_scenes", split: true },
    { op: "split", clip: { index: 1, track: "video" }, t: 12.5 },
    { op: "trim", clip: { name: "entrevista" }, in: "start", out: { scene: 3 } },
    { op: "delete_clip", clip: { id: "c1" } },
    { op: "set_speed", clip: { at: "cursor" }, speed: 2 },
    { op: "set_volume", clip: { track: "audio", index: 1 }, volume_db: -12 },
    { op: "move_clip", clip: { name: "intro" }, t: { after_clip: { index: -1 } } },
    {
      op: "add_text",
      text: "Hola",
      t: { after_clip: { name: "intro", at: 3 } },
      duration_s: 3,
      style: { font_size: 80, color: "#ffffff" },
      position: "top",
    },
    { op: "add_motion", template: "lower-third", t: 2, params: { name: "Ana" }, follow: "face" },
    { op: "add_captions", style: "reels", animated: true, language: "es" },
    { op: "transcribe", clip: { index: -1 } },
    { op: "tts", text: "Bienvenidos", t: "start", effect: "robot" },
    { op: "voice_effect", clip: { index: 1 }, effect: "deep" },
    { op: "denoise", clip: { track: "audio", index: 1 } },
    { op: "add_audio", query: "música alegre", t: 0, volume_db: -12, duck: true },
    { op: "remove_background", clip: { index: 1 }, background: { type: "blur" } },
    { op: "reframe", target: "9:16", subject: "face" },
    { op: "set_canvas", preset: { w: 1080, h: 1350 } },
    { op: "set_publish", for_social: true, flags: { ai_voice: true }, ai_label: true },
    { op: "export", preset: "reels-tiktok", name: "final", confirm: true },
    { op: "report_bug", title: "Se colgó", steps_es: "Exporté y se colgó." },
  ],
};

describe("EditPlan schema (Sprint 3)", () => {
  it("accepts a plan with every op kind", () => {
    // EDIT_PLAN_MAX_OPS (20) < number of op kinds: validate the full list in two plans.
    for (const ops of [FULL.ops.slice(0, 11), FULL.ops.slice(11)]) {
      const r = validateEditPlan({ ...FULL, ops });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    }
    expect(validateEditPlan(FULL).errors[0]).toMatch(/^ops: /);
    expect(new Set(FULL.ops.map((o) => o.op))).toEqual(new Set(EDIT_OP_NAMES));
    expect(EDIT_OP_NAMES).toHaveLength(22);
  });

  it("accepts a questions-only plan and rejects an empty one", () => {
    expect(
      validateEditPlan({
        version: 1,
        summary_es: "Necesito un dato",
        ops: [],
        questions: ["¿Qué clip?"],
      }).ok,
    ).toBe(true);
    const r = validateEditPlan({ version: 1, summary_es: "Nada", ops: [] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["ops: El plan no tiene operaciones ni preguntas."]);
  });

  it("reports invalid plans with Spanish messages and paths", () => {
    const r = validateEditPlan({
      version: 2,
      summary_es: "x",
      ops: [
        { op: "set_speed", clip: { index: 1 }, speed: 50 },
        { op: "split", clip: { index: 0 }, t: -1 },
        { op: "volar", clip: {} },
        { op: "add_text", t: 1 },
        { op: "reframe", target: "16:10" },
        { op: "export", preset: "reels-tiktok", extra: true },
      ],
    });
    expect(r.ok).toBe(false);
    const text = r.errors.join("\n");
    expect(text).toMatch(/^version: .*1/m);
    expect(text).toMatch(/ops\[0\]\.speed: Demasiado grande/);
    expect(text).toMatch(/ops\[1\]\.clip\.index: index empieza en 1/);
    expect(text).toMatch(/ops\[1\]\.t: /);
    expect(text).toMatch(/ops\[2\]\.op: operación desconocida; válidas: cut_silences, /);
    expect(text).toMatch(/ops\[3\]\.text: Entrada inválida: se esperaba texto/);
    expect(text).toMatch(/ops\[4\]\.target: Opción inválida/);
    expect(text).toMatch(/ops\[5\]: Llave desconocida: "extra"/);
    expect(text).not.toMatch(/Invalid|expected/); // no English zod messages
  });

  it("rejects unknown templates, caption styles and effects", () => {
    const r = validateEditPlan({
      version: 1,
      summary_es: "x",
      ops: [
        { op: "add_motion", template: "explosion", t: 0 },
        { op: "add_captions", style: "comic" },
        { op: "voice_effect", clip: { index: 1 }, effect: "alien" },
      ],
    });
    expect(r.errors.map((e) => e.split(":")[0])).toEqual([
      "ops[0].template",
      "ops[1].style",
      "ops[2].effect",
    ]);
  });

  it("enum ids match the runtime catalogs", () => {
    expect([...CAPTION_STYLE_IDS]).toEqual(CAPTION_STYLE_PRESETS.map((s) => s.id));
    expect([...VOICE_EFFECT_IDS]).toEqual(VOICE_EFFECT_PRESETS.map((p) => p.id));
    expect([...REMOTION_TEMPLATE_IDS]).toContain("title-card");
    const presetIds = [...DEFAULT_EXPORT_PRESETS, ...EXTRA_EXPORT_PRESETS].map((p) => p.id);
    for (const id of AGENT_KNOWN_PRESET_IDS) expect(presetIds).toContain(id);
    expect(ALWAYS_CONFIRM_OPS).toEqual(["delete_clip", "export"]);
  });

  it("exports a JSON Schema with Spanish descriptions, $defs and the exported file is current", () => {
    const schema = editPlanJsonSchema() as {
      properties: {
        ops: { items: { oneOf: { properties: Record<string, { description?: string }> }[] } };
      };
      $defs: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.$defs).sort()).toEqual([
      "BaseClipRef",
      "ClipRef",
      "PointTime",
      "Time",
    ]);
    expect(schema.required).toEqual(["version", "summary_es", "ops"]);
    const variants = schema.properties.ops.items.oneOf;
    expect(variants).toHaveLength(22);
    for (const v of variants)
      for (const [key, prop] of Object.entries(v.properties))
        expect(prop.description, `${key} sin descripción`).toMatch(/[a-záéíóúñ]/i);
    const json = JSON.stringify(schema);
    expect(json.length).toBeLessThan(60_000);
    // `confirm` is optional in the input schema (default true is applied by the api).
    expect(JSON.stringify(variants[0])).not.toMatch(/"required":\[[^\]]*"confirm"/);
    const file = JSON.parse(
      readFileSync(path.join(here, "../schemas/editplan.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const { $id: _id, title: _t, ...rest } = file;
    expect(rest).toEqual(JSON.parse(json));
    const workers = readFileSync(
      path.join(here, "../../../apps/workers/studio_workers/agent/editplan.schema.json"),
      "utf8",
    );
    expect(JSON.parse(workers)).toEqual(file);
  });

  it("parses with the strict object rules (no extra keys in ClipRef)", () => {
    expect(
      EditPlanSchema.safeParse({
        version: 1,
        summary_es: "x",
        ops: [{ op: "delete_clip", clip: { clip_id: "a" } }],
      }).success,
    ).toBe(false);
  });
});
