import type { CSSProperties } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fontStack } from "../fonts.js";
import { clamp01, inOut, secToFrames, unitScale } from "../lib/anim.js";
import type { TitleCardProps } from "../schemas/title-card.js";
import { Backdrop } from "./common.js";

/** Title + subtitle with five entrance styles and an optional exit. */
export function TitleCard(props: TitleCardProps) {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const u = unitScale(width, height);
  const font = fontStack(props.fontFamily);
  const outFrames = props.exit ? Math.min(secToFrames(0.5, fps), durationInFrames / 3) : 0;
  const { exit } = inOut(frame, durationInFrames, 1, outFrames);
  const enter = spring({
    frame,
    fps,
    config: { damping: 200 },
    durationInFrames: secToFrames(0.8, fps),
  });
  const subEnter = spring({
    frame: frame - secToFrames(0.25, fps),
    fps,
    config: { damping: 200 },
    durationInFrames: secToFrames(0.8, fps),
  });

  const titleStyle: CSSProperties = {
    fontFamily: font,
    fontWeight: 900,
    fontSize: props.titleSize * u,
    color: props.titleColor,
    margin: 0,
    lineHeight: 1.05,
    whiteSpace: "pre-wrap",
  };
  let title = props.title;
  let transform = "";
  let opacity = 1;

  switch (props.style) {
    case "fade-up":
      opacity = enter;
      transform = `translateY(${(1 - enter) * 60 * u}px)`;
      break;
    case "pop": {
      const s = spring({ frame, fps, config: { damping: 9, stiffness: 160 } });
      transform = `scale(${s})`;
      break;
    }
    case "slide":
      transform = `translateX(${(1 - enter) * -width * 0.6}px)`;
      opacity = clamp01(enter * 2);
      break;
    case "typewriter": {
      const chars = Math.floor(
        interpolate(frame, [0, Math.max(1, secToFrames(1.2, fps))], [0, props.title.length], {
          extrapolateRight: "clamp",
        }),
      );
      const caret = Math.floor(frame / (fps / 2)) % 2 === 0 ? "|" : " ";
      title = props.title.slice(0, chars) + (chars < props.title.length ? caret : "");
      break;
    }
    case "boxed":
      break;
  }

  const boxed = props.style === "boxed";
  const reveal = boxed ? enter : 1;
  const exitTransform = exit > 0 ? ` translateY(${-exit * 40 * u}px)` : "";

  return (
    <Backdrop
      color={props.background}
      style={{
        justifyContent: "center",
        alignItems: props.align === "center" ? "center" : "flex-start",
        padding: `0 ${80 * u}px`,
      }}
    >
      <div
        style={{
          opacity: opacity * (1 - exit),
          transform: transform + exitTransform,
          textAlign: props.align,
          display: "flex",
          flexDirection: "column",
          alignItems: props.align === "center" ? "center" : "flex-start",
          gap: 18 * u,
        }}
      >
        <div
          style={{
            position: "relative",
            padding: boxed ? `${16 * u}px ${36 * u}px` : 0,
            clipPath: boxed ? `inset(0 ${(1 - reveal) * 100}% 0 0)` : undefined,
            backgroundColor: boxed ? props.accentColor : undefined,
          }}
        >
          <h1 style={titleStyle}>{title}</h1>
        </div>
        {props.style !== "boxed" && props.style !== "typewriter" ? (
          <div
            style={{
              height: 8 * u,
              width: `${interpolate(enter, [0, 1], [0, 160 * u])}px`,
              backgroundColor: props.accentColor,
              borderRadius: 4 * u,
            }}
          />
        ) : null}
        {props.subtitle ? (
          <p
            style={{
              fontFamily: font,
              fontWeight: 400,
              fontSize: props.titleSize * 0.4 * u,
              color: props.subtitleColor,
              margin: 0,
              opacity: subEnter,
              transform: `translateY(${(1 - subEnter) * 20 * u}px)`,
            }}
          >
            {props.subtitle}
          </p>
        ) : null}
      </div>
    </Backdrop>
  );
}
