import { useCurrentFrame, useVideoConfig } from "remotion";
import { fontStack } from "../fonts.js";
import { unitScale } from "../lib/anim.js";
import type { ProgressBarProps } from "../schemas/progress-bar.js";
import { Backdrop } from "./common.js";

/** Progress bar overlay; chapters split the track and can show the current chapter label. */
export function ProgressBar(props: ProgressBarProps) {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const u = unitScale(width, height);
  const total = durationInFrames / fps;
  const t = frame / fps;
  const progress = Math.min(1, (frame + 1) / durationInFrames);
  const thickness = props.thickness * u;
  const margin = (props.marginPct / 100) * width;
  const radius = props.rounded ? thickness / 2 : 0;

  const chapters = [...props.chapters]
    .filter((c) => c.startSec < total)
    .sort((a, b) => a.startSec - b.startSec);
  const bounds = chapters.map((c, i) => ({
    label: c.label,
    start: c.startSec / total,
    end: (chapters[i + 1]?.startSec ?? total) / total,
  }));
  const current = chapters.filter((c) => c.startSec <= t).at(-1);
  const segments = bounds.length > 0 ? bounds : [{ label: "", start: 0, end: 1 }];
  const gap = bounds.length > 1 ? 6 * u : 0;

  return (
    <Backdrop color={props.background}>
      <div
        style={{
          position: "absolute",
          left: margin,
          right: margin,
          [props.position]: margin,
          display: "flex",
          flexDirection: props.position === "top" ? "column" : "column-reverse",
          gap: 10 * u,
        }}
      >
        <div style={{ display: "flex", gap, height: thickness }}>
          {segments.map((s, i) => {
            const fill = Math.min(1, Math.max(0, (progress - s.start) / (s.end - s.start)));
            return (
              <div
                key={i}
                style={{
                  flex: s.end - s.start,
                  background: props.trackColor,
                  borderRadius: radius,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${fill * 100}%`,
                    height: "100%",
                    background: props.color,
                    borderRadius: radius,
                  }}
                />
              </div>
            );
          })}
        </div>
        {props.showLabel && current ? (
          <div
            style={{
              fontFamily: fontStack(props.fontFamily),
              fontWeight: 700,
              fontSize: 34 * u,
              color: props.labelColor,
              textShadow: `0 ${2 * u}px ${8 * u}px rgba(0,0,0,0.6)`,
            }}
          >
            {current.label}
          </div>
        ) : null}
      </div>
    </Backdrop>
  );
}
