// Remotion bundle entry point (used by the CLI and by src/render.ts via @remotion/bundler).
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root.js";

registerRoot(RemotionRoot);
