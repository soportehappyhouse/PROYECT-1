import type { MediaAsset } from "@studio/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForProbe } from "@/components/panels/MediaPanel";
import { api } from "@/lib/api";

/** Integration S6 (mapa de calor, flujo 1): place the first video only once it is probed. */
const base: MediaAsset = {
  id: "v1",
  kind: "video",
  name: "vertical.mp4",
  path: "media/v1.mp4",
  sizeBytes: 10,
  createdAt: "2026-10-18T10:00:00.000Z",
};

describe("waitForProbe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("polls the asset until duration and size arrive", async () => {
    const replies = [base, base, { ...base, durationSec: 10, width: 1080, height: 1920 }];
    const spy = vi.spyOn(api, "getMedia").mockImplementation(async () => replies.shift()!);
    const got = await waitForProbe(base, { stepMs: 1 });
    expect(got).toMatchObject({ durationSec: 10, width: 1080, height: 1920 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("an already probed asset returns at once; a failed probe stops waiting", async () => {
    const spy = vi.spyOn(api, "getMedia");
    const ready = { ...base, durationSec: 3, width: 360, height: 640 };
    expect(await waitForProbe(ready)).toBe(ready);
    expect(spy).not.toHaveBeenCalled();
    spy.mockImplementation(async () => ({ ...base, probeError: "moov atom not found" }));
    expect((await waitForProbe(base, { stepMs: 1 })).probeError).toBe("moov atom not found");
  });
});
