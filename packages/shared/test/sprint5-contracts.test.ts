import { describe, expect, it } from "vitest";
import {
  AGENT_EVAL_QUICK_N,
  AgentEvalRequestSchema,
  AgentPlanValidationSchema,
  API_DOWN_ES,
  AUTO_DUCK,
  DEFAULT_EXPORT_PRESETS,
  EditOpSchema,
  EXTRA_EXPORT_PRESETS,
  ExportJobResultSchema,
  ExportPresetSchema,
  ExportRequestSchema,
  formatErrorEs,
  HealthResponseSchema,
  HOTKEYS,
  JobEventSchema,
  JobProgressDetailSchema,
  JobSchema,
  PACKS_PATH_ES,
  PlanChoiceSchema,
  ProjectDuplicateSchema,
  ProjectPatchSchema,
  ProjectSchema,
  ProjectSummarySchema,
  SPRINT5_ERRORS,
  START_CMD_ES,
  TrackSchema,
  WORKER_TASK_ROUTES,
  WORKERS_DOWN_ES,
  WorkerTaskCancelSchema,
  WorkerTaskSchema,
  workerTaskCancelRoute,
} from "../src/index.js";

const NOW = "2026-10-08T12:00:00.000Z";

describe("sprint 5: job progress", () => {
  it("parses a detail with defaults and rejects bad counts", () => {
    const d = JobProgressDetailSchema.parse({ done: 3, total: 20, unit: "commands", eta_s: null });
    expect(d.cancellable).toBe(true);
    expect(d.eta_s).toBeNull();
    expect(JobProgressDetailSchema.safeParse({ total: 0 }).success).toBe(false);
    expect(JobProgressDetailSchema.safeParse({ stage_es: "x".repeat(121) }).success).toBe(false);
  });

  it("adds detail/errorCode to jobs and events (still optional)", () => {
    const base = { id: "j1", type: "agent.eval", status: "failed", payload: {}, createdAt: NOW };
    expect(JobSchema.parse(base).detail).toBeUndefined();
    const job = JobSchema.parse({
      ...base,
      error: "Falta el modelo",
      errorCode: "PACK_REQUIRED",
      detail: { done: 1, total: 20, stage_es: "qwen3:8b · 1/20", progressAt: NOW },
    });
    expect(job.errorCode).toBe("PACK_REQUIRED");
    const ev = JobEventSchema.parse({
      jobId: "j1",
      status: "running",
      progress: 0.5,
      detail: { stalled: true },
    });
    expect(ev.detail?.stalled).toBe(true);
  });
});

describe("sprint 5: worker tasks", () => {
  it("parses a task and a cancel answer", () => {
    const t = WorkerTaskSchema.parse({
      task_id: "t1",
      kind: "eval",
      target: "golden",
      status: "canceled",
      progress: 0.4,
      done: 8,
      total: 20,
      stage_es: "qwen3:8b · 8/20",
      eta_s: null,
    });
    expect(t.cancellable).toBe(true);
    expect(t.bytes_done).toBe(0);
    expect(
      WorkerTaskCancelSchema.parse({ task_id: "t1", canceled: true, was: "running" }).was,
    ).toBe("running");
    expect(
      WorkerTaskCancelSchema.safeParse({ task_id: "t1", canceled: true, was: "x" }).success,
    ).toBe(false);
  });

  it("builds the cancel route of every area", () => {
    expect(workerTaskCancelRoute("vision")).toBe("/vision/tasks/:id/cancel");
    for (const area of Object.keys(WORKER_TASK_ROUTES) as (keyof typeof WORKER_TASK_ROUTES)[])
      expect(workerTaskCancelRoute(area)).toMatch(/^\/[a-z]+\/tasks\/:id\/cancel$/);
  });
});

describe("sprint 5: agent", () => {
  it("defaults the eval mode to quick", () => {
    expect(AgentEvalRequestSchema.parse({}).mode).toBe("quick");
    expect(AgentEvalRequestSchema.parse({ mode: "full" }).mode).toBe("full");
    expect(AGENT_EVAL_QUICK_N).toBe(20);
  });

  it("accepts aspect_fit on export and validates choices", () => {
    const op = EditOpSchema.parse({ op: "export", preset: "reels-tiktok", aspect_fit: "center" });
    expect(op).toMatchObject({ aspect_fit: "center" });
    expect(
      EditOpSchema.safeParse({ op: "export", preset: "reels-tiktok", aspect_fit: "zoom" }).success,
    ).toBe(false);
    const choice = PlanChoiceSchema.parse({
      id: "aspect",
      question_es: "El video es horizontal y Reels es vertical. ¿Cómo lo encuadro?",
      options: [
        {
          id: "reframe",
          label_es: "Seguir la cara",
          insert: { before: 0, op: { op: "reframe", target: "9:16", subject: "face" } },
          patch: { index: 1, aspect_fit: "reframe" },
        },
        { id: "blur", label_es: "Dejarlo entero con franjas borrosas" },
      ],
    });
    expect(choice.options).toHaveLength(2);
    expect(PlanChoiceSchema.safeParse({ ...choice, options: [choice.options[0]] }).success).toBe(
      false,
    );
    const v = AgentPlanValidationSchema.parse({
      ok: true,
      plan: null,
      resolved: [],
      preview_es: [],
      risks: [],
      unresolved: [],
    });
    expect(v.added).toEqual([]);
    expect(v.choices).toEqual([]);
  });
});

describe("sprint 5: export", () => {
  it("sets loudness on the built-in presets", () => {
    const byId = Object.fromEntries(
      [...DEFAULT_EXPORT_PRESETS, ...EXTRA_EXPORT_PRESETS].map((p) => [p.id, p]),
    );
    for (const id of ["reels-tiktok", "youtube-shorts", "youtube-1080p", "youtube-4k"])
      expect(byId[id]!.loudness).toEqual({ integrated: -14, truePeak: -1, lra: 11 });
    expect(byId["gif-480"]!.loudness).toBeNull();
    expect(byId["webm-alpha"]!.loudness).toBeNull();
    for (const p of Object.values(byId)) expect(ExportPresetSchema.parse(p)).toEqual(p);
  });

  it("parses the new request and result fields", () => {
    const r = ExportRequestSchema.parse({
      presetId: "reels-tiktok",
      aspectFit: "blur",
      normalizeLoudness: false,
      autoDuck: true,
    });
    expect(r.aspectFit).toBe("blur");
    expect(ExportRequestSchema.safeParse({ presetId: "x", aspectFit: "stretch" }).success).toBe(
      false,
    );
    const res = ExportJobResultSchema.parse({
      path: "exports/a.mp4",
      durationS: 6,
      sizeBytes: 1234,
      aspectFit: "center",
      loudness: { input_i: -24, input_tp: -3, output_i: -14, output_tp: -1.2 },
      ducked: { voiceTracks: 1, musicTracks: 1 },
      warnings: ["LOUDNESS_MEASURE_FAILED"],
    });
    expect(res.loudness?.output_i).toBe(-14);
  });
});

describe("sprint 5: timeline", () => {
  it("accepts track roles and the project audio mix", () => {
    expect(TrackSchema.parse({ id: "t", kind: "audio", name: "Música", role: "music" }).role).toBe(
      "music",
    );
    expect(
      TrackSchema.safeParse({ id: "t", kind: "audio", name: "x", role: "drums" }).success,
    ).toBe(false);
    const p = ProjectSchema.parse({
      id: "p",
      name: "P",
      settings: {},
      audioMix: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(p.audioMix).toEqual({ autoDuck: true, duckDb: -12 });
    expect(AUTO_DUCK).toEqual({ threshold: 0.05, ratio: 8, attackMs: 150, releaseMs: 600 });
  });
});

describe("sprint 5: projects and health", () => {
  it("parses summaries, rename and duplicate bodies", () => {
    expect(
      ProjectSummarySchema.parse({
        id: "p",
        name: "P",
        createdAt: NOW,
        updatedAt: NOW,
        durationS: 12.5,
        width: 1920,
        height: 1080,
        clips: 3,
      }).thumbnailPath,
    ).toBeUndefined();
    expect(ProjectPatchSchema.parse({ name: "  Mi video  " }).name).toBe("Mi video");
    expect(ProjectPatchSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(ProjectPatchSchema.safeParse({ name: "a", extra: 1 }).success).toBe(false);
    expect(ProjectDuplicateSchema.parse({})).toEqual({});
  });

  it("requires checkedAt in the health answer", () => {
    const h = {
      status: "ok",
      version: "0.1.0",
      ffmpeg: { available: true },
      workers: { reachable: true, url: "http://127.0.0.1:8001", cuda: false },
    };
    expect(HealthResponseSchema.safeParse(h).success).toBe(false);
    expect(HealthResponseSchema.parse({ ...h, checkedAt: NOW }).workers.cuda).toBe(false);
  });
});

describe("sprint 5: texts and errors", () => {
  it("never mentions start.ps1 nor internal errors", () => {
    expect(START_CMD_ES).toBe("scripts\\windows\\start.cmd");
    expect(PACKS_PATH_ES).toBe("Ajustes → Paquetes de IA");
    for (const t of [WORKERS_DOWN_ES, API_DOWN_ES, SPRINT5_ERRORS.WORKERS_UNAVAILABLE.message_es]) {
      expect(t).toContain(START_CMD_ES);
      expect(t).not.toMatch(/start\.ps1|TypeError|ECONNREFUSED/);
    }
  });

  it("formats the sprint 5 messages", () => {
    expect(formatErrorEs("WORKERS_UNAVAILABLE", { host: "127.0.0.1:8001" })).toContain(
      "no responde en 127.0.0.1:8001",
    );
    expect(formatErrorEs("TASK_NOT_FOUND", { id: "t9" })).toContain("La tarea t9 ya no existe");
    expect(
      formatErrorEs("ASPECT_CHOICE_REQUIRED", {
        orientacion: "horizontal",
        preset: "Reels / TikTok (9:16)",
        aspecto: "9:16",
      }),
    ).toBe(
      "El video es horizontal y «Reels / TikTok (9:16)» es 9:16: elegí cómo encuadrarlo (seguir " +
        "la cara, al centro o con franjas borrosas).",
    );
    expect(formatErrorEs("LOUDNESS_MEASURE_FAILED", { causa: "sin audio" })).toContain(
      "(sin audio)",
    );
    expect(SPRINT5_ERRORS.JOB_NOT_CANCELLABLE.status).toBe(409);
    expect(SPRINT5_ERRORS.REVEAL_OUTSIDE_EXPORTS.status).toBe(400);
  });
});

describe("sprint 5: hotkeys", () => {
  it("keeps the existing defaults and has unique ids and keys per scope", () => {
    const byId = new Map(HOTKEYS.map((h) => [h.id, h]));
    expect(byId.size).toBe(HOTKEYS.length);
    expect(HOTKEYS.length).toBe(32);
    expect(byId.get("playback.toggle")?.keys).toBe("Space");
    expect(byId.get("timeline.split")?.keys).toBe("S");
    expect(byId.get("timeline.delete")?.keys).toBe("Delete");
    expect(byId.get("edit.undo")?.keys).toBe("Ctrl+Z");
    expect(byId.get("timeline.rippleDelete")?.keys).toBe("Shift+Delete");
    expect(byId.get("playback.frameBack")?.onSlider).toBe(false);
    expect(byId.get("project.new")?.scope).toBe("global");
    const seen = new Set<string>();
    for (const h of HOTKEYS) {
      const k = `${h.scope}:${h.keys.toLowerCase()}`;
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
      expect(h.help_es.length).toBeGreaterThan(5);
    }
    expect(
      HOTKEYS.filter((h) => h.inTextFields)
        .map((h) => h.id)
        .sort(),
    ).toEqual(["assistant.open", "palette.open", "project.export", "project.save"]);
  });
});
