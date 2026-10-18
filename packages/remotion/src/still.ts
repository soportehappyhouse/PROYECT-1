import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MotionSpecSchema, type DesignTokens } from "@studio/shared";
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
  const common = {
    serveUrl,
    inputProps,
    browserExecutable,
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
    Math.max(0, o.frame ?? def.thumbnailFrame),
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
