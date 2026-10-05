import type { CSSProperties } from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontStack } from "../fonts.js";
import { secToFrames, unitScale } from "../lib/anim.js";
import { trackPoint } from "../lib/track.js";
import type { LowerThirdProps } from "../schemas/lower-third.js";

type Anim = LowerThirdProps["enter"] | LowerThirdProps["exit"];

/** Animation style for progress p (0 = hidden, 1 = fully visible). */
function animStyle(anim: Anim, p: number, fromSide: "left" | "right" | "bottom", u: number) {
  switch (anim) {
    case "slide": {
      const d = (1 - p) * 700 * u;
      const t =
        fromSide === "left"
          ? `translateX(${-d}px)`
          : fromSide === "right"
            ? `translateX(${d}px)`
            : `translateY(${d * 0.4}px)`;
      return { transform: t, opacity: Math.min(1, p * 3) };
    }
    case "fade":
      return { opacity: p };
    case "wipe":
      return {
        clipPath:
          fromSide === "right"
            ? `inset(0 0 0 ${(1 - p) * 100}%)`
            : `inset(0 ${(1 - p) * 100}% 0 0)`,
      };
    case "pop":
      return { transform: `scale(${p})`, opacity: Math.min(1, p * 2) };
    case "none":
      return {};
  }
}

/** Name + role overlay, adapted from the idea of remotion-dev/template-overlay (rewritten). */
export function LowerThird(props: LowerThirdProps) {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const u = unitScale(width, height) * props.scale;
  const font = fontStack(props.fontFamily);
  const inFrames = secToFrames(props.inSec, fps);
  const outFrames = props.exit === "none" ? 0 : secToFrames(props.outSec, fps);

  const enterP =
    props.enter === "pop"
      ? spring({ frame, fps, config: { damping: 12, stiffness: 140 }, durationInFrames: inFrames })
      : interpolate(frame, [0, inFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
  const exitP =
    outFrames === 0
      ? 1
      : interpolate(frame, [durationInFrames - outFrames, durationInFrames - 1], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.in(Easing.cubic),
        });
  const exiting = outFrames > 0 && frame >= durationInFrames - outFrames;

  const [vertical, horizontal] = props.position.split("-") as [
    "top" | "bottom",
    "left" | "center" | "right",
  ];
  const fromSide = horizontal === "center" ? "bottom" : horizontal;
  const anim = exiting
    ? animStyle(props.exit, exitP, fromSide, u)
    : animStyle(props.enter, enterP, fromSide, u);
  // Role line trails the name a few frames on enter.
  const roleP = exiting
    ? exitP
    : interpolate(frame, [inFrames * 0.4, inFrames * 1.2], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

  const nameStyle: CSSProperties = {
    fontFamily: font,
    fontWeight: 700,
    fontSize: 56 * u,
    color: props.textColor,
    lineHeight: 1.1,
    whiteSpace: "nowrap",
  };
  const roleStyle: CSSProperties = {
    fontFamily: font,
    fontWeight: 400,
    fontSize: 34 * u,
    color: props.roleColor,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    opacity: roleP,
  };
  const pad = `${14 * u}px ${30 * u}px`;

  let card;
  switch (props.style) {
    case "bar":
      card = (
        <div
          style={{
            display: "flex",
            background: props.boxColor,
            borderLeft: `${12 * u}px solid ${props.accentColor}`,
            padding: pad,
            flexDirection: "column",
          }}
        >
          <div style={nameStyle}>{props.name}</div>
          {props.role ? <div style={roleStyle}>{props.role}</div> : null}
        </div>
      );
      break;
    case "box":
      card = (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ ...nameStyle, background: props.accentColor, padding: pad }}>
            {props.name}
          </div>
          {props.role ? (
            <div style={{ ...roleStyle, background: props.boxColor, padding: pad }}>
              {props.role}
            </div>
          ) : null}
        </div>
      );
      break;
    case "underline":
      card = (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 * u }}>
          <div style={{ ...nameStyle, textShadow: `0 ${2 * u}px ${12 * u}px rgba(0,0,0,0.6)` }}>
            {props.name}
          </div>
          <div
            style={{
              height: 6 * u,
              width: `${(exiting ? exitP : enterP) * 100}%`,
              background: props.accentColor,
            }}
          />
          {props.role ? <div style={roleStyle}>{props.role}</div> : null}
        </div>
      );
      break;
    case "split":
      card = (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ ...nameStyle, background: props.boxColor, padding: pad }}>{props.name}</div>
          {props.role ? (
            <div
              style={{
                ...roleStyle,
                background: props.accentColor,
                padding: `${8 * u}px ${24 * u}px`,
                marginLeft: 40 * u,
                transform: `translateX(${(1 - roleP) * 60 * u}px)`,
              }}
            >
              {props.role}
            </div>
          ) : null}
        </div>
      );
      break;
  }

  // Sprint 2: following a track, the card's center sits on the tracked point (per frame).
  const tracked = props.track
    ? trackPoint(props.track, frame / fps, props.trackAnchor, props.trackOffset)
    : undefined;
  if (tracked)
    return (
      <div
        style={{
          position: "absolute",
          left: tracked.x * width,
          top: tracked.y * height,
          transform: "translate(-50%, -50%)",
        }}
      >
        <div style={{ ...anim, transformOrigin: horizontal === "right" ? "right" : "left" }}>
          {card}
        </div>
      </div>
    );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: vertical === "top" ? "flex-start" : "flex-end",
        alignItems:
          horizontal === "left" ? "flex-start" : horizontal === "right" ? "flex-end" : "center",
        padding: `${(props.marginPct / 100) * height}px ${(props.marginPct / 100) * width}px`,
      }}
    >
      <div style={{ ...anim, transformOrigin: horizontal === "right" ? "right" : "left" }}>
        {card}
      </div>
    </div>
  );
}
