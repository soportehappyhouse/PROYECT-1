import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface TitleProps {
  title: string;
  subtitle?: string;
  color?: string;
  background?: string;
}

// TODO(module-c): typography presets, exit animation, transparent background option.
export function Title({ title, subtitle, color = "#ffffff", background = "#111111" }: TitleProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 200 } });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{ backgroundColor: background, justifyContent: "center", alignItems: "center" }}
    >
      <div style={{ transform: `scale(${scale})`, opacity, color, textAlign: "center" }}>
        <h1 style={{ fontSize: 120, margin: 0, fontFamily: "sans-serif" }}>{title}</h1>
        {subtitle ? <p style={{ fontSize: 48, fontFamily: "sans-serif" }}>{subtitle}</p> : null}
      </div>
    </AbsoluteFill>
  );
}
