"use client";

import {
  libraryRole,
  type LibraryItem,
  type LibraryItemKind,
  type LibraryProvider,
  type Paginated,
} from "@studio/shared";
import { Pause, Play, Plus, RefreshCw, Search, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Spinner,
} from "@/components/ui/misc";
import { useApiResource } from "@/hooks/use-api-resource";
import { api, errorMessage, fileUrl, isNotImplemented } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { useMediaStore } from "@/stores/media-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";

const KIND_LABELS: Record<LibraryItemKind, string> = {
  sfx: "Efectos",
  music: "Música",
  ambience: "Ambiente",
};

function previewSrc(item: LibraryItem): string | undefined {
  return item.previewUrl ?? (item.path ? fileUrl(item.path) : undefined);
}

export function LibraryPanel() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LibraryItemKind | "">("");
  const [provider, setProvider] = useState<LibraryProvider>("local");
  const [page, setPage] = useState(1);
  const [playingId, setPlayingId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const providers = useApiResource(() => api.libraryProviders());
  const results = useApiResource<Paginated<LibraryItem>>(
    () => api.searchLibrary({ q: query, ...(kind ? { kind } : {}), provider, page, pageSize: 30 }),
    `${query}|${kind}|${provider}|${page}`,
  );

  // Debounce typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => () => audioRef.current?.pause(), []);

  const togglePreview = (item: LibraryItem) => {
    const src = previewSrc(item);
    if (!src) return;
    if (playingId === item.id) {
      audioRef.current?.pause();
      setPlayingId(undefined);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(src);
    audio.onended = () => setPlayingId(undefined);
    void audio.play().catch(() => toast.error("No se pudo reproducir la vista previa"));
    audioRef.current = audio;
    setPlayingId(item.id);
  };

  const addToTimeline = async (item: LibraryItem) => {
    setBusyId(item.id);
    try {
      const asset = await api.importLibraryItem(item.provider, item.id);
      useMediaStore.getState().upsert(asset);
      // Integration (M3 ↔ M2): music/ambience → «Música» track (auto ducking), the rest «Efectos».
      useProjectStore.getState().addAssetClip(asset, { role: libraryRole(item.kind) });
      toast.success(`Añadido: ${item.name}`);
    } catch (err) {
      if (isNotImplemented(err)) toast.info("Importar desde la biblioteca: módulo en desarrollo");
      else toast.error("No se pudo añadir", { description: errorMessage(err) });
    } finally {
      setBusyId(undefined);
    }
  };

  const rescan = async () => {
    setScanning(true);
    try {
      const r = await api.scanLibrary();
      toast.success("Biblioteca re-escaneada", {
        description: `${r.added} nuevos, ${r.updated} actualizados, ${r.removed} quitados${
          r.errors.length ? `, ${r.errors.length} con error` : ""
        }`,
      });
      results.reload();
    } catch (err) {
      toast.error("No se pudo re-escanear", { description: errorMessage(err) });
    } finally {
      setScanning(false);
    }
  };

  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      try {
        const item = await api.uploadLibraryFile(file);
        toast.success(`En la biblioteca: ${item.name}`);
      } catch (err) {
        toast.error(`No se pudo subir ${file.name}`, { description: errorMessage(err) });
      }
    }
    if (fileRef.current) fileRef.current.value = "";
    results.reload();
  };

  const data = results.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const toolbar = (
    <div className="flex w-full flex-wrap items-center gap-1">
      <div className="relative min-w-32 flex-1">
        <Search className="pointer-events-none absolute top-1.5 left-1.5 size-3.5 text-muted-foreground" />
        <Input
          aria-label="Buscar sonidos"
          placeholder="Buscar sonidos y música…"
          className="h-6 pl-6 text-xs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <Select
        aria-label="Tipo"
        className="h-6 w-auto text-xs"
        value={kind}
        onChange={(e) => setKind(e.target.value as LibraryItemKind | "")}
      >
        <option value="">Todo</option>
        {Object.entries(KIND_LABELS).map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Proveedor"
        className="h-6 w-auto text-xs"
        value={provider}
        onChange={(e) => setProvider(e.target.value as LibraryProvider)}
      >
        <option value="local">Local</option>
        {(providers.data ?? [])
          .filter((p) => p.id !== "local")
          .map((p) => (
            <option key={p.id} value={p.id} disabled={!p.enabled}>
              {p.id}
              {p.enabled ? "" : " (sin API key)"}
            </option>
          ))}
      </Select>
      <Button
        size="xs"
        variant="outline"
        disabled={scanning}
        onClick={() => void rescan()}
        title="Volver a indexar storage/library"
      >
        {scanning ? <Spinner className="size-3" /> : <RefreshCw />}
        Re-escanear
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Subir sonidos a la biblioteca"
        tip="libUpload"
        onClick={() => fileRef.current?.click()}
      >
        <Upload />
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
    </div>
  );

  return (
    <Panel title="Biblioteca" toolbar={toolbar}>
      {results.status === "loading" ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : null}
      {results.status === "not-implemented" ? (
        <NotImplementedNotice what="La búsqueda en la biblioteca" />
      ) : null}
      {results.status === "error" && results.error ? <ErrorNotice message={results.error} /> : null}
      {results.status === "ready" && data && data.items.length === 0 ? (
        <EmptyState>Sin resultados.</EmptyState>
      ) : null}
      <ul className="flex flex-col gap-1">
        {data?.items.map((item) => (
          <li
            key={`${item.provider}:${item.id}`}
            className="flex items-center gap-2 rounded-md border p-1.5"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={playingId === item.id ? "Detener vista previa" : `Escuchar ${item.name}`}
              tip="libPlay"
              disabled={!previewSrc(item)}
              disabledReason="Este sonido no tiene muestra para escuchar"
              onClick={() => togglePreview(item)}
            >
              {playingId === item.id ? <Pause /> : <Play />}
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium" title={item.name}>
                {item.name}
              </p>
              <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                <Badge tone="muted">{KIND_LABELS[item.kind]}</Badge>
                {item.durationSec !== undefined ? formatTime(item.durationSec, 1) : null}
                <span title={item.attribution}>{item.license}</span>
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Añadir ${item.name} a la línea de tiempo`}
              tip="libAdd"
              disabled={busyId === item.id}
              onClick={() => void addToTimeline(item)}
            >
              {busyId === item.id ? <Spinner className="size-3.5" /> : <Plus />}
            </Button>
          </li>
        ))}
      </ul>
      {data && totalPages > 1 ? (
        <div className="mt-2 flex items-center justify-center gap-2 text-xs">
          <Button
            size="xs"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Anterior
          </Button>
          <span>
            {page} / {totalPages}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Siguiente
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
