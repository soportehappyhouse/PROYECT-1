// Node-side library entry for apps/api. React compositions are only loaded by the Remotion bundler.
export {
  REMOTION_TEMPLATES,
  TEMPLATE_DEFS,
  toPropsJsonSchema,
  validateRemotionProps,
  type PropsValidation,
  type RemotionTemplateId,
  type RemotionTemplateInfo,
} from "./templates.js";
export {
  animatedCaptionPages,
  buildInputProps,
  setDesignTokensProvider,
  type InputPropsIo,
} from "./props.js";
export { applyDesign, TOKEN_PROPS } from "./lib/design.js";
export { BUNDLED_FONT_FILES, bundledFontPath } from "./font-files.js";
export { BUNDLED_FONTS_DIR, fontFilesFor } from "./fonts-node.js";
export { closeStillBrowser, renderTemplateStill, type StillOptions } from "./still.js";
export { computeSourceHash } from "./bundle.js";
export {
  checkRemotionAvailable,
  resolveBrowserExecutable,
  RemotionBrowserMissingError,
} from "./browser.js";
export {
  codecOptions,
  configureRemotionRenderer,
  getRendererSettings,
  REMOTION_ENGINE_OPTIONS,
  REMOTION_ENTRY,
  disposeRemotion,
  getServeUrl,
  renderMotion,
  type RemotionRendererSettings,
} from "./render.js";
