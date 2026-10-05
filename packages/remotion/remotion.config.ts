// Remotion CLI config (used by `pnpm --filter @studio/remotion studio` and `remotion render`).
// Programmatic renders from apps/api go through src/render.ts, configured with REMOTION_* env vars
// (concurrency, browser path, hardware acceleration, fonts) — remotion.config.ts does not apply there.
import { Config } from "@remotion/cli/config";
import { webpackOverride } from "./src/webpack-override.js";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(process.env.REMOTION_CONCURRENCY?.trim() || "50%");
Config.overrideWebpackConfig(webpackOverride);
