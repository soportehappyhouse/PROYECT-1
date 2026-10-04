import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export interface TransitionProps {
  kind: "wipe" | "fade";
  color?: string;
}

// TODO(module-c): more transition kinds (slide, zoom, glitch) and alpha output.
export function Transition({ kind, color = "#000000" }: TransitionProps) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = interpolate(frame, [0, durationInFrames - 1], [0, 1], { extrapolateRight: "clamp" });
  const style =
    kind === "fade"
      ? { backgroundColor: color, opacity: p < 0.5 ? p * 2 : (1 - p) * 2 }
      : { backgroundColor: color, transform: `translateX(${(p * 2 - 1) * 100}%)` };

  return <AbsoluteFill style={style} />;
}
