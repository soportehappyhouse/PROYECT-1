"use client";

import type { ProjectSummary } from "@studio/shared";
import { ChevronDown, Copy, FilePlus2, FolderOpen, Pencil, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorNotice, Spinner } from "@/components/ui/misc";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { errorMessage, fileUrl } from "@/lib/api";
import { projectsApi } from "@/lib/api-projects";
import { formatTime } from "@/lib/format";
import { displayKeys } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { newProjectNow, openProjectById } from "./actions";

/** «hace 5 min», «ayer 18:40», «3 oct 2026». */
export function relativeDateEs(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "recién";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
  const d = new Date(t);
  if (s < 2 * 86_400)
    return `ayer ${d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" });
}

/** Header button with the project name: opens the projects list (Ctrl+O). */
export function ProjectsButton() {
  const name = useProjectStore((s) => s.project.name);
  const keys = useSettingsStore((s) => s.shortcuts["project.open"]);
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="projects-button"
      className="max-w-56 gap-1 px-2 font-normal"
      tooltip={`Proyectos: abrir, renombrar, duplicar o crear otro${keys ? ` (${displayKeys(keys)})` : ""}`}
      onClick={() => useSettingsStore.getState().setProjectsOpen(true)}
    >
      <span className="truncate" data-testid="project-name">
        {name}
      </span>
      <ChevronDown className="opacity-60" />
    </Button>
  );
}

function ProjectRow({
  p,
  current,
  onChanged,
}: {
  p: ProjectSummary;
  current: boolean;
  onChanged: (closeAfter?: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const rename = async () => {
    const next = name.trim();
    setEditing(false);
    if (!next || next === p.name) return setName(p.name);
    setBusy(true);
    try {
      // The open project renames through the store too (one undo step; autosave follows).
      if (current) useProjectStore.getState().renameProject(next);
      await projectsApi.rename(p.id, { name: next });
      toast.success(`Renombrado a «${next}»`);
      onChanged();
    } catch (err) {
      setName(p.name);
      toast.error("No se pudo renombrar", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    setBusy(true);
    try {
      if (current) await saveProjectNow();
      const copy = await projectsApi.duplicate(p.id);
      toast.success(`Copia creada: «${copy.name}»`);
      onChanged();
    } catch (err) {
      toast.error("No se pudo duplicar", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await projectsApi.remove(p.id);
      toast.success(`Borraste «${p.name}»`);
      if (current) await newProjectNow();
      onChanged();
    } catch (err) {
      toast.error("No se pudo borrar", { description: errorMessage(err) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li
      data-testid="project-row"
      data-project-id={p.id}
      className={cn(
        "flex items-center gap-3 rounded-md border p-2",
        current && "border-primary/60 bg-primary/5",
      )}
    >
      <button
        type="button"
        className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted"
        aria-label={`Abrir «${p.name}»`}
        onClick={() => void openProjectById(p.id).then((ok) => ok && onChanged(true))}
      >
        {p.thumbnailPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(p.thumbnailPath)} alt="" className="size-full object-cover" />
        ) : (
          <FolderOpen className="size-5 text-muted-foreground" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            aria-label="Nuevo nombre del proyecto"
            value={name}
            maxLength={120}
            className="h-7 text-sm"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(p.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <p className="truncate text-sm font-medium" title={p.name}>
            {p.name}
            {current ? <span className="ml-2 text-xs text-primary">(abierto)</span> : null}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {relativeDateEs(p.updatedAt)} · {formatTime(p.durationS, 0)} · {p.clips} clip
          {p.clips === 1 ? "" : "s"} · {p.width}×{p.height}
        </p>
        {confirming ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" role="alert">
            <span>¿Borrar «{p.name}»? No se puede deshacer (los medios quedan).</span>
            <Button size="xs" variant="destructive" disabled={busy} onClick={() => void remove()}>
              Sí, borrar
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {!current ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void openProjectById(p.id).then((ok) => ok && onChanged(true))}
          >
            Abrir
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Renombrar «${p.name}»`}
          tooltip="Cambiarle el nombre al proyecto (Enter guarda, Esc cancela)"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          <Pencil />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Duplicar «${p.name}»`}
          tooltip="Hacer una copia para probar otra versión sin tocar esta"
          disabled={busy}
          onClick={() => void duplicate()}
        >
          <Copy />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Borrar «${p.name}»`}
          tooltip="Borrar el proyecto (pide confirmación; los medios no se borran)"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

/** Sprint 5 (H7): «Proyectos» dialog (Ctrl+O): recent projects, search, open, rename… */
export function ProjectsDialog() {
  const open = useSettingsStore((s) => s.projectsOpen);
  const currentId = useProjectStore((s) => s.project.id);
  const [list, setList] = useState<ProjectSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const close = useCallback(() => useSettingsStore.getState().setProjectsOpen(false), []);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setList(await projectsApi.list());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    // The open project goes first with its latest name: save it before listing.
    const pending = useProjectStore.getState().saveState === "dirty" ? saveProjectNow() : undefined;
    void Promise.resolve(pending)
      .catch(() => undefined)
      .finally(() => void load());
  }, [open, load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
  }, [list, q]);

  const onChanged = (closeAfter?: boolean) => {
    if (closeAfter) close();
    else void load();
  };

  return (
    <Dialog open={open} onClose={close} title="Proyectos" className="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Buscar proyectos"
              placeholder="Buscar por nombre…"
              className="h-8 pl-7 text-sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            onClick={() => {
              close();
              void newProjectNow();
            }}
          >
            <FilePlus2 /> Proyecto nuevo
          </Button>
        </div>
        {error ? (
          <ErrorNotice
            message={`No se pudo leer la lista de proyectos: ${error}`}
            action={
              <Button size="xs" variant="outline" className="mt-1" onClick={() => void load()}>
                Reintentar
              </Button>
            }
          />
        ) : null}
        {!list && !error ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : null}
        {list && shown.length === 0 ? (
          <EmptyState>
            {q ? `Ningún proyecto se llama «${q}».` : "Todavía no hay proyectos guardados."}
          </EmptyState>
        ) : null}
        <ul className="flex flex-col gap-1.5" aria-label="Lista de proyectos">
          {shown.map((p) => (
            <ProjectRow key={p.id} p={p} current={p.id === currentId} onChanged={onChanged} />
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Abrir otro proyecto guarda antes el actual. Borrar un proyecto no borra sus medios.
        </p>
      </div>
    </Dialog>
  );
}
