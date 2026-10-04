import type { ComponentType } from "react";
import { Composition } from "remotion";
import { AnimatedSubtitles } from "./compositions/AnimatedSubtitles.js";
import { LowerThird } from "./compositions/LowerThird.js";
import { Title } from "./compositions/Title.js";
import { Transition } from "./compositions/Transition.js";
import { REMOTION_TEMPLATES, type RemotionTemplateId } from "./templates.js";

const FPS = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- props are validated per template
const COMPONENTS: Record<RemotionTemplateId, ComponentType<any>> = {
  "title-card": Title,
  "lower-third": LowerThird,
  "animated-captions": AnimatedSubtitles,
  transition: Transition,
};

/** Remotion root: registers one <Composition> per template in REMOTION_TEMPLATES. */
export function RemotionRoot() {
  return (
    <>
      {REMOTION_TEMPLATES.map((t) => (
        <Composition
          key={t.id}
          id={t.id}
          component={COMPONENTS[t.id]}
          durationInFrames={Math.round(t.defaultDurationSec * FPS)}
          fps={FPS}
          width={1920}
          height={1080}
          defaultProps={t.defaultProps}
          // Size/duration/fps are overridden per render from the MotionSpec (inputProps).
          calculateMetadata={({ props }) => {
            const p = props as {
              __width?: number;
              __height?: number;
              __durationInFrames?: number;
              __fps?: number;
            };
            return {
              width: p.__width ?? 1920,
              height: p.__height ?? 1080,
              fps: p.__fps ?? FPS,
              durationInFrames: p.__durationInFrames ?? Math.round(t.defaultDurationSec * FPS),
            };
          }}
        />
      ))}
    </>
  );
}
