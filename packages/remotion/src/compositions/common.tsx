import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill } from "remotion";

/** Full-frame layer with an optional background ("transparent" keeps alpha). */
export function Backdrop({
  color,
  children,
  style,
}: {
  color: string;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <AbsoluteFill
      style={{ backgroundColor: color === "transparent" ? undefined : color, ...style }}
    >
      {children}
    </AbsoluteFill>
  );
}
