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
export { buildInputProps, type InputPropsIo } from "./props.js";
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
