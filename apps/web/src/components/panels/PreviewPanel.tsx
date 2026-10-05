"use client";

import {
  Crop,
  Crosshair,
  Eraser,
  Pause,
  Play,
  Scan,
  Settings2,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClassicStage } from "@/components/preview/ClassicStage";
import { CompositorStage } from "@/components/preview/CompositorStage";
import { PreviewOverlay } from "@/components/preview/PreviewOverlay";
import { ReframePanel } from "@/components/preview/ReframePanel";
import { MaskToolbar, startTool, TrackBoxBanner } from "@/components/preview/VisionTools";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/menu";
import { formatTime } from "@/lib/format";
import { findClip, projectDuration } from "@/lib/timeline";
import { useMaskStore } from "@/stores/mask-store";
import { usePreviewStore, type PreviewQuality } from "@/stores/preview-store";
import { useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";
import { Panel } from "./Panel";

const QUALITY_LABELS: Record<PreviewQuality, string> = {
  auto: "Automática (baja a proxy si va lenta)",
  original: "Original",
  proxy: "Proxy (más fluida)",
};

const DEV = process.env.NODE_ENV !== "production";

function PerfHud() {
  const perf = usePreviewStore((s) => s.perf);
  return (
    <div
      data-testid="perf-hud"
      className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-lime-300"
    >
      {perf.fps.toFixed(1)} fps · {perf.drawMs.toFixed(1)} ms · {perf.layers} capas ·{" "}
      {perf.clock === "driver" ? "reloj: video" : "reloj: rAF"}
      {perf.usingProxy ? " · proxy" : ""}
    </div>
  );
}

function OptionsMenu() {
  const s = usePreviewStore();
  return (
    <Menu
      label="Opciones de la vista previa"
      trigger={(p) => (
        <Button variant="ghost" size="icon-sm" aria-label="Opciones de la vista previa" {...p}>
          <Settings2 />
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            checked={s.safeGuides}
            onSelect={() => {
              s.set({ safeGuides: !s.safeGuides });
              close();
            }}
          >
            Guías de zona segura
          </MenuItem>
          <MenuItem
            checked={s.classic}
            hint="sin capas"
            onSelect={() => {
              s.set({ classic: !s.classic });
              close();
            }}
          >
            Vista previa clásica
          </MenuItem>
          <MenuItem
            checked={s.hud || DEV}
            disabled={DEV}
            onSelect={() => {
              s.set({ hud: !s.hud });
              close();
            }}
          >
            Mostrar rendimiento (fps)
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Calidad</MenuLabel>
          {(Object.keys(QUALITY_LABELS) as PreviewQuality[]).map((q) => (
            <MenuItem
              key={q}
              checked={s.quality === q}
              hint={q === "auto" && s.autoProxy ? "en proxy" : undefined}
              onSelect={() => {
                s.set({ quality: q });
                close();
              }}
            >
              {QUALITY_LABELS[q]}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

export function PreviewPanel() {
  const project = useProjectStore((s) => s.project);
  const playhead = useProjectStore((s) => s.playhead);
  const playing = useProjectStore((s) => s.playing);
  const playbackRate = useProjectStore((s) => s.playbackRate);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const classic = usePreviewStore((s) => s.classic);
  const hud = usePreviewStore((s) => s.hud);
  const tool = usePreviewStore((s) => s.tool);
  const reframeOpen = usePreviewStore((s) => s.reframeOpen);
  const matteBusy = useVisionStore((s) => !!s.busy.matte);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const { width, height, fps } = project.settings;
  // Fit the project frame (letterboxed) inside the available area.
  const ratio = width / height;
  const stageW = Math.max(1, Math.min(box.w, box.h * ratio));
  const stageH = stageW / ratio;
  const scale = stageH / height;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setBox({ w: el.clientWidth || 640, h: el.clientHeight || 360 }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Leaving the multilayer preview closes its tools (the SAM session too).
  useEffect(() => {
    if (!classic) return;
    usePreviewStore.getState().setTool("none");
    void useMaskStore.getState().close();
  }, [classic]);

  const duration = projectDuration(project);
  const store = useProjectStore.getState;
  const selected = selectedClipId ? findClip(project, selectedClipId) : undefined;

  const toolbar = (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Ir al inicio"
        shortcut="playback.toStart"
        onClick={() => store().setPlayhead(0)}
      >
        <SkipBack />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fotograma anterior"
        shortcut="playback.frameBack"
        onClick={() => store().setPlayhead(playhead - 1 / fps)}
      >
        <StepBack />
      </Button>
      <Button
        size="icon-sm"
        aria-label={playing ? "Pausar" : "Reproducir"}
        shortcut="playback.toggle"
        onClick={() => store().togglePlaying()}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fotograma siguiente"
        shortcut="playback.frameForward"
        onClick={() => store().setPlayhead(playhead + 1 / fps)}
      >
        <StepForward />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Ir al final"
        shortcut="playback.toEnd"
        onClick={() => {
          store().setPlaying(false);
          store().setPlayhead(duration);
        }}
      >
        <SkipForward />
      </Button>
      {playing && playbackRate !== 1 ? (
        <span className="font-mono text-[11px] text-primary">
          {playbackRate > 0 ? "▶" : "◀"} {Math.abs(playbackRate)}×
        </span>
      ) : null}
      {!classic ? (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button
            variant={tool === "mask" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Máscara (SAM 2)"
            aria-pressed={tool === "mask"}
            tooltip="Máscara: clic + / − sobre el objeto del cuadro actual"
            onClick={() => {
              if (tool === "mask") {
                void useMaskStore.getState().close();
                usePreviewStore.getState().setTool("none");
              } else startTool("mask");
            }}
          >
            <Scan />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Quitar fondo"
            disabled={!selected || selected.track.kind !== "video" || matteBusy}
            tooltip={
              selected?.track.kind === "video"
                ? "Quitar fondo del clip elegido"
                : "Elegí un clip de video o imagen"
            }
            onClick={() =>
              selected && useVisionStore.getState().openMatte({ clipId: selected.clip.id })
            }
          >
            <Eraser />
          </Button>
          <Button
            variant={tool === "track-box" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Seguir objeto"
            aria-pressed={tool === "track-box"}
            tooltip="Seguir objeto: dibujá una caja sobre el video"
            onClick={() =>
              tool === "track-box"
                ? usePreviewStore.getState().setTool("none")
                : startTool("track-box")
            }
          >
            <Crosshair />
          </Button>
          <Button
            variant={reframeOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Reencuadrar"
            aria-pressed={reframeOpen}
            tooltip="Reencuadrar a 9:16 / 1:1 / 4:5"
            onClick={() => usePreviewStore.getState().setReframeOpen(!reframeOpen)}
          >
            <Crop />
          </Button>
        </>
      ) : null}
      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
        {formatTime(playhead)} / {formatTime(duration)} · {width}×{height} · {fps} fps
      </span>
      <OptionsMenu />
    </>
  );

  return (
    <Panel title="Vista previa" toolbar={toolbar} bare>
      {!classic && tool === "mask" ? <MaskToolbar /> : null}
      {!classic && tool === "track-box" ? <TrackBoxBanner /> : null}
      <div className="relative min-h-0 flex-1 bg-neutral-950 p-2">
        <div ref={boxRef} className="flex size-full items-center justify-center">
          <div
            data-testid="preview-stage"
            data-renderer={classic ? "classic" : "compositor"}
            className="relative shrink-0 overflow-hidden bg-black"
            style={{ width: stageW, height: stageH }}
          >
            {classic ? (
              <ClassicStage scale={scale} />
            ) : (
              <>
                <CompositorStage width={stageW} height={stageH} />
                <PreviewOverlay />
                {hud || DEV ? <PerfHud /> : null}
              </>
            )}
          </div>
        </div>
        {!classic && reframeOpen ? <ReframePanel /> : null}
      </div>
    </Panel>
  );
}
