import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export interface LowerThirdProps {
  name: string;
  role?: string;
  accent?: string;
}

// TODO(module-c): slide-out animation, layout variants, theme tokens.
export function LowerThird({ name, role, accent = "#e13238" }: LowerThirdProps) {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [0, 12], [-600, 0], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", padding: 80 }}>
      <div
        style={{
          transform: `translateX(${x}px)`,
          borderLeft: `12px solid ${accent}`,
          background: "rgba(0,0,0,0.75)",
          color: "#fff",
          padding: "16px 32px",
          fontFamily: "sans-serif",
          width: "fit-content",
        }}
      >
        <div style={{ fontSize: 56, fontWeight: 700 }}>{name}</div>
        {role ? <div style={{ fontSize: 36, opacity: 0.85 }}>{role}</div> : null}
      </div>
    </AbsoluteFill>
  );
}
