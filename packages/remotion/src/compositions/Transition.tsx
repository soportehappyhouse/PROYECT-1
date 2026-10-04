import {
  linearTiming,
  springTiming,
  type TransitionPresentation,
  TransitionSeries,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { flip } from "@remotion/transitions/flip";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { AbsoluteFill, Img, OffthreadVideo, useVideoConfig } from "remotion";
import { isImageSrc, secToFrames, unitScale } from "../lib/anim.js";
import type { TransitionProps } from "../schemas/transition.js";

type AnyPresentation = TransitionPresentation<Record<string, unknown>>;

function presentation(props: TransitionProps): AnyPresentation {
  return pick(props) as unknown as AnyPresentation;
}

function pick(props: TransitionProps) {
  switch (props.kind) {
    case "fade":
      return fade();
    case "slide":
      return slide({ direction: props.direction });
    case "wipe":
      return wipe({ direction: props.direction });
    case "flip":
      return flip({ direction: props.direction });
  }
}

/** Length of each clip so that A + B - transition >= total duration. */
function clipFrames(total: number, transition: number): number {
  return Math.max(transition + 1, Math.ceil((total + transition) / 2));
}

function Clip({
  src,
  color,
  label,
  fit,
}: {
  src: string | undefined;
  color: string;
  label: string;
  fit: TransitionProps["fit"];
}) {
  const { width, height } = useVideoConfig();
  if (src) {
    const style = { width: "100%", height: "100%", objectFit: fit };
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        {isImageSrc(src) ? (
          <Img src={src} style={style} />
        ) : (
          <OffthreadVideo src={src} style={style} />
        )}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill
      style={{
        backgroundColor: color,
        justifyContent: "center",
        alignItems: "center",
        color: "#fff",
        fontFamily: "sans-serif",
        fontWeight: 800,
        fontSize: 140 * unitScale(width, height),
      }}
    >
      {label}
    </AbsoluteFill>
  );
}

/** Two media inputs (A -> B) joined by a @remotion/transitions presentation. */
export function Transition(props: TransitionProps) {
  const { fps, durationInFrames } = useVideoConfig();
  const t = Math.min(secToFrames(props.transitionSec, fps), Math.max(1, durationInFrames - 2));
  const clip = clipFrames(durationInFrames, t);
  const timing =
    props.timing === "spring"
      ? springTiming({ config: { damping: 200 }, durationInFrames: t })
      : linearTiming({ durationInFrames: t });

  return (
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={clip}>
        <Clip src={props.fromSrc} color={props.fromColor} label={props.fromLabel} fit={props.fit} />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={presentation(props)} timing={timing} />
      <TransitionSeries.Sequence durationInFrames={clip}>
        <Clip src={props.toSrc} color={props.toColor} label={props.toLabel} fit={props.fit} />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
}
