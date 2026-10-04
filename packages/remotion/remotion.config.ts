// Remotion CLI config (used by `pnpm --filter @studio/remotion studio|render:example`).
// Programmatic renders from apps/api go through src/render.ts instead.
import { Config } from "@remotion/cli/config";
import { webpackOverride } from "./src/webpack-override.js";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig(webpackOverride);
// TODO(module-c): enable GPU/concurrency tuning once measured on target Windows PCs.
