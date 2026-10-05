"use client";

import { useDraggable } from "@dnd-kit/core";
import type { MediaAsset } from "@studio/shared";
import {
  FileAudio,
  FileVideo,
  Image as ImageIcon,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Progress,
  Spinner,
} from "@/components/ui/misc";
import { api, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { formatBytes, formatTime } from "@/lib/format";
import { createId } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";

const ACCEPT = "video/*,audio/*,image/*,.srt,.vtt,.json,.lottie";

/** Payload carried by draggable media items (consumed by the timeline drop handler). */
export interface AssetDragData {
  type: "asset";
  asset: MediaAsset;
}

export async function uploadFiles(files: FileList | File[]): Promise<void> {
  const media = useMediaStore.getState();
  for (const file of Array.from(files)) {
    const id = createId("up");
    media.setUpload({ id, name: file.name, progress: 0 });
    try {
      const asset = await api.uploadMedia(file, (progress) =>
        useMediaStore.getState().setUpload({ id, name: file.name, progress }),
      );
      useMediaStore.getState().upsert(asset);
      useMediaStore.getState().clearUpload(id);
      toast.success(`Importado: ${asset.name}`);
    } catch (err) {
      useMediaStore.getState().clearUpload(id);
      if (isNotImplemented(err)) toast.info("Importar medios: módulo en desarrollo");
      else toast.error(`No se pudo importar ${file.name}`, { description: errorMessage(err) });
    }
  }
}

function KindIcon({ kind }: { kind: MediaAsset["kind"] }) {
  if (kind === "audio") return <FileAudio className="size-6 text-emerald-500" />;
  if (kind === "image") return <ImageIcon className="size-6 text-sky-500" />;
  return <FileVideo className="size-6 text-sky-500" />;
}

export function assetMeta(a: MediaAsset): string {
  const parts: string[] = [];
  if (a.durationSec !== undefined) parts.push(formatTime(a.durationSec, 1));
  if (a.width && a.height) parts.push(`${a.width}×${a.height}`);
  if (a.fps) parts.push(`${Math.round(a.fps * 100) / 100} fps`);
  if (a.sampleRate) parts.push(`${(a.sampleRate / 1000).toFixed(1)} kHz`);
  if (a.channels)
    parts.push(a.channels === 1 ? "mono" : a.channels === 2 ? "estéreo" : `${a.channels} canales`);
  parts.push(formatBytes(a.sizeBytes));
  return parts.join(" · ");
}

function MediaItem({ asset, selected }: { asset: MediaAsset; selected: boolean }) {
  const data: AssetDragData = { type: "asset", asset };
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `asset:${asset.id}`,
    data,
  });
  const thumb = asset.thumbnailPath ? fileUrl(asset.thumbnailPath) : undefined;
  const select = () => useProjectStore.getState().selectAsset(asset.id);

  const remove = async () => {
    try {
      await api.deleteMedia(asset.id);
      useMediaStore.getState().remove(asset.id);
    } catch (err) {
      toast.error("No se pudo eliminar", { description: errorMessage(err) });
    }
  };
  const proxy = async () => {
    try {
      const { jobId } = await api.createProxy(asset.id);
      useJobsStore.getState().track(jobId, "media.proxy", { kind: "refreshMedia" });
      toast.info("Generando proxy…");
    } catch (err) {
      toast.error("No se pudo generar el proxy", { description: errorMessage(err) });
    }
  };

  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={select}
      className={cn(
        "group flex cursor-grab items-center gap-2 rounded-md border p-1.5 hover:bg-accent",
        selected && "border-primary bg-primary/5",
        isDragging && "opacity-50",
      )}
    >
      <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by the local api, not optimizable
          <img src={thumb} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <KindIcon kind={asset.kind} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={asset.name}>
          {asset.name}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{assetMeta(asset)}</p>
        {!asset.proxyPath && asset.kind === "video" ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">Sin proxy</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 opacity-70 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Añadir ${asset.name} a la línea de tiempo`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            useProjectStore.getState().addAssetClip(asset);
          }}
        >
          <Plus />
        </Button>
        {asset.kind === "video" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Generar proxy"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void proxy();
            }}
          >
            <Wand2 />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Eliminar ${asset.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void remove();
          }}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

export function MediaPanel() {
  const { assets, order, status, error, uploads, refresh } = useMediaStore();
  const selectedAssetId = useProjectStore((s) => s.selectedAssetId);
  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (useMediaStore.getState().status === "idle") void refresh();
  }, [refresh]);

  const list = order
    .map((id) => assets[id])
    .filter((a): a is MediaAsset => !!a && a.name.toLowerCase().includes(filter.toLowerCase()));

  const toolbar = (
    <>
      <Button size="xs" onClick={() => inputRef.current?.click()}>
        <Upload /> Importar
      </Button>
      <Input
        aria-label="Filtrar medios"
        placeholder="Filtrar…"
        className="h-6 max-w-40 flex-1 text-xs"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Recargar medios"
        onClick={() => void refresh()}
      >
        <RefreshCw />
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );

  return (
    <Panel title="Media" toolbar={toolbar}>
      <div
        className={cn(
          "flex min-h-full flex-col gap-2 rounded-md",
          dragOver && "outline-2 outline-dashed outline-primary",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {uploads.map((u) => (
          <div key={u.id} className="rounded-md border p-2 text-xs">
            <p className="truncate">Subiendo {u.name}…</p>
            <Progress value={u.progress} className="mt-1" />
          </div>
        ))}
        {status === "loading" ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : null}
        {status === "not-implemented" ? (
          <NotImplementedNotice what="La biblioteca de medios" />
        ) : null}
        {status === "error" && error ? (
          <ErrorNotice
            message={error}
            action={
              <Button size="xs" variant="outline" className="mt-1" onClick={() => void refresh()}>
                Reintentar
              </Button>
            }
          />
        ) : null}
        {status === "ready" && list.length === 0 ? (
          <EmptyState>Arrastra archivos aquí o usa «Importar».</EmptyState>
        ) : null}
        <ul className="flex flex-col gap-1">
          {list.map((a) => (
            <MediaItem key={a.id} asset={a} selected={a.id === selectedAssetId} />
          ))}
        </ul>
        <p className="mt-auto pt-2 text-center text-[11px] text-muted-foreground">
          Suelta archivos para importarlos · arrastra un medio a una pista
        </p>
      </div>
    </Panel>
  );
}
