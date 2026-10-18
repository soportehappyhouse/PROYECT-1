import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MotionSpecSchema, type DesignTokens } from "@studio/shared";
import type { openBrowser as openBrowserType } from "@remotion/renderer";
import { MotionEngineError } from "@studio/motion-engines";
import { RemotionBrowserMissingError, resolveBrowserExecutable } from "./browser.js";
import { getServeUrl } from "./bundle.js";
import { buildInputProps } from "./props.js";
import { getRendererSettings } from "./render.js";
import { findTemplateDef } from "./catalog.js";

export interface StillOptions {
  template: string;
  props: Record<string, unknown>;
  width: number;
  height: number;
  /** Frame to render (default: the template's thumbnail frame, clamped to the duration). */
  frame?: number;
  format: "png" | "jpeg";
  /** Absolute output file. */
  output: string;
  storageDir: string;
  mediaBaseUrl: string;
  /** Kit tokens (null = no kit; undefined = the registered provider). */
  tokens?: DesignTokens | null;
  /** Browser console lines (tests: a font that failed to load logs a warning). */
  onBrowserLog?: (text: string) => void;
}

type HeadlessBrowser = Awaited<ReturnType<typeof openBrowserType>>;

/** Idle time after which the shared still browser is closed. */
export const STILL_BROWSER_IDLE_MS = 60_000;

let shared:
  | { executable: string; browser: Promise<HeadlessBrowser>; users: number; timer?: NodeJS.Timeout }
  | undefined;

/**
 * One Chrome Headless Shell for every still (audit S6 E6): selectComposition + renderStill used to
 * open two browsers per preview. Closed after STILL_BROWSER_IDLE_MS without stills, and dropped
 * when a render fails (a crashed browser is not reused).
 */
async function borrowBrowser(
  executable: string,
): Promise<{ browser: HeadlessBrowser; done: (ok: boolean) => void }> {
  if (!shared || shared.executable !== executable) {
    const { openBrowser } = await import("@remotion/renderer");
    shared = {
      executable,
      users: 0,
      browser: openBrowser("chrome", {
        browserExecutable: executable,
        chromeMode: "headless-shell",
        logLevel: "warn",
      }),
    };
  }
  const entry = shared;
  if (entry.timer) clearTimeout(entry.timer);
  entry.users++;
  let browser: HeadlessBrowser;
  try {
    browser = await entry.browser;
  } catch (err) {
    entry.users--;
    if (shared === entry) shared = undefined;
    throw err;
  }
  return {
    browser,
    done: (ok) => {
      entry.users--;
      const close = () => {
        if (shared === entry) shared = undefined;
        void browser.close({ silent: true }).catch(() => undefined);
      };
      if (!ok) {
        if (entry.users <= 0) close();
        else if (shared === entry) shared = undefined;
        return;
      }
      if (entry.users <= 0) {
        entry.timer = setTimeout(close, STILL_BROWSER_IDLE_MS);
        entry.timer.unref?.();
      }
    },
  };
}

/** Close the shared still browser now (api shutdown, tests). */
export async function closeStillBrowser(): Promise<void> {
  const entry = shared;
  shared = undefined;
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  const browser = await entry.browser.catch(() => undefined);
  await browser?.close({ silent: true }).catch(() => undefined);
}

/**
 * One frame of a template with Remotion's renderStill (Sprint 6 M2 «vista previa sin render
 * completo»): same bundle, props pipeline and bundled fonts as the real render. Throws
 * RemotionBrowserMissingError when Chrome Headless Shell is missing.
 */
export async function renderTemplateStill(o: StillOptions): Promise<{ frame: number; ms: number }> {
  const started = Date.now();
  const def = findTemplateDef(o.template);
  if (!def)
    throw new MotionEngineError(`Plantilla Remotion desconocida: ${o.template}`, "remotion");
  const thumbnailFrame = def.thumbnailFrame;
  const settings = getRendererSettings();
  const browserExecutable = resolveBrowserExecutable(settings.browserExecutable);
  if (!browserExecutable) throw new RemotionBrowserMissingError();
  const fps = 30;
  const spec = MotionSpecSchema.parse({
    engine: "remotion",
    template: o.template,
    props: o.props,
    durationSec: def.defaultDurationSec,
    fps,
    width: o.width,
    height: o.height,
  });
  const inputProps = await buildInputProps(spec, {
    storageDir: o.storageDir,
    mediaBaseUrl: o.mediaBaseUrl,
    ...(o.tokens !== undefined && { tokens: o.tokens }),
  });
  const serveUrl = await getServeUrl({
    cacheDir: settings.bundleCacheDir ?? path.join(o.storageDir, "tmp", "remotion-bundle"),
  });
  const { selectComposition, renderStill } = await import("@remotion/renderer");
  const lease = await borrowBrowser(browserExecutable);
  let ok = false;
  try {
    const result = await stillWith(lease.browser);
    ok = true;
    return result;
  } finally {
    lease.done(ok);
  }

  async function stillWith(puppeteerInstance: HeadlessBrowser) {
    const common = {
      serveUrl,
      inputProps,
      browserExecutable,
      puppeteerInstance,
      timeoutInMilliseconds: settings.timeoutInMilliseconds,
      logLevel: "warn" as const,
      chromeMode: "headless-shell" as const,
    };
    const composition = await selectComposition({
      ...common,
      id: o.template,
      ...(o.onBrowserLog && { onBrowserLog: (l: { text: string }) => o.onBrowserLog!(l.text) }),
    });
    const frame = Math.min(
      composition.durationInFrames - 1,
      Math.max(0, o.frame ?? thumbnailFrame),
    );
    await mkdir(path.dirname(o.output), { recursive: true });
    await renderStill({
      ...common,
      composition,
      frame,
      output: o.output,
      imageFormat: o.format,
      overwrite: true,
      ...(o.onBrowserLog && { onBrowserLog: (l: { text: string }) => o.onBrowserLog!(l.text) }),
    });
    return { frame, ms: Date.now() - started };
  }
}
