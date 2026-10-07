import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  API_ROUTES,
  buildRoute,
  CONSENT_TEXT_VERSION,
  LICENCES,
  type AiProvenance,
  type ExportJobResult,
  type ExportPreset,
  type Job,
  type MediaAsset,
  type Project,
} from "@studio/shared";
import {
  applyInheritedAiProvenance,
  exportAiComment,
  inheritAiProvenance,
} from "../src/services/ai-provenance.js";
import { metadataArgs } from "../src/services/ffmpeg/timeline.js";
import { perfRunBody } from "../src/jobs/handlers/ai.js";
import { createConsentGate } from "../src/services/persons/gate.js";
import { makeApp, multipart, tempStorage, waitFor } from "./helpers.js";

/**
 * Sprint 4 (M3) «Revisión para redes»: AI provenance inherited by derived assets and the invisible
 * `comment` metadata of exports (decision 9), checked with ffprobe in the single pass and in the
 * segment render (where it goes in the final concat, outside the cached blocks).
 */

const now = "2026-10-06T00:00:00.000Z";
const face: AiProvenance = {
  kind: "face",
  tool: "facefusion 3.9.1 hyperswap_1a_256",
  personId: "per1",
  consentId: "con1",
  licences: ["faceswap"],
  jobId: "job1",
  sourceAssetId: "orig",
  createdAt: now,
};
const COMMENT =
  "Editado con Studio; contenido alterado con IA: cara sintética: sí; voz clonada: no; voz sintética: no";

describe("inheritAiProvenance / metadataArgs", () => {
  it("copies the provenance with the source id and extra fields; nothing for plain media", () => {
    const src = { id: "swap", aiAltered: true, aiProvenance: face };
    expect(inheritAiProvenance(src, { jobId: "job2" })).toEqual({
      aiAltered: true,
      aiProvenance: { ...face, sourceAssetId: "swap", jobId: "job2" },
    });
    expect(inheritAiProvenance({ id: "plain" })).toEqual({});
  });

  it("builds one argv element for the comment (no shell quoting) and drops newlines", () => {
    expect(metadataArgs(undefined)).toEqual([]);
    expect(metadataArgs("  ")).toEqual([]);
    expect(metadataArgs('a "b"\nc')).toEqual(["-metadata", 'comment=a "b" c']);
  });

  it("applyInheritedAiProvenance updates the derived asset and exportAiComment reads the project", async () => {
    const { app } = await makeApp();
    try {
      const base = { kind: "video" as const, sizeBytes: 1, createdAt: now };
      const swap = app.ctx.repos.media.insert({
        ...base,
        id: "swap",
        name: "Doble",
        path: "renders/face/j/faceswap.mp4",
        aiAltered: true,
        aiProvenance: face,
      });
      const matte = app.ctx.repos.media.insert({
        ...base,
        id: "matte",
        name: "Recorte",
        path: "renders/m.webm",
      });
      const updated = applyInheritedAiProvenance(app.ctx, matte, swap, { jobId: "jm" });
      expect(updated.aiProvenance).toMatchObject({
        kind: "face",
        sourceAssetId: "swap",
        jobId: "jm",
      });
      expect(app.ctx.repos.media.get("matte")!.aiAltered).toBe(true);
      const plain = app.ctx.repos.media.insert({
        ...base,
        id: "plain",
        name: "P",
        path: "media/p.mp4",
      });
      expect(applyInheritedAiProvenance(app.ctx, plain, plain)).toBe(plain);
      const clip = { trackId: "v", start: 0, out: 2 };
      const tracks = [
        {
          id: "v",
          kind: "video",
          name: "V",
          muted: false,
          locked: false,
          hidden: false,
          clips: [],
        },
      ] as unknown as Project["tracks"];
      expect(exportAiComment(app.ctx, { tracks })).toBeUndefined();
      tracks[0]!.clips = [
        { ...clip, id: "c1", assetId: "plain", matte: { assetId: "matte" } },
      ] as never;
      expect(exportAiComment(app.ctx, { tracks })).toBe(COMMENT);
      tracks[0]!.hidden = true;
      expect(exportAiComment(app.ctx, { tracks })).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("perf.run body (sprint 4)", () => {
  it("sends the bench face and the licence only when both exist", async () => {
    const { app, storage } = await makeApp();
    try {
      expect(perfRunBody({ ...app.ctx, db: undefined } as never)).toEqual({ licences: [] });
      expect(perfRunBody(app.ctx)).toEqual({ licences: [] });
      const gate = createConsentGate(app.ctx.db, storage);
      gate.licences.save({
        id: "faceswap",
        text_version: LICENCES.faceswap.text_version,
        text_sha256: "a".repeat(64),
        accepted_at: now,
      });
      expect(perfRunBody(app.ctx)).toEqual({ licences: ["faceswap"] }); // no Person yet
      const consent = {
        id: "con1",
        personId: "per1",
        text_version: CONSENT_TEXT_VERSION,
        text_sha256: "b".repeat(64),
        accepted_at: now,
        method: "firma en pantalla" as const,
        signer_name: "Ana",
        evidence_path: "consent/persons/per1/consents/con1/firma.png",
        evidence_sha256: "c".repeat(64),
        scope: "face" as const,
      };
      gate.persons.insert({
        id: "per1",
        name: "Ana",
        photos: [
          {
            id: "ph1",
            path: "consent/persons/per1/photos/ph1.jpg",
            sha256: "d".repeat(64),
            width: 640,
            height: 480,
            faces: 1,
          },
        ],
        voiceSamples: [],
        consents: [consent],
        createdAt: now,
        updatedAt: now,
      });
      expect(perfRunBody(app.ctx, "job1")).toEqual({
        face_source_path: "consent/persons/per1/photos/ph1.jpg",
        face_consent_id: "con1",
        licences: ["faceswap"],
      });
      // audit fix 11: the use of the Person's photo is audited
      expect(gate.auditLog.list({ action: "perf.facefusion" })[0]).toMatchObject({
        personId: "per1",
        consentId: "con1",
        jobId: "job1",
      });
      // audit fix 15: the most recent valid face consent wins (not the first name)
      const later = new Date(Date.parse(now) + 60_000).toISOString();
      gate.persons.insert({
        id: "per2",
        name: "Zoe",
        photos: [
          {
            id: "ph2",
            path: "consent/persons/per2/photos/ph2.jpg",
            sha256: "e".repeat(64),
            width: 640,
            height: 480,
            faces: 1,
          },
        ],
        voiceSamples: [],
        consents: [{ ...consent, id: "con2", personId: "per2", accepted_at: later }],
        createdAt: now,
        updatedAt: now,
      });
      expect(perfRunBody(app.ctx).face_consent_id).toBe("con2");
    } finally {
      await app.close();
    }
  });
});

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const gen = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const tagsOf = (file: string): Record<string, string> => {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format_tags",
    "-of",
    "json",
    file,
  ]).toString();
  return (JSON.parse(out) as { format: { tags?: Record<string, string> } }).format.tags ?? {};
};

describe.skipIf(!hasFfmpeg)(
  "export comment metadata + inherited provenance (ffmpeg)",
  { timeout: 300_000 },
  () => {
    const dir = tempStorage("studio-aicomment-");
    let app: FastifyInstance;
    let storage = "";
    let preset: ExportPreset;

    beforeAll(async () => {
      gen([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=12",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=12",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-g",
        "50",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        path.join(dir, "clip.mp4"),
      ]);
      gen(["-f", "lavfi", "-i", "sine=frequency=330:duration=2", path.join(dir, "voz.wav")]);
      ({ app, storage } = await makeApp({ FFMPEG_PATH: "ffmpeg", FFPROBE_PATH: "ffprobe" }));
      const created = await app.inject({
        method: "POST",
        url: API_ROUTES.exportPresets,
        payload: { name: "Test 90p", aspect: "16:9", width: 160, height: 90, fps: 25, crf: 30 },
      });
      expect(created.statusCode).toBe(201);
      preset = created.json<ExportPreset>();
    }, 120_000);
    afterAll(() => app?.close());

    const upload = async (file: string, type: string) => {
      const { payload, headers } = await multipart(path.basename(file), readFileSync(file), type);
      const res = await app.inject({ method: "POST", url: API_ROUTES.media, payload, headers });
      expect(res.statusCode).toBe(201);
      return res.json<MediaAsset>();
    };
    const jobDone = async (id: string): Promise<Job> => {
      await waitFor(
        () => ["succeeded", "failed", "canceled"].includes(app.ctx.jobs.get(id)!.status),
        240_000,
      );
      const job = app.ctx.jobs.get(id)!;
      if (job.status === "failed")
        throw new Error(`${job.type} failed: ${job.error}\n${app.ctx.jobs.logTail(id).join("\n")}`);
      return job;
    };
    const idle = () =>
      waitFor(
        () =>
          app.ctx.jobs.list({ status: "running" }).length +
            app.ctx.jobs.list({ status: "queued" }).length ===
          0,
        240_000,
      );

    it("writes comment= in the single pass and in the segment render; none without AI", async () => {
      const video = await upload(path.join(dir, "clip.mp4"), "video/mp4");
      await idle();
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.projects,
        payload: { name: "IA", settings: { width: 160, height: 90, fps: 25 } },
      });
      const p = res.json<Project>();
      const track = p.tracks.find((t) => t.kind === "video")!;
      const project: Project = {
        ...p,
        tracks: p.tracks.map((t) =>
          t.id === track.id
            ? {
                ...t,
                clips: [
                  {
                    id: "c1",
                    trackId: t.id,
                    assetId: video.id,
                    start: 0,
                    in: 0,
                    out: 12,
                    speed: 1,
                    volume: 1,
                    opacity: 1,
                    voiceEffects: [],
                  },
                ],
              }
            : t,
        ),
      };
      const saved = await app.inject({
        method: "PUT",
        url: buildRoute(API_ROUTES.project, { id: p.id }),
        payload: project,
      });
      expect(saved.statusCode).toBe(200);
      const exportNow = async (extra: Record<string, unknown> = {}) => {
        const r = await app.inject({
          method: "POST",
          url: buildRoute(API_ROUTES.projectExport, { id: p.id }),
          payload: { presetId: preset.id, ...extra },
        });
        expect(r.statusCode, r.body).toBe(202);
        const job = await jobDone(r.json<{ jobId: string }>().jobId);
        const result = job.result as ExportJobResult;
        return { result, abs: path.join(storage, result.path) };
      };

      // plain media: no AI comment
      const plain = await exportNow({ useSegmentCache: false });
      expect(tagsOf(plain.abs).comment).toBeUndefined();

      // the asset becomes a face swap (what face.swap writes): comment in both render paths,
      // with the visible label OFF (project.publish untouched)
      app.ctx.repos.media.update(video.id, { aiAltered: true, aiProvenance: face });
      const single = await exportNow({ useSegmentCache: false });
      expect(single.result.mode).toBe("single");
      expect(tagsOf(single.abs).comment).toBe(COMMENT);
      const blocks = await exportNow();
      expect(blocks.result.mode).toBe("segments");
      expect(tagsOf(blocks.abs).comment).toBe(COMMENT);
      for (const secret of ["per1", "con1", video.name]) expect(COMMENT).not.toContain(secret);
    });

    it("voice.effect over a cloned voice keeps the provenance (Revisión para redes)", async () => {
      const voice = await upload(path.join(dir, "voz.wav"), "audio/wav");
      await idle();
      const cloned: AiProvenance = {
        kind: "voice-cloned",
        tool: "chatterbox mtl-v3",
        personId: "per2",
        createdAt: now,
      };
      app.ctx.repos.media.update(voice.id, { aiAltered: true, aiProvenance: cloned });
      const res = await app.inject({
        method: "POST",
        url: API_ROUTES.voiceEffects,
        payload: { assetId: voice.id, effects: [{ type: "pitch", semitones: 2 }] },
      });
      expect(res.statusCode, res.body).toBe(202);
      const job = await jobDone(res.json<{ jobId: string }>().jobId);
      const out = app.ctx.repos.media.get((job.result as { assetId: string }).assetId)!;
      expect(out.aiAltered).toBe(true);
      expect(out.aiProvenance).toMatchObject({
        kind: "voice-cloned",
        personId: "per2",
        sourceAssetId: voice.id,
        jobId: job.id,
      });
    });

    it("re-importing an exported file keeps it as AI content (comment tag, audit fix 10)", async () => {
      const exported = path.join(dir, "exportado.mp4");
      const comment =
        "Editado con Studio; contenido alterado con IA: cara sintética: sí; voz clonada: sí; " +
        "voz sintética: no";
      gen(["-i", path.join(dir, "clip.mp4"), "-t", "2", "-c", "copy", "-metadata",
        `comment=${comment}`, exported]); // prettier-ignore
      expect(tagsOf(exported).comment).toBe(comment);
      const asset = await upload(exported, "video/mp4");
      await idle();
      const probed = app.ctx.repos.media.get(asset.id)!;
      expect(probed.aiAltered).toBe(true);
      expect(probed.aiProvenance).toMatchObject({ kind: "face", extraKinds: ["voice-cloned"] });
      expect(probed.aiProvenance).not.toHaveProperty("personId");
      const project = {
        tracks: [
          {
            id: "t1",
            kind: "video" as const,
            name: "V1",
            clips: [{ id: "c9", trackId: "t1", assetId: asset.id, start: 0, in: 0, out: 2 }],
          },
        ],
      } as unknown as Project;
      expect(exportAiComment(app.ctx, project)).toBe(comment);
      // a plain file stays plain
      const plain = await upload(path.join(dir, "clip.mp4"), "video/mp4");
      await idle();
      expect(app.ctx.repos.media.get(plain.id)!.aiAltered).toBeUndefined();
    });
  },
);
