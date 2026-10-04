import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontStack } from "../fonts.js";
import { secToFrames, unitScale } from "../lib/anim.js";
import type { EndScreenProps } from "../schemas/end-screen.js";
import { Backdrop } from "./common.js";

function Slot({
  label,
  delay,
  color,
  u,
}: {
  label: string;
  delay: number;
  color: string;
  u: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        width: 560 * u,
        height: 315 * u,
        borderRadius: 18 * u,
        border: `${4 * u}px dashed ${color}`,
        background: "rgba(255,255,255,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 34 * u,
        color: "rgba(255,255,255,0.8)",
        transform: `scale(${p})`,
        opacity: p,
      }}
    >
      {label}
    </div>
  );
}

/** End screen / call to action. YouTube layout leaves two 16:9 boxes for end-screen elements. */
export function EndScreen(props: EndScreenProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = unitScale(width, height);
  const font = fontStack(props.fontFamily);
  const titleP = spring({ frame, fps, config: { damping: 200 } });
  const ctaP = spring({ frame: frame - secToFrames(0.5, fps), fps, config: { damping: 10 } });
  // Gentle pulse on the CTA once it is in.
  const pulse = 1 + 0.04 * Math.sin((frame / fps) * Math.PI * 2) * Math.min(1, ctaP);
  const handleP = interpolate(frame, [secToFrames(0.8, fps), secToFrames(1.3, fps)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <Backdrop
      color={props.background}
      style={{ justifyContent: "center", alignItems: "center", fontFamily: font, gap: 40 * u }}
    >
      <div
        style={{
          textAlign: "center",
          color: props.textColor,
          opacity: titleP,
          transform: `translateY(${(1 - titleP) * 40 * u}px)`,
        }}
      >
        <div style={{ fontSize: 110 * u, fontWeight: 900, lineHeight: 1.05 }}>{props.title}</div>
        {props.subtitle ? (
          <div style={{ fontSize: 44 * u, opacity: 0.8, marginTop: 12 * u }}>{props.subtitle}</div>
        ) : null}
      </div>
      {props.layout === "youtube" ? (
        <div style={{ display: "flex", gap: 48 * u }}>
          <Slot
            label={props.slot1Label}
            delay={secToFrames(0.3, fps)}
            color={props.accentColor}
            u={u}
          />
          <Slot
            label={props.slot2Label}
            delay={secToFrames(0.45, fps)}
            color={props.accentColor}
            u={u}
          />
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 32 * u }}>
        {props.ctaText ? (
          <div
            style={{
              background: props.accentColor,
              color: "#fff",
              fontWeight: 800,
              fontSize: 52 * u,
              padding: `${16 * u}px ${48 * u}px`,
              borderRadius: 999,
              transform: `scale(${ctaP * pulse})`,
              boxShadow: `0 ${10 * u}px ${40 * u}px rgba(0,0,0,0.35)`,
            }}
          >
            {props.ctaText}
          </div>
        ) : null}
        {props.handle ? (
          <div style={{ color: props.textColor, fontSize: 44 * u, opacity: handleP }}>
            {props.handle}
          </div>
        ) : null}
      </div>
    </Backdrop>
  );
}
