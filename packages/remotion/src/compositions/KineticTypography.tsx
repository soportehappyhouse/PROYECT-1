import { useMemo } from "react";
import { Easing, interpolate, Sequence, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontStack } from "../fonts.js";
import { splitKinetic, unitScale } from "../lib/anim.js";
import type { KineticTypographyProps } from "../schemas/kinetic-typography.js";
import { Backdrop } from "./common.js";

function Word({
  word,
  color,
  props,
  index,
  length,
}: {
  word: string;
  color: string;
  props: KineticTypographyProps;
  index: number;
  length: number;
}) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = unitScale(width, height);
  const font = fontStack(props.fontFamily);
  const p = spring({ frame, fps, config: { damping: 12, stiffness: 180 } });
  const out = interpolate(frame, [length - 4, length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  let transform = "";
  let opacity = 1 - out;
  switch (props.animation) {
    case "slam":
      transform = `scale(${interpolate(p, [0, 1], [2.6, 1])})`;
      opacity *= Math.min(1, p * 3);
      break;
    case "slide-up":
      transform = `translateY(${(1 - p) * 220 * u}px)`;
      opacity *= p;
      break;
    case "rotate":
      transform = `rotate(${(1 - p) * (index % 2 === 0 ? -90 : 90)}deg) scale(${p})`;
      break;
    case "stagger":
      opacity *= p;
      break;
  }
  const letters = props.animation === "stagger" ? [...word] : [word];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: `0 ${60 * u}px`,
      }}
    >
      <div
        style={{
          fontFamily: font,
          fontWeight: 900,
          fontSize: props.fontSize * u,
          lineHeight: 1,
          color,
          transform,
          opacity,
          textTransform: props.uppercase ? "uppercase" : "none",
        }}
      >
        {letters.map((l, i) => {
          const lp =
            props.animation === "stagger"
              ? spring({ frame: frame - i * 2, fps, config: { damping: 14 } })
              : 1;
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                transform: `translateY(${(1 - lp) * 80 * u}px)`,
                opacity: lp,
              }}
            >
              {l}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Kinetic typography: one word/phrase at a time, evenly spread over the duration. */
export function KineticTypography(props: KineticTypographyProps) {
  const { durationInFrames } = useVideoConfig();
  const parts = useMemo(() => splitKinetic(props.text, props.splitBy), [props.text, props.splitBy]);
  const per = Math.max(1, Math.floor(durationInFrames / Math.max(1, parts.length)));
  return (
    <Backdrop color={props.background}>
      {parts.map((word, i) => (
        <Sequence
          key={i}
          from={i * per}
          durationInFrames={i === parts.length - 1 ? durationInFrames - i * per : per}
        >
          <Word
            word={word}
            color={props.colors[i % props.colors.length] ?? "#ffffff"}
            props={props}
            index={i}
            length={i === parts.length - 1 ? durationInFrames - i * per : per}
          />
        </Sequence>
      ))}
    </Backdrop>
  );
}
