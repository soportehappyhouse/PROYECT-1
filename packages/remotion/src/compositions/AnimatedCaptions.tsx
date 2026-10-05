import type { TikTokPage } from "@remotion/captions";
import { type CSSProperties, useMemo } from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { fontStack } from "../fonts.js";
import {
  activeTokenIndex,
  buildCaptionPages,
  captionFrame,
  pageEndMs,
  transcriptToCaptions,
} from "../lib/captions.js";
import type { AnimatedCaptionsProps } from "../schemas/animated-captions.js";
import { Backdrop } from "./common.js";

/**
 * TikTok/CapCut-style captions. Page grouping + per-token timing follow the approach of
 * remotion-dev/template-tiktok (Page.tsx / SubtitlePage.tsx), rewritten with 4 styles.
 */
export function AnimatedCaptions(props: AnimatedCaptionsProps) {
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const pages = useMemo(() => {
    const captions =
      props.captions && props.captions.length > 0
        ? props.captions
        : transcriptToCaptions(props.transcript);
    return buildCaptionPages(captions, props.combineWithinMs);
  }, [props.captions, props.transcript, props.combineWithinMs]);
  const { safe, unit } = captionFrame(props, width, height);
  const totalMs = (durationInFrames / fps) * 1000;

  return (
    <Backdrop color={props.background}>
      {props.videoSrc ? (
        <AbsoluteFill>
          <OffthreadVideo src={props.videoSrc} style={{ objectFit: "cover" }} />
        </AbsoluteFill>
      ) : null}
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const to = Math.round((pageEndMs(pages, i, totalMs) / 1000) * fps);
        if (to <= from || from >= durationInFrames) return null;
        return (
          <Sequence key={`${page.startMs}-${i}`} from={from} durationInFrames={to - from}>
            <AbsoluteFill
              style={{
                padding: `${(safe.top / 100) * height}px ${(safe.right / 100) * width}px ${(safe.bottom / 100) * height}px ${(safe.left / 100) * width}px`,
                justifyContent:
                  props.position === "top"
                    ? "flex-start"
                    : props.position === "center"
                      ? "center"
                      : "flex-end",
                alignItems: "center",
              }}
            >
              <CaptionPage page={page} props={props} u={unit} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </Backdrop>
  );
}

function CaptionPage({
  page,
  props,
  u,
}: {
  page: TikTokPage;
  props: AnimatedCaptionsProps;
  u: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = page.startMs + (frame / fps) * 1000;
  const active = activeTokenIndex(page, timeMs);
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 5 });
  const font = fontStack(props.fontFamily);
  const fontSize = props.fontSize * u;

  const base: CSSProperties = {
    fontFamily: font,
    fontWeight: Number(props.fontWeight),
    fontSize,
    lineHeight: 1.15,
    textTransform: props.uppercase ? "uppercase" : "none",
    color: props.textColor,
    WebkitTextStroke:
      props.strokeWidth > 0 ? `${props.strokeWidth * u}px ${props.strokeColor}` : undefined,
    paintOrder: "stroke",
    display: "inline-block",
    whiteSpace: "pre",
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        columnGap: fontSize * 0.28,
        rowGap: fontSize * 0.1,
        textAlign: "center",
        transform: `scale(${0.85 + 0.15 * enter}) translateY(${(1 - enter) * 30 * u}px)`,
        opacity: enter,
      }}
    >
      {page.tokens.map((token, i) => {
        const isActive = i === active;
        const spoken = i < active;
        const style: CSSProperties = { ...base };
        switch (props.style) {
          case "highlight":
            if (isActive) style.color = props.highlightColor;
            break;
          case "karaoke":
            if (spoken) style.color = props.highlightColor;
            if (isActive) {
              // Progressive fill: highlighted copy on top, clipped to the spoken fraction.
              const span = Math.max(1, token.toMs - token.fromMs);
              const p = Math.min(100, Math.max(0, ((timeMs - token.fromMs) / span) * 100));
              return (
                <span key={`${token.fromMs}-${i}`} style={{ ...style, position: "relative" }}>
                  {token.text.trim()}
                  <span
                    style={{
                      ...style,
                      position: "absolute",
                      left: 0,
                      top: 0,
                      color: props.highlightColor,
                      clipPath: `inset(0 ${100 - p}% 0 0)`,
                    }}
                  >
                    {token.text.trim()}
                  </span>
                </span>
              );
            }
            break;
          case "pop":
            if (isActive) {
              const local = Math.round(((timeMs - token.fromMs) / 1000) * fps);
              const s = spring({ frame: local, fps, config: { damping: 10, stiffness: 220 } });
              style.color = props.highlightColor;
              style.transform = `scale(${1 + 0.25 * Math.sin(Math.min(1, s) * Math.PI)})`;
            }
            break;
          case "box":
            if (isActive) {
              style.backgroundColor = props.boxColor;
              style.borderRadius = fontSize * 0.18;
              style.padding = `0 ${fontSize * 0.18}px`;
              style.margin = `0 ${-fontSize * 0.18}px`;
              style.WebkitTextStroke = undefined;
            }
            break;
        }
        return (
          <span key={`${token.fromMs}-${i}`} style={style}>
            {token.text.trim()}
          </span>
        );
      })}
    </div>
  );
}
