import type { SubtitleSegment } from "@studio/shared";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

export interface AnimatedSubtitlesProps {
  segments: SubtitleSegment[];
  highlightColor?: string;
  fontSize?: number;
}

// TODO(module-c): word-level highlight using segment.words, pop-in animation, safe areas for 9:16.
export function AnimatedSubtitles({ segments, fontSize = 72 }: AnimatedSubtitlesProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const current = segments.find((s) => t >= s.start && t < s.end);

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 120 }}>
      {current ? (
        <div style={{ color: "#fff", fontSize, fontFamily: "sans-serif", textAlign: "center" }}>
          {current.text}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}
