import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { API_ROUTES, buildRoute, type Job, type MediaAsset } from "@studio/shared";
import { makeApp, multipart, waitFor } from "./helpers.js";

/** Integration S6 (M3 cross request 7, MEJORAS B15): MediaAsset.probeError survives a reload. */
describe("media.probe failure -> probeError on the asset", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp()); // FFPROBE_PATH does not exist: every probe fails
  });
  afterAll(() => app.close());

  it("stores the cause on the asset", async () => {
    const { payload, headers } = await multipart("roto.mp4", "no es un video", "video/mp4");
    const asset = (
      await app.inject({ method: "POST", url: API_ROUTES.media, payload, headers })
    ).json<MediaAsset>();
    await waitFor(() => {
      const jobs = app.ctx.jobs.list({ type: "media.probe" }) as Job[];
      return jobs.some((j) => j.status === "failed");
    });
    const got = (
      await app.inject({ url: buildRoute(API_ROUTES.mediaItem, { id: asset.id }) })
    ).json<MediaAsset>();
    expect(got.probeError).toBeTruthy();
    expect(got.probeError!.length).toBeLessThanOrEqual(500);
  });
});
