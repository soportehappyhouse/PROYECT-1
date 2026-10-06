import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createStudioApi, type FetchLike } from "../src/api.js";
import { collectFiles, compactProject } from "../src/compact.js";
import { createStudioMcpServer } from "../src/server.js";
import { RUNNABLE_JOBS, TOOLS, TOOL_NAMES, type ToolDeps } from "../src/tools.js";

const CONTRACT_TOOLS = [
  "studio_get_project",
  "studio_list_assets",
  "studio_read_transcript",
  "studio_propose_plan",
  "studio_validate_plan",
  "studio_apply_plan",
  "studio_run_job",
  "studio_get_job",
  "studio_wait_job",
  "studio_export",
  "studio_preview_frame",
  "studio_style_analyze",
  "studio_style_save_preset",
  "studio_style_apply",
  "studio_bug_report",
  "studio_search_library",
];

const PROJECT = {
  id: "p1",
  name: "Demo",
  settings: { width: 1920, height: 1080, fps: 30 },
  updatedAt: "2026-10-06T10:00:00.000Z",
  tracks: [
    {
      id: "t1",
      kind: "video",
      name: "Video 1",
      clips: [{ id: "c1", assetId: "a1", start: 0, in: 2, out: 12, speed: 2 }],
    },
    {
      id: "t2",
      kind: "text",
      name: "Texto",
      clips: [{ id: "c2", start: 1, out: 3, text: "Hola" }],
    },
  ],
  subtitles: [
    { start: 0, end: 1.234, text: "hola" },
    { start: 5, end: 6, text: "chau" },
  ],
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** Fake API: route table "METHOD path" → handler(body, url). */
function mockApi(routes: Record<string, (body: unknown, url: URL) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: url.pathname + url.search, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler)
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no" } }), {
        status: 404,
      });
    const out = handler(body, url);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  };
  const deps: ToolDeps = {
    api: createStudioApi("http://127.0.0.1:3001", fetchImpl),
    storageDir: async () => "/data/storage",
    sleep: async () => undefined,
    pollMs: 1,
  };
  return { calls, deps };
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (name: string, args: any, deps: ToolDeps) => (tool(name).run as any)(args, deps);

describe("studio-mcp tools", () => {
  it("exposes every tool of the contract with a Spanish description", () => {
    expect([...TOOL_NAMES].sort()).toEqual([...CONTRACT_TOOLS].sort());
    for (const t of TOOLS)
      expect(t.description).toMatch(/[áéíóúñ]|\b(el|la|los|del|un|una|y|con)\b/);
  });

  it("studio_get_project picks the latest project and compacts it", async () => {
    const { deps, calls } = mockApi({
      "GET /api/projects": () => [{ ...PROJECT, id: "old", updatedAt: "2020-01-01" }, PROJECT],
      "GET /api/projects/p1": () => PROJECT,
    });
    const out = await run("studio_get_project", {}, deps);
    expect(calls.map((c) => c.url)).toEqual(["/api/projects", "/api/projects/p1"]);
    expect(out).toMatchObject({
      id: "p1",
      canvas: { w: 1920, h: 1080, fps: 30 },
      duration_s: 5,
      subtitles: 2,
    });
    expect(out.tracks[0].clips[0]).toEqual({
      id: "c1",
      assetId: "a1",
      start: 0,
      end: 5,
      in: 2,
      speed: 2,
    });
    expect(out.tracks[1].clips[0].text).toBe("Hola");
  });

  it("studio_read_transcript filters by range", async () => {
    const { deps } = mockApi({ "GET /api/projects/p1": () => PROJECT });
    const out = await run("studio_read_transcript", { projectId: "p1", from: 4 }, deps);
    expect(out.segments).toEqual([[5, 6, "chau"]]);
    expect(out.total).toBe(2);
  });

  it("studio_list_assets returns absolute file paths", async () => {
    const { deps, calls } = mockApi({
      "GET /api/media": () => [
        {
          id: "a1",
          name: "ref.mp4",
          kind: "video",
          path: "media/a1.mp4",
          thumbnailPath: "media/a1.jpg",
          durationSec: 61.239,
          width: 1080,
          height: 1920,
        },
      ],
    });
    const out = await run("studio_list_assets", { kind: "video" }, deps);
    expect(calls[0]!.url).toBe("/api/media?kind=video&limit=100");
    expect(out.assets[0]).toMatchObject({
      file: "/data/storage/media/a1.mp4",
      thumbnail: "/data/storage/media/a1.jpg",
      duration_s: 61.24,
      size: "1080x1920",
    });
  });

  it("studio_validate_plan rejects locally and saves a valid plan via the api", async () => {
    const { deps, calls } = mockApi({
      "POST /api/console/plans": (body) => ({
        id: "plan1",
        ok: true,
        saved: true,
        status: "proposed",
        plan: (body as { plan: unknown }).plan,
        preview_es: ["Exportar con reels-tiktok"],
        risks: ["Escribe un archivo nuevo"],
        unresolved: [],
      }),
    });
    const bad = await run("studio_validate_plan", { plan: { version: 2, ops: [] } }, deps);
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    const plan = {
      version: 1,
      summary_es: "Exportar",
      ops: [{ op: "export", preset: "reels-tiktok" }],
    };
    const ok = await run("studio_validate_plan", { plan }, deps);
    expect(ok).toMatchObject({ planId: "plan1", ok: true, saved: true, needsConfirmation: [0] });
    expect(calls[0]!.body).toMatchObject({ save: true });
  });

  it("studio_apply_plan forwards confirmedIndexes and waits for the job", async () => {
    let polls = 0;
    const { deps, calls } = mockApi({
      "POST /api/agent/apply": () => ({ jobId: "j1" }),
      "GET /api/jobs/j1": () => ({
        id: "j1",
        type: "agent.apply",
        status: ++polls < 3 ? "running" : "succeeded",
        progress: polls / 3,
        result: {
          applied: 1,
          undoSnapshotId: "u1",
          steps: [{ result: { path: "exports/x.mp4" } }],
        },
      }),
    });
    const out = await run("studio_apply_plan", { planId: "plan1", confirmedIndexes: [0] }, deps);
    expect(calls[0]!.body).toEqual({ planId: "plan1", confirmedIndexes: [0] });
    expect(out.job).toMatchObject({ status: "succeeded", files: ["/data/storage/exports/x.mp4"] });
    expect(polls).toBe(3);
  });

  it("studio_run_job maps types to routes and fills path params", async () => {
    const { deps, calls } = mockApi({
      "POST /api/media/a1/proxy": () => ({ jobId: "j2" }),
      "POST /api/subtitles/transcribe": () => ({ jobId: "j3" }),
    });
    expect(
      await run("studio_run_job", { type: "media.proxy", payload: { assetId: "a1" } }, deps),
    ).toMatchObject({ jobId: "j2" });
    await run(
      "studio_run_job",
      { type: "subtitles.transcribe", payload: { projectId: "p1" } },
      deps,
    );
    expect(calls.map((c) => c.url)).toEqual(["/api/media/a1/proxy", "/api/subtitles/transcribe"]);
  });

  it("studio_run_job cannot cut the timeline (destructive: goes through a confirmed plan)", () => {
    expect(Object.keys(RUNNABLE_JOBS)).not.toContain("timeline.apply-cuts");
    const shape = tool("studio_run_job").input as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } }
    >;
    expect(shape.type!.safeParse("timeline.apply-cuts").success).toBe(false);
    expect(shape.type!.safeParse("analyze.silences").success).toBe(true);
  });

  it("studio_export requires the explicit confirmation flag (schema)", () => {
    const shape = tool("studio_export").input as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } }
    >;
    expect(shape.confirmed!.safeParse(false).success).toBe(false);
    expect(shape.confirmed!.safeParse(true).success).toBe(true);
  });

  it("studio_preview_frame asks the api for a JSON frame", async () => {
    const { deps, calls } = mockApi({
      "GET /api/projects/p1/frame": () => ({
        path: "/data/storage/renders/frames/p1-2500.png",
        method: "export",
      }),
    });
    const out = await run("studio_preview_frame", { projectId: "p1", t: 2.5 }, deps);
    expect(calls[0]!.url).toBe("/api/projects/p1/frame?t=2.5&format=json");
    expect(out.path).toMatch(/\.png$/);
  });

  it("studio_style_analyze returns the absolute contact sheet", async () => {
    const { deps } = mockApi({
      "POST /api/style/analyze": () => ({ jobId: "s1" }),
      "GET /api/jobs/s1": () => ({
        id: "s1",
        type: "style.analyze",
        status: "succeeded",
        result: {
          analysisId: "an1",
          path: "renders/an1.json",
          contactSheetPath: "renders/an1-sheet.png",
          analysis: {
            duration_s: 60,
            shot_stats: { cuts_per_min: 22 },
            thumbnails: ["renders/t1.jpg"],
          },
        },
      }),
    });
    const out = await run("studio_style_analyze", { assetId: "a1" }, deps);
    expect(out).toMatchObject({
      analysisId: "an1",
      contactSheet: "/data/storage/renders/an1-sheet.png",
      thumbnails: ["/data/storage/renders/t1.jpg"],
      analysis: { duration_s: 60 },
    });
    expect(out.analysis.thumbnails).toBeUndefined();
  });

  it("studio_style_save_preset tags the source as claude", async () => {
    const { deps, calls } = mockApi({
      "POST /api/style/presets": (b) => ({ id: "sp1", ...(b as object) }),
    });
    await run(
      "studio_style_save_preset",
      { preset: { name: "X", source: { assetId: "a1" } } },
      deps,
    );
    expect(calls[0]!.body).toMatchObject({ source: { via: "claude", assetId: "a1" } });
  });

  it("collectFiles finds nested relative paths", () => {
    expect(
      collectFiles(
        { a: { outputPath: "renders/a.wav" }, list: [{ maskPath: "/abs/m.png" }], n: 1 },
        "/s",
      ),
    ).toEqual(["/s/renders/a.wav", "/abs/m.png"]);
    expect(compactProject({ ...PROJECT, tracks: [] }).duration_s).toBe(0);
  });
});

describe("studio-mcp server (MCP protocol, in memory)", () => {
  it("lists the tools and returns API errors as isError results", async () => {
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).endsWith("/api/projects"))
        return new Response(JSON.stringify([]), { status: 200 });
      throw new Error("ECONNREFUSED");
    };
    const server = createStudioMcpServer({
      api: createStudioApi("http://127.0.0.1:3001", fetchImpl),
      deps: { storageDir: async () => undefined },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...CONTRACT_TOOLS].sort());
    const getProject = tools.find((t) => t.name === "studio_get_project")!;
    expect(getProject.annotations?.readOnlyHint).toBe(true);
    const res = await client.callTool({ name: "studio_get_project", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("NO_PROJECT");
    const down = await client.callTool({ name: "studio_get_job", arguments: { id: "x" } });
    expect(JSON.stringify(down.content)).toContain("API_UNREACHABLE");
    await client.close();
  });
});
