import {
  API_ROUTES,
  CAPTION_STYLE_PRESETS,
  DesignCheckResultSchema,
  ProjectSchema,
  type Project,
} from "@studio/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

function speech() {
  const sentences = [
    "Hola, hoy te muestro cómo editar un video para redes.",
    "Primero cortamos los silencios del principio.",
    "Después ponemos subtítulos grandes y claros.",
  ];
  let t = 0.3;
  return sentences.map((s) => {
    const words = s.split(" ").map((w) => {
      const d = 0.38 * Math.max(0.7, Math.min(1.5, w.length / 5));
      const x = { word: w, start: t, end: t + d * 0.9 };
      t += d;
      return x;
    });
    t += 0.5;
    return { start: words[0]!.start, end: words.at(-1)!.end, text: s, words };
  });
}

async function createProject(
  app: FastifyInstance,
  w: number,
  h: number,
  extra: Partial<Project> = {},
) {
  const created = (
    await app.inject({
      method: "POST",
      url: API_ROUTES.projects,
      payload: { name: "Diseño", settings: { width: w, height: h } },
    })
  ).json<Project>();
  const body = ProjectSchema.parse({
    ...created,
    tracks: [
      ...created.tracks,
      {
        id: "trk_m",
        kind: "motion",
        name: "Motion",
        clips: [
          {
            id: "clp_t",
            trackId: "trk_m",
            start: 0,
            in: 0,
            out: 3,
            motion: { template: "title-card", props: { title: "Editá rápido" }, durationSec: 3 },
          },
          {
            id: "clp_l",
            trackId: "trk_m",
            start: 4,
            in: 0,
            out: 4,
            motion: {
              template: "lower-third",
              props: { name: "Luis", role: "Happy House" },
              durationSec: 4,
            },
          },
        ],
      },
    ],
    subtitles: speech(),
    captionStyle: CAPTION_STYLE_PRESETS[1],
    ...extra,
  });
  const res = await app.inject({
    method: "PUT",
    url: API_ROUTES.project.replace(":id", created.id),
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return created.id;
}

describe("POST /api/design/check (Sprint 6 M2, C2)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp());
  });
  afterAll(() => app.close());

  it.each([
    [1080, 1920, "9:16"],
    [1920, 1080, "16:9"],
  ] as const)("default project %ix%i = 10/10", async (w, h, aspect) => {
    const projectId = await createProject(app, w, h);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.designCheck,
      payload: { projectId },
    });
    expect(res.statusCode).toBe(200);
    const body = DesignCheckResultSchema.parse(res.json());
    expect(body.aspect).toBe(aspect);
    expect(body.rules).toHaveLength(10);
    expect(body.issues).toEqual([]);
    expect(body.passed).toBe(10);
  });

  it("a bad style -> issues; fix:true returns the fixed project (10/10)", async () => {
    const projectId = await createProject(app, 1080, 1920, {
      captionStyle: {
        ...CAPTION_STYLE_PRESETS[0]!,
        fontSize: 30,
        background: "",
        outlineWidth: 0,
        fromBrandKit: false,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.designCheck,
      payload: { projectId },
    });
    const body = res.json();
    expect(body.passed).toBe(8);
    expect(body.issues.map((i: { rule: string }) => i.rule).sort()).toEqual([
      "caption.min_size",
      "caption.outline_or_box",
    ]);
    const fixed = await app.inject({
      method: "POST",
      url: API_ROUTES.designCheck,
      payload: { projectId, fix: true },
    });
    const fb = fixed.json();
    expect(fb.passed).toBe(10);
    expect(fb.fixed).toBe(2);
    expect(ProjectSchema.parse(fb.project).captionStyle!.fontSize).toBeGreaterThanOrEqual(49);
    // Not saved by the api (the web applies it as one undo step).
    const stored = await app.inject({
      method: "GET",
      url: API_ROUTES.project.replace(":id", projectId),
    });
    expect(stored.json().captionStyle.fontSize).toBe(30);
  });

  it("checks another aspect on request and 404s an unknown project", async () => {
    const projectId = await createProject(app, 1920, 1080);
    const res = await app.inject({
      method: "POST",
      url: API_ROUTES.designCheck,
      payload: { projectId, aspect: "9:16" },
    });
    expect(res.json().aspect).toBe("9:16");
    const missing = await app.inject({
      method: "POST",
      url: API_ROUTES.designCheck,
      payload: { projectId: "nope" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
