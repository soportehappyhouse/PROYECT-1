import {
  createSmoothSvgPath,
  useAudioData,
  visualizeAudio,
  visualizeAudioWaveform,
} from "@remotion/media-utils";
import { Audio, random, useCurrentFrame, useVideoConfig } from "remotion";
import { fontStack } from "../fonts.js";
import { unitScale } from "../lib/anim.js";
import type { AudioVisualizerProps } from "../schemas/audio-visualizer.js";
import { Backdrop } from "./common.js";

/** Smallest power of two >= n (visualizeAudio requirement). */
const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

/** Spectrum (0..1 per bar) or waveform (-1..1 per point) for the current frame. */
type Levels = { spectrum: number[]; wave: number[] };

function useAudioLevels(src: string, bars: number, sensitivity: number): Levels | null {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audioData = useAudioData(src);
  if (!audioData) return null;
  const raw = visualizeAudio({
    audioData,
    frame,
    fps,
    numberOfSamples: pow2(bars * 2),
    smoothing: true,
    optimizeFor: "speed",
  });
  // Low frequencies carry most energy: use the lower half, boosted logarithmically.
  const spectrum = raw
    .slice(0, bars)
    .map((v) => Math.min(1, Math.log10(1 + v * 90 * sensitivity) / 2));
  const wave = visualizeAudioWaveform({
    audioData,
    frame,
    fps,
    windowInSeconds: 1 / 4,
    numberOfSamples: Math.max(16, bars * 2),
  }).map((v) => Math.max(-1, Math.min(1, v * sensitivity * 2)));
  return { spectrum, wave };
}

/** Deterministic fake levels when no audio is attached (previews, thumbnails). */
function syntheticLevels(frame: number, bars: number): Levels {
  const spectrum = Array.from({ length: bars }, (_, i) => {
    const base = 0.35 + 0.3 * Math.sin(frame / 6 + i * 0.45) * Math.cos(frame / 11 + i * 0.2);
    return Math.min(1, Math.max(0.05, base + 0.25 * random(`b${i}-${Math.floor(frame / 3)}`)));
  });
  const wave = Array.from(
    { length: bars * 2 },
    (_, i) => 0.6 * Math.sin(i / 3 + frame / 4) * Math.sin(frame / 13 + i / 17),
  );
  return { spectrum, wave };
}

function Bars({ levels, props }: { levels: Levels; props: AudioVisualizerProps }) {
  const { width, height } = useVideoConfig();
  const mirror = props.style === "mirror-bars";
  const areaW = width * 0.8;
  const gap = (areaW / props.bars) * 0.25;
  const barW = areaW / props.bars - gap;
  const maxH = height * (mirror ? 0.25 : 0.4);
  return (
    <div
      style={{
        display: "flex",
        alignItems: mirror ? "center" : "flex-end",
        justifyContent: "center",
        gap,
        height: mirror ? maxH * 2 : maxH,
        width: areaW,
      }}
    >
      {levels.spectrum.map((v, i) => {
        const h = Math.max(4, v * maxH) * (mirror ? 2 : 1);
        return (
          <div
            key={i}
            style={{
              width: barW,
              height: h,
              borderRadius: barW / 2,
              background: `linear-gradient(to top, ${props.color}, ${props.secondaryColor})`,
            }}
          />
        );
      })}
    </div>
  );
}

function Wave({ levels, props }: { levels: Levels; props: AudioVisualizerProps }) {
  const { width, height } = useVideoConfig();
  const w = width * 0.8;
  const h = height * 0.4;
  const points = levels.wave.map((v, i) => ({
    x: (i / Math.max(1, levels.wave.length - 1)) * w,
    y: h / 2 + v * (h / 2) * 0.9,
  }));
  const u = unitScale(width, height);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <defs>
        <linearGradient id="wave-grad" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor={props.color} />
          <stop offset="100%" stopColor={props.secondaryColor} />
        </linearGradient>
      </defs>
      <path
        d={createSmoothSvgPath({ points })}
        fill="none"
        stroke="url(#wave-grad)"
        strokeWidth={8 * u}
        strokeLinecap="round"
      />
    </svg>
  );
}

function Scene({ levels, props }: { levels: Levels | null; props: AudioVisualizerProps }) {
  const { width, height } = useVideoConfig();
  const u = unitScale(width, height);
  const font = fontStack(props.fontFamily);
  return (
    <Backdrop
      color={props.background}
      style={{ justifyContent: "center", alignItems: "center", gap: 48 * u }}
    >
      {props.title ? (
        <div style={{ textAlign: "center", fontFamily: font, color: "#fff" }}>
          <div style={{ fontSize: 96 * u, fontWeight: 900 }}>{props.title}</div>
          {props.subtitle ? (
            <div style={{ fontSize: 44 * u, opacity: 0.75, fontWeight: 400 }}>{props.subtitle}</div>
          ) : null}
        </div>
      ) : null}
      {levels ? (
        props.style === "wave" ? (
          <Wave levels={levels} props={props} />
        ) : (
          <Bars levels={levels} props={props} />
        )
      ) : null}
    </Backdrop>
  );
}

function WithAudio({ src, props }: { src: string; props: AudioVisualizerProps }) {
  const levels = useAudioLevels(src, props.bars, props.sensitivity);
  return (
    <>
      <Audio src={src} />
      <Scene levels={levels} props={props} />
    </>
  );
}

/** Bars / wave driven by @remotion/media-utils (inspired by template-music-visualization). */
export function AudioVisualizer(props: AudioVisualizerProps) {
  const frame = useCurrentFrame();
  if (props.audioSrc) return <WithAudio src={props.audioSrc} props={props} />;
  return <Scene levels={syntheticLevels(frame, props.bars)} props={props} />;
}
