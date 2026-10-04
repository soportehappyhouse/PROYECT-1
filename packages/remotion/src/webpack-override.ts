import type { WebpackOverrideFn } from "@remotion/bundler";

/**
 * Sources use NodeNext-style imports ("./Root.js" -> Root.tsx). Teach Remotion's webpack to
 * resolve them. Shared by remotion.config.ts (CLI/Studio) and render.ts (programmatic bundle).
 */
export const webpackOverride: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: {
      ...config.resolve?.extensionAlias,
      ".js": [".tsx", ".ts", ".js"],
    },
  },
});
