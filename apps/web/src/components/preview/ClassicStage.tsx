"use client";

import {
  effectiveBurnSubtitles,
  fitRect,
  subtitlesToBurn,
  videoRectAt,
  type CaptionStyle as SharedCaptionStyle,
  type Clip,
  type MediaAsset,
  type Rect,
  type SubtitleSegment,
  type Track,
} from "@studio/shared";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { assetPreviewUrl } from "@/lib/api";
import { clipAt, clipsAt, sourceTimeAt } from "@/lib/timeline";
import { useCaptionStyleStore, type CaptionStyle } from "@/stores/caption-style-store";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";

/**
 * «Vista previa clásica» (Sprint 1 renderer, kept behind a setting for safety): one <video> for
 * the top video clip plus DOM overlays for motion, text and subtitles. No keyframes, no matte.
 */

const DRIFT_TOLERANCE = 0.25;

/** A <video>/<audio> element kept in sync with the timeline playhead. */
function SyncedMedia({
  kind,
  clip,
  track,
  asset,
  className,
  style,
}: {
  kind: "video" | "audio";
  clip: Clip;
  track: Track;
  asset: MediaAsset;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);
  const playhead = useProjectStore((s) => s.playhead);
  // J (backwards) cannot use <video> playback: the element stays paused and follows the playhead.
  const playing = useProjectStore((s) => s.playing && s.playbackRate > 0);
  const rate = useProjectStore((s) => Math.abs(s.playbackRate));
  const target = Math.max(0, sourceTimeAt(clip, playhead));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.playbackRate = clip.speed * rate;
    el.volume = Math.min(1, Math.max(0, clip.volume));
    el.muted = track.muted;
  }, [clip.speed, clip.volume, track.muted, rate]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (playing) {
      if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE) el.currentTime = target;
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.01) el.currentTime = target;
    }
  }, [playing, target]);

  const src = assetPreviewUrl(asset);
  return kind === "video" ? (
    <>
      <video
        ref={ref}
        src={src}
        className={className}
        preload="auto"
        playsInline
        style={{ ...style, opacity: clip.opacity }}
        onError={() => setFailed(true)}
        onLoadedData={() => setFailed(false)}
      />
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-neutral-400">
          El navegador no puede reproducir «{asset.name}». Genera un proxy desde el panel Media.
        </div>
      ) : null}
    </>
  ) : (
    <audio ref={ref} src={src} preload="auto" />
  );
}

function positionClass(position: "top" | "center" | "bottom"): string {
  return position === "top"
    ? "items-start pt-[6%]"
    : position === "center"
      ? "items-center"
      : "items-end pb-[6%]";
}

/** CSS box (% of the stage) of a rect in canvas pixels. */
function rectStyle(r: Rect, width: number, height: number): CSSProperties {
  return {
    left: `${(r.x / width) * 100}%`,
    top: `${(r.y / height) * 100}%`,
    width: `${(r.width / width) * 100}%`,
    height: `${(r.height / height) * 100}%`,
  };
}

/**
 * Feedback 7: where a video/motion clip lands (Clip.scale / Clip.position, same math as the
 * export's PiP builder). Full-frame clips keep the old object-contain layout.
 */
function placementStyle(
  clip: Clip,
  asset: MediaAsset | undefined,
  width: number,
  height: number,
): CSSProperties | undefined {
  if (clip.scale === undefined && !clip.position) return undefined;
  const media =
    asset?.width && asset.height ? { width: asset.width, height: asset.height } : undefined;
  const r = fitRect({ width, height }, media, clip);
  return { ...rectStyle(r, width, height), objectFit: "fill" };
}

function SubtitleOverlay({
  segment,
  style,
  scale,
  playhead,
  box,
}: {
  segment: SubtitleSegment;
  style: CaptionStyle | SharedCaptionStyle;
  /** Pixels on screen per canvas pixel × caption unit of the video rect. */
  scale: number;
  playhead: number;
  /** Video rect (feedback 4: captions fit the video, like the export). */
  box: CSSProperties;
}) {
  const words = segment.words;
  return (
    <div
      className={`pointer-events-none absolute flex justify-center px-[5%] ${positionClass(style.position)}`}
      style={box}
    >
      <span
        className="rounded px-2 py-1 text-center leading-tight font-bold"
        style={{
          fontFamily: style.fontFamily,
          fontSize: style.fontSize * scale,
          color: style.color,
          background: style.background || undefined,
          textTransform: style.uppercase ? "uppercase" : undefined,
          textShadow: style.background ? undefined : "0 2px 6px rgba(0,0,0,.8)",
        }}
      >
        {words && words.length > 0 && style.animation !== "none"
          ? words.map((w, i) => (
              <span
                key={i}
                style={{
                  color: playhead >= w.start && playhead < w.end ? style.highlightColor : undefined,
                }}
              >
                {w.word}
                {i < words.length - 1 && !/^\s/.test(words[i + 1]!.word) ? " " : ""}
              </span>
            ))
          : segment.text}
      </span>
    </div>
  );
}

export function ClassicStage({ scale }: { scale: number }) {
  const project = useProjectStore((s) => s.project);
  const playhead = useProjectStore((s) => s.playhead);
  const assets = useMediaStore((s) => s.assets);
  const localCaptionStyle = useCaptionStyleStore((s) => s.style);
  const captionStyle = project.captionStyle ?? localCaptionStyle;
  const { width, height } = project.settings;
  const video = clipAt(project, playhead, ["video"]);
  const videoAsset = video?.clip.assetId ? assets[video.clip.assetId] : undefined;
  // Every motion clip under the playhead, bottom track first (feedback 1/5: overlapping overlays
  // live on separate tracks). Renders added from Media use assetId, linked ones renderedAssetId.
  const motions = clipsAt(project, playhead, ["motion"])
    .map((m) => {
      const id = m.clip.renderedAssetId ?? m.clip.assetId;
      return { ...m, asset: id ? assets[id] : undefined };
    })
    .reverse();
  const texts = clipsAt(project, playhead, ["text"]);
  const audios = clipsAt(project, playhead, ["audio"]).filter(
    (a) => a.clip.assetId && assets[a.clip.assetId],
  );
  // Feedback 2: same rule as the export (burn choice + no segment under animated captions).
  const burned = useMemo(
    () => subtitlesToBurn(project, effectiveBurnSubtitles(project)),
    [project],
  );
  const subtitle = burned.find((s) => playhead >= s.start && playhead < s.end);
  const mediaSize = (id: string) => {
    const a = assets[id];
    return a?.width && a.height ? { width: a.width, height: a.height } : undefined;
  };
  const captionRect = subtitle ? videoRectAt(project, mediaSize, playhead) : undefined;
  return (
    <>
      {video && videoAsset ? (
        <SyncedMedia
          key={video.clip.id}
          kind="video"
          clip={video.clip}
          track={video.track}
          asset={videoAsset}
          className="absolute inset-0 size-full object-contain"
          style={placementStyle(video.clip, videoAsset, width, height)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">
          {video ? "El medio del clip no está disponible" : "Sin video en el cursor"}
        </div>
      )}
      {motions.map(({ clip, track, asset }) =>
        asset ? (
          <SyncedMedia
            key={clip.id}
            kind="video"
            clip={clip}
            track={track}
            asset={asset}
            className="pointer-events-none absolute inset-0 size-full object-contain"
            style={placementStyle(clip, asset, width, height)}
          />
        ) : (
          <div
            key={clip.id}
            className="pointer-events-none absolute inset-x-[10%] top-[10%] rounded border border-dashed border-fuchsia-400 bg-fuchsia-500/20 p-2 text-center text-xs text-white"
          >
            Motion «{clip.motion?.template ?? "?"}» — pendiente de render
          </div>
        ),
      )}
      {texts.map(({ clip }) => {
        const ts = clip.textStyle;
        return (
          <div
            key={clip.id}
            className={`pointer-events-none absolute inset-0 flex justify-center px-[5%] ${positionClass(ts?.position ?? "bottom")}`}
            style={{ opacity: clip.opacity }}
          >
            <span
              className="rounded px-2 text-center font-semibold whitespace-pre-wrap"
              style={{
                fontFamily: ts?.fontFamily,
                fontSize: (ts?.fontSize ?? 64) * scale,
                color: ts?.color ?? "#fff",
                background: ts?.background,
                textShadow: ts?.background ? undefined : "0 2px 6px rgba(0,0,0,.8)",
              }}
            >
              {clip.text}
            </span>
          </div>
        );
      })}
      {subtitle && captionRect ? (
        <SubtitleOverlay
          segment={subtitle}
          style={captionStyle}
          scale={(scale * Math.min(captionRect.width, captionRect.height)) / 1080}
          playhead={playhead}
          box={rectStyle(captionRect, width, height)}
        />
      ) : null}
      {audios.map(({ clip, track }) => (
        <SyncedMedia
          key={clip.id}
          kind="audio"
          clip={clip}
          track={track}
          asset={assets[clip.assetId!]!}
        />
      ))}
    </>
  );
}
