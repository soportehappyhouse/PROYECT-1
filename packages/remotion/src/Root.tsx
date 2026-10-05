import { type ComponentType, useMemo } from "react";
import { Composition, type CalculateMetadataFunction, Folder, Freeze } from "remotion";
import {
  TEMPLATE_DEFS,
  THUMBNAIL_SUFFIX,
  type RemotionTemplateId,
  type TemplateDef,
} from "./catalog.js";
import { AnimatedCaptions } from "./compositions/AnimatedCaptions.js";
import { AudioVisualizer } from "./compositions/AudioVisualizer.js";
import { EndScreen } from "./compositions/EndScreen.js";
import { KineticTypography } from "./compositions/KineticTypography.js";
import { LottieOverlay } from "./compositions/LottieOverlay.js";
import { LowerThird } from "./compositions/LowerThird.js";
import { ProgressBar } from "./compositions/ProgressBar.js";
import { TitleCard } from "./compositions/TitleCard.js";
import { Transition } from "./compositions/Transition.js";
import type { RenderMetaProps } from "./schemas/common.js";

const FPS = 30;
type AnyProps = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each component gets its schema's output
const COMPONENTS: Record<RemotionTemplateId, ComponentType<any>> = {
  "title-card": TitleCard,
  "lower-third": LowerThird,
  "animated-captions": AnimatedCaptions,
  transition: Transition,
  "audio-visualizer": AudioVisualizer,
  "lottie-overlay": LottieOverlay,
  "end-screen": EndScreen,
  "progress-bar": ProgressBar,
  "kinetic-typography": KineticTypography,
};

/** Wraps a template component so it always receives schema-parsed props (defaults applied). */
function withSchema(def: TemplateDef, Component: ComponentType<AnyProps>): ComponentType<AnyProps> {
  function Template(raw: AnyProps) {
    const props = useMemo(() => def.schema.parse(raw) as AnyProps, [raw]);
    return <Component {...props} />;
  }
  Template.displayName = `Template(${def.id})`;
  return Template;
}

/** Size/fps/duration come from the MotionSpec through the `__*` meta props (src/props.ts). */
function metadataFor(def: TemplateDef, sizeDivisor = 1): CalculateMetadataFunction<AnyProps> {
  return ({ props }) => {
    const p = props as RenderMetaProps;
    const fps = p.__fps ?? FPS;
    return {
      width: Math.round((p.__width ?? def.defaultSize.width) / sizeDivisor),
      height: Math.round((p.__height ?? def.defaultSize.height) / sizeDivisor),
      fps,
      durationInFrames: p.__durationInFrames ?? Math.round(def.defaultDurationSec * fps),
    };
  };
}

/** Preview composition: every frame shows the template frozen at its thumbnail frame. */
function withThumbnail(def: TemplateDef, Template: ComponentType<AnyProps>) {
  function Thumbnail(props: AnyProps) {
    return (
      <Freeze frame={def.thumbnailFrame}>
        <Template {...props} />
      </Freeze>
    );
  }
  Thumbnail.displayName = `Thumbnail(${def.id})`;
  return Thumbnail;
}

const DEFS = TEMPLATE_DEFS as readonly TemplateDef[];
const TEMPLATES = DEFS.map((def) => {
  const Template = withSchema(def, COMPONENTS[def.id as RemotionTemplateId]);
  return {
    def,
    Template,
    Thumbnail: withThumbnail(def, Template),
    defaultProps: def.schema.parse({}) as AnyProps,
  };
});

/**
 * Remotion root: one <Composition> per template, plus a `<id>-thumb` preview composition
 * (1/4 size, every frame frozen at the template's thumbnail frame -> renderStill frame 0).
 */
export function RemotionRoot() {
  return (
    <>
      <Folder name="Plantillas">
        {TEMPLATES.map(({ def, Template, defaultProps }) => (
          <Composition
            key={def.id}
            id={def.id}
            component={Template}
            schema={def.schema}
            durationInFrames={Math.round(def.defaultDurationSec * FPS)}
            fps={FPS}
            width={def.defaultSize.width}
            height={def.defaultSize.height}
            defaultProps={defaultProps}
            calculateMetadata={metadataFor(def)}
          />
        ))}
      </Folder>
      <Folder name="Miniaturas">
        {TEMPLATES.map(({ def, Thumbnail, defaultProps }) => (
          <Composition
            key={`${def.id}${THUMBNAIL_SUFFIX}`}
            id={`${def.id}${THUMBNAIL_SUFFIX}`}
            component={Thumbnail}
            durationInFrames={Math.round(def.defaultDurationSec * FPS)}
            fps={FPS}
            width={def.defaultSize.width / 4}
            height={def.defaultSize.height / 4}
            defaultProps={defaultProps}
            calculateMetadata={metadataFor(def, 4)}
          />
        ))}
      </Folder>
    </>
  );
}
