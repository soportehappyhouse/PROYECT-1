// Manual render CLI (no api needed):
//   pnpm --filter @studio/remotion render --template title-card --props '{"title":"Hola"}' \
//     --format webm-vp9-alpha --out out/titulo.webm
//   pnpm --filter @studio/remotion render --list
//   pnpm --filter @studio/remotion render --template lower-third --thumb --out out/lt.png
//   pnpm --filter @studio/remotion render --template transition --storage ../../storage \
//     --media fromSrc=video:media/a.mp4 --media toSrc=image:media/b.jpg --out ../../storage/renders/t.mp4
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { MotionOutputFormatSchema, MotionSpecSchema } from "@studio/shared";
import { outputExtension } from "@studio/motion-engines";
import { resolveBrowserExecutable, RemotionBrowserMissingError } from "../browser.js";
import { getServeUrl } from "../bundle.js";
import { buildInputProps } from "../props.js";
import { getRendererSettings, renderMotion } from "../render.js";
import { REMOTION_TEMPLATES } from "../templates.js";

const { values } = parseArgs({
  options: {
    template: { type: "string", short: "t" },
    props: { type: "string", short: "p" },
    "props-file": { type: "string" },
    format: { type: "string", short: "f", default: "mp4-h264" },
    width: { type: "string" },
    height: { type: "string" },
    fps: { type: "string", default: "30" },
    duration: { type: "string", short: "d" },
    out: { type: "string", short: "o" },
    "media-base": { type: "string", default: "http://127.0.0.1:3001/files/" },
    /** key=kind:path (path relative to --storage), repeatable. */
    media: { type: "string", multiple: true },
    storage: { type: "string" },
    thumb: { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  if (values.list || !values.template) {
    for (const t of REMOTION_TEMPLATES)
      console.log(`${t.id.padEnd(20)} ${t.name} — ${t.description ?? ""}`);
    if (!values.list)
      console.log("\nUso: --template <id> [--props JSON] [--format ...] [--out ...]");
    return;
  }
  const template = REMOTION_TEMPLATES.find((t) => t.id === values.template);
  if (!template) throw new Error(`Plantilla desconocida: ${values.template}`);
  const format = MotionOutputFormatSchema.parse(values.format);
  const props = values["props-file"]
    ? JSON.parse(await readFile(values["props-file"], "utf8"))
    : values.props
      ? JSON.parse(values.props)
      : {};
  const media = Object.fromEntries(
    (values.media ?? []).map((m) => {
      const match = /^([^=]+)=(video|audio|image|lottie|captions):(.+)$/.exec(m);
      if (!match) throw new Error(`--media inválido (key=kind:path): ${m}`);
      return [match[1], { kind: match[2], path: match[3] }];
    }),
  );
  const spec = MotionSpecSchema.parse({
    template: template.id,
    props,
    media,
    format,
    fps: Number(values.fps),
    width: Number(values.width ?? template.defaultSize.width),
    height: Number(values.height ?? template.defaultSize.height),
    durationSec: Number(values.duration ?? template.defaultDurationSec),
  });
  const out = path.resolve(
    values.out ??
      `out/${template.id}${values.thumb ? ".png" : outputExtension(format) || "-frames"}`,
  );
  await mkdir(path.dirname(out), { recursive: true });
  const storageDir = path.resolve(values.storage ?? path.dirname(out));
  const started = Date.now();

  if (values.thumb) {
    const browserExecutable = resolveBrowserExecutable(getRendererSettings().browserExecutable);
    if (!browserExecutable) throw new RemotionBrowserMissingError();
    const { renderStill, selectComposition } = await import("@remotion/renderer");
    const inputProps = await buildInputProps(spec, {
      storageDir,
      mediaBaseUrl: values["media-base"],
      fontMode: getRendererSettings().fontMode,
    });
    const serveUrl = await getServeUrl({ cacheDir: null });
    const id = template.thumbnail.compositionId;
    const composition = await selectComposition({ serveUrl, id, inputProps, browserExecutable });
    await renderStill({ composition, serveUrl, inputProps, output: out, browserExecutable });
  } else {
    let last = -1;
    await renderMotion(spec, {
      jobId: "cli",
      storageDir,
      outputPath: path.relative(storageDir, out),
      tmpDir: path.join(storageDir, "tmp", "cli"),
      mediaBaseUrl: values["media-base"],
      onProgress: (p) => {
        const pct = Math.floor(p.ratio * 100);
        if (pct !== last && pct % 10 === 0) console.log(`[${p.phase}] ${pct}%`);
        last = pct;
      },
    });
  }
  console.log(`OK ${out} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
