"use client";

import { AGENT_TEMPLATE_IDS, CAPTION_STYLE_IDS } from "@studio/shared";
import {
  Check,
  CircleAlert,
  CircleDashed,
  Download,
  History,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Select } from "@/components/ui/input";
import {
  Badge,
  EmptyState,
  ErrorNotice,
  NotImplementedNotice,
  Progress,
  Section,
  Spinner,
} from "@/components/ui/misc";
import {
  confirmDestructiveLabel,
  destructiveIndexes,
  editableParams,
  fallbackPreview,
  formatLatency,
  isDestructive,
  navigateHistory,
  needsConfirm,
  opArg,
  opLabel,
  opRisks,
  opRunStates,
  parseAgentTime,
  timeInputValue,
  type OpRunState,
  type ParamSpec,
} from "@/lib/agent";
import { useAiAvailability } from "@/hooks/use-ai-availability";
import { AGENT_PACK_ID, DEFAULT_AGENT_MODEL, type EditOp } from "@/lib/agent-types";
import { cn } from "@/lib/utils";
import { useAgentStore, type ApplyRun } from "@/stores/agent-store";
import { useExportPresetsStore } from "@/stores/export-presets-store";
import { useJobsStore } from "@/stores/jobs-store";
import { usePacksStore } from "@/stores/packs-store";
import { Panel } from "./Panel";

export const ASSISTANT_EXAMPLES = [
  "Cortá los silencios",
  "Subtítulos animados estilo Reels",
  "Exportá para TikTok",
  "Poné un título 'Hola' en el segundo 3",
] as const;

const STATUS_LABELS = {
  proposed: { label: "Propuesto", tone: "default" },
  applied: { label: "Aplicado", tone: "success" },
  rejected: { label: "Rechazado", tone: "muted" },
  undone: { label: "Deshecho", tone: "warning" },
} as const;

const RUN_ICONS: Record<OpRunState, React.ReactNode> = {
  pending: <CircleDashed className="size-3.5 text-muted-foreground" aria-label="En espera" />,
  running: <Spinner className="size-3.5" />,
  done: <Check className="size-3.5 text-emerald-600" aria-label="Hecha" />,
  failed: <CircleAlert className="size-3.5 text-destructive" aria-label="Falló" />,
  skipped: null,
};

/** Header line: «100 % local» badge, model, last latency and readiness. */
function ModelStatus() {
  const status = useAgentStore((s) => s.status);
  const load = useAgentStore((s) => s.statusLoad);
  const model = useAgentStore((s) => s.settings.model);
  const lastModel = useAgentStore((s) => s.lastModel);
  const latency = useAgentStore((s) => s.lastLatencyMs);
  const route = useAgentStore((s) => s.lastRoute);
  const proposing = useAgentStore((s) => s.proposing);
  const downloading = usePacksStore((s) => s.downloads[AGENT_PACK_ID]);
  const job = useJobsStore((s) => (downloading ? s.jobs[downloading] : undefined));
  const name = lastModel ?? model ?? status?.model ?? DEFAULT_AGENT_MODEL;
  const active = job && job.status !== "succeeded" && job.status !== "failed";

  let state: { label: string; tone: "success" | "warning" | "danger" | "muted" };
  if (load === "loading") state = { label: "Comprobando…", tone: "muted" };
  else if (load === "not-implemented") state = { label: "En desarrollo", tone: "warning" };
  else if (load === "error") state = { label: "Sin conexión", tone: "danger" };
  else if (!status) state = { label: "—", tone: "muted" };
  // Sprint 5 (H4): the ServiceBanner explains it; here only a short state.
  else if (status.workers === false) state = { label: "IA local apagada", tone: "danger" };
  else if (!status.ollama) state = { label: "Falta Ollama", tone: "danger" };
  else if (!status.ready) state = { label: "Falta el modelo", tone: "warning" };
  else if (proposing && status.loaded === false)
    state = { label: "Cargando modelo…", tone: "warning" };
  else state = { label: "Listo", tone: "success" };

  return (
    <div className="flex flex-col gap-1" data-testid="assistant-status">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge
          tone="success"
          title="El asistente corre en tu PC (Ollama). Tus comandos y tu proyecto no salen de esta computadora."
        >
          <ShieldCheck className="size-3" aria-hidden /> 100 % local
        </Badge>
        <span className="font-mono text-[11px]" title="Modelo">
          {name}
        </span>
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="text-[11px] text-muted-foreground">
          Última respuesta: {formatLatency(latency)}
          {route === "deterministic" ? " (regla directa, sin IA)" : ""}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Comprobar el estado del asistente"
          onClick={() => void useAgentStore.getState().loadStatus()}
        >
          <RefreshCw />
        </Button>
      </div>
      {status && (!status.ollama || !status.ready) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1 text-[11px]">
          <span className="flex-1">
            {status.hint_es ??
              (!status.ollama
                ? "Instalá Ollama (scripts\\windows\\setup.ps1 o «winget install Ollama.Ollama») y abrilo."
                : "Falta descargar el modelo del asistente (una sola vez, ~5 GB).")}
          </span>
          {status.ollama ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!!active}
              onClick={() => void usePacksStore.getState().startDownload(AGENT_PACK_ID)}
            >
              {active ? <Spinner className="size-3" /> : <Download />}
              {active ? `${Math.round((job?.progress ?? 0) * 100)} %` : "Descargar modelo"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {load === "not-implemented" ? <NotImplementedNotice what="El asistente local" /> : null}
    </div>
  );
}

/** Focus requests already handled (Ctrl+Shift+A may arrive before the panel mounts). */
let handledFocus = 0;

function CommandBox() {
  const command = useAgentStore((s) => s.command);
  const proposing = useAgentStore((s) => s.proposing);
  const history = useAgentStore((s) => s.commandHistory);
  const focusTick = useAgentStore((s) => s.focusTick);
  const { setCommand, propose } = useAgentStore.getState();
  // Sprint 5: the planner runs in the local AI (workers): disabled with the reason when it is off.
  const ai = useAiAvailability("workers");
  const inputRef = useRef<HTMLInputElement>(null);
  // Index into history while browsing with ↑/↓ (history.length = the line being typed).
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (focusTick > handledFocus) {
      handledFocus = focusTick;
      inputRef.current?.focus();
    }
  }, [focusTick]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (history.length === 0) return;
    e.preventDefault();
    const from = cursor ?? history.length;
    if (cursor === undefined) setDraft(command);
    const next = navigateHistory(history.length, from, e.key === "ArrowUp" ? -1 : 1);
    setCursor(next);
    setCommand(next === history.length ? draft : (history[next] ?? ""));
  };

  const submit = () => {
    setCursor(undefined);
    void propose();
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          ref={inputRef}
          aria-label="Comando para el asistente"
          placeholder="Escribí qué querés hacer… (↑/↓: comandos anteriores)"
          value={command}
          maxLength={2000}
          onChange={(e) => {
            setCursor(undefined);
            setCommand(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          type="submit"
          size="sm"
          tooltip="Pedirle al asistente un plan para este comando"
          disabled={proposing || !command.trim() || !ai.enabled}
          disabledReason={ai.reason_es}
        >
          {proposing ? <Spinner /> : <Sparkles />} Proponer
        </Button>
      </form>
      <div className="flex flex-wrap gap-1" aria-label="Ejemplos">
        {ASSISTANT_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              setCommand(ex);
              inputRef.current?.focus();
            }}
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function TimeField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: unknown;
  disabled: boolean;
  onCommit: (v: unknown) => void;
}) {
  const shown = timeInputValue(value) ?? "";
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (!text.trim()) {
      setBad(false);
      return onCommit(undefined);
    }
    const t = parseAgentTime(text);
    setBad(t === undefined);
    if (t !== undefined) onCommit(t);
  };
  return (
    <Input
      aria-label={label}
      className={cn("h-7 w-24 text-xs", bad && "border-destructive")}
      value={text}
      disabled={disabled}
      title="Segundos (3 o 3,5), «inicio», «final» o «cursor»"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function ParamField({
  spec,
  op,
  opName,
  disabled,
  onChange,
}: {
  spec: ParamSpec;
  op: EditOp;
  opName: string;
  disabled: boolean;
  onChange: (v: unknown) => void;
}) {
  const presets = useExportPresetsStore((s) => s.presets);
  const value = opArg(op, spec.key);
  const label = `${spec.label} (${opName})`;
  const listId = spec.suggestions ? `agent-${spec.suggestions}` : undefined;
  let field: React.ReactNode;
  if (spec.kind === "time")
    field = <TimeField label={label} value={value} disabled={disabled} onCommit={onChange} />;
  else if (spec.kind === "checkbox")
    field = (
      <Checkbox
        aria-label={label}
        checked={value === true}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  else if (spec.kind === "select") {
    const options =
      spec.options ??
      (spec.key === "style" ? CAPTION_STYLE_IDS.map((id) => ({ value: id, label: id })) : []);
    field = (
      <Select
        aria-label={label}
        className="h-7 w-32 text-xs"
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">Por defecto</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  } else if (spec.kind === "number")
    field = (
      <Input
        aria-label={label}
        type="number"
        className="h-7 w-20 text-xs"
        step={spec.step}
        min={spec.min}
        value={typeof value === "number" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  else
    field = (
      <>
        <Input
          aria-label={label}
          className={cn("h-7 text-xs", spec.key === "text" ? "w-48" : "w-32")}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          list={listId}
          onChange={(e) => onChange(e.target.value)}
        />
        {listId ? (
          <datalist id={listId}>
            {(spec.suggestions === "export-presets"
              ? presets.map((p) => p.id)
              : [...AGENT_TEMPLATE_IDS]
            ).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        ) : null}
      </>
    );
  return (
    <Label className="flex-row items-center gap-1 text-[11px] font-normal">
      {spec.label}
      {field}
    </Label>
  );
}

function OpItem({ index, run }: { index: number; run: OpRunState | undefined }) {
  const draft = useAgentStore((s) => s.draft)!;
  const op = draft.ops[index]!;
  const enabled = draft.enabled[index] ?? false;
  const unresolved = draft.record.resolved?.[index] === null;
  const locked = draft.record.status !== "proposed" || run !== undefined;
  const preview = draft.record.preview_es?.[index] ?? fallbackPreview(op);
  const name = opLabel(op);
  const { toggleOp, setParam } = useAgentStore.getState();
  return (
    <li
      className={cn("flex flex-col gap-1 rounded-md border p-2", !enabled && "opacity-60")}
      data-testid="agent-op"
    >
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5"
          aria-label={`Aplicar: ${name}`}
          checked={enabled}
          disabled={locked}
          onChange={(e) => toggleOp(index, e.target.checked)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-center gap-1 font-medium">
            {index + 1}. {name}
            {opRisks(op).map((r) => (
              <Badge key={r.label} tone={r.tone}>
                {r.label}
              </Badge>
            ))}
            {needsConfirm(op) ? null : <Badge tone="muted">Sin confirmación</Badge>}
            {isDestructive(op) && enabled && !locked ? (
              <Badge tone={draft.confirmed.includes(index) ? "success" : "danger"}>
                {draft.confirmed.includes(index) ? "Confirmada" : "Requiere confirmación"}
              </Badge>
            ) : null}
            {unresolved ? <Badge tone="danger">No se pudo ubicar</Badge> : null}
          </span>
          <span className="text-xs text-muted-foreground">{preview}</span>
          {op.note_es ? <span className="text-[11px] italic">{op.note_es}</span> : null}
        </div>
        {run ? RUN_ICONS[run] : null}
      </div>
      {editableParams(op).length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          {editableParams(op).map((spec) => (
            <ParamField
              key={spec.key}
              spec={spec}
              op={op}
              opName={name}
              disabled={locked}
              onChange={(v) => setParam(index, spec.key, v)}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function QuestionsForm() {
  const draft = useAgentStore((s) => s.draft)!;
  const proposing = useAgentStore((s) => s.proposing);
  const questions = draft.record.plan?.questions ?? [];
  if (questions.length === 0) return null;
  const { setAnswer, submitAnswers } = useAgentStore.getState();
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary/5 p-2"
      aria-label="Preguntas del asistente"
      onSubmit={(e) => {
        e.preventDefault();
        void submitAnswers();
      }}
    >
      <p className="text-xs font-medium">Antes de seguir, el asistente necesita saber:</p>
      {questions.map((q, i) => (
        <Label key={q}>
          {q}
          <Input
            value={draft.answers[i] ?? ""}
            onChange={(e) => setAnswer(i, e.target.value)}
            placeholder="Tu respuesta"
          />
        </Label>
      ))}
      <Button
        type="submit"
        size="xs"
        className="self-end"
        disabled={proposing || draft.answers.every((a) => !a.trim())}
      >
        {proposing ? <Spinner className="size-3" /> : <Send />} Responder y volver a proponer
      </Button>
    </form>
  );
}

function RunProgress({ run, total }: { run: ApplyRun; total: number }) {
  const job = useJobsStore((s) => (run.jobId ? s.jobs[run.jobId] : undefined));
  const done =
    run.status === "done" || run.status === "undone" || run.status === "undoing"
      ? 1
      : (job?.progress ?? 0);
  const label =
    run.status === "starting"
      ? "Guardando el proyecto y preparando…"
      : run.status === "running"
        ? (job?.message ?? `Aplicando ${run.selected.length} de ${total} operaciones…`)
        : run.status === "done"
          ? `Listo: ${run.result?.applied ?? run.selected.length} operación(es) aplicadas.`
          : run.status === "undoing"
            ? "Deshaciendo…"
            : run.status === "undone"
              ? "Plan deshecho."
              : `Se detuvo: ${run.error ?? "error"}`;
  return (
    <div className="flex flex-col gap-1" aria-live="polite" data-testid="agent-run">
      <Progress value={done} />
      <span
        className={cn(
          "text-[11px]",
          run.status === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function PlanView() {
  const draft = useAgentStore((s) => s.draft);
  const run = useAgentStore((s) => s.run);
  const undone = useAgentStore((s) => (draft ? s.undone[draft.record.id] : undefined));
  const job = useJobsStore((s) => (run?.jobId ? s.jobs[run.jobId] : undefined));
  if (!draft) return null;
  const { record, ops, enabled } = draft;
  const states = run ? opRunStates(ops.length, run.selected, job, run.result) : undefined;
  const count = enabled.filter(Boolean).length;
  const busy = run?.status === "starting" || run?.status === "running";
  // delete_clip / export: checked by hand AND confirmed with a separate click before «Aplicar».
  const destructive = destructiveIndexes(ops, enabled);
  const needsConfirmClick = destructive.some((i) => !draft.confirmed.includes(i));
  const canUndo =
    !undone &&
    record.status === "applied" &&
    (run?.status === "done" || run?.status === "failed" || !run);
  const statusKey = undone ? "undone" : record.status;
  const st = STATUS_LABELS[statusKey];
  const { apply, reject, undoAll, confirmDestructive } = useAgentStore.getState();

  return (
    <Section title="Plan propuesto">
      <div className="flex flex-col gap-2" data-testid="agent-plan">
        <div className="flex flex-wrap items-center gap-1">
          <p className="flex-1 text-sm font-medium">{record.plan?.summary_es ?? record.command}</p>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">«{record.command}»</p>
        {(record.risks?.length ?? 0) > 0 ? (
          <ul
            role="alert"
            className="flex flex-col gap-0.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          >
            {record.risks!.map((r) => (
              <li key={r} className="flex items-start gap-1">
                <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /> {r}
              </li>
            ))}
          </ul>
        ) : null}
        {[...(record.unresolved ?? []), ...(record.errors ?? [])].map((u) => (
          <p key={u} className="rounded-md bg-amber-500/10 px-2 py-1 text-xs">
            {u}
          </p>
        ))}
        <QuestionsForm />
        {ops.length > 0 ? (
          <ul className="flex flex-col gap-1" aria-label="Operaciones">
            {ops.map((_, i) => (
              <OpItem key={i} index={i} run={states?.[i] === "skipped" ? undefined : states?.[i]} />
            ))}
          </ul>
        ) : null}
        {run ? <RunProgress run={run} total={ops.length} /> : null}
        <div className="flex flex-wrap justify-end gap-1">
          {record.status === "proposed" && ops.length > 0 ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reject()}>
                <X /> Rechazar
              </Button>
              {needsConfirmClick && !run ? (
                <Button size="sm" variant="destructive" onClick={confirmDestructive}>
                  <CircleAlert /> {confirmDestructiveLabel(ops, destructive)}
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={busy || count === 0 || needsConfirmClick}
                title={
                  needsConfirmClick ? "Primero confirmá el borrado o la exportación" : undefined
                }
                onClick={() => void apply()}
              >
                {busy ? <Spinner /> : <Check />} Aplicar ({count})
              </Button>
            </>
          ) : null}
          {record.status === "proposed" && ops.length === 0 ? (
            <Button size="sm" variant="ghost" onClick={() => void reject()}>
              <X /> Descartar
            </Button>
          ) : null}
          {canUndo ? (
            <Button
              size="sm"
              variant="outline"
              title="Vuelve el proyecto a como estaba antes de aplicar. No borra los archivos exportados ni los medios que creó el plan."
              onClick={() => void undoAll()}
            >
              <Undo2 /> Deshacer todo
            </Button>
          ) : null}
        </div>
        {canUndo ? (
          <p className="text-right text-[10px] text-muted-foreground">
            Deshacer no borra los archivos exportados ni los medios creados.
          </p>
        ) : null}
      </div>
      <UndoConflictDialog />
    </Section>
  );
}

/** 409 PROJECT_CHANGED on «Deshacer todo»: the project was edited after the apply. */
function UndoConflictDialog() {
  const conflict = useAgentStore((s) => s.undoConflict);
  const { undoAll, dismissUndoConflict } = useAgentStore.getState();
  return (
    <Dialog
      open={!!conflict}
      onClose={dismissUndoConflict}
      title="El proyecto cambió después"
      className="max-w-md"
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="agent-undo-conflict">
        <p>El proyecto cambió después; ¿restaurar igual?</p>
        <p className="text-xs text-muted-foreground">
          Si restaurás, se pierden los cambios que hiciste después de aplicar el plan. Los archivos
          exportados y los medios creados no se borran.
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={dismissUndoConflict}>
            Cancelar
          </Button>
          <Button size="sm" variant="destructive" onClick={() => void undoAll(true)}>
            <Undo2 /> Restaurar igual
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function PlanHistory() {
  const plans = useAgentStore((s) => s.plans);
  const current = useAgentStore((s) => s.draft?.record.id);
  const undone = useAgentStore((s) => s.undone);
  if (plans.length === 0) return null;
  return (
    <Section title="Historial">
      <ul className="flex flex-col gap-1" aria-label="Historial de planes">
        {plans.slice(0, 20).map((p) => {
          const st = STATUS_LABELS[undone[p.id] ? "undone" : p.status];
          return (
            <li key={p.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-1 text-left text-xs hover:bg-accent",
                  current === p.id && "border-primary",
                )}
                onClick={() => useAgentStore.getState().openPlan(p.id)}
              >
                <History className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate">{p.command}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(p.created_at).toLocaleTimeString("es")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Panel «Asistente»: command → EditPlan proposal → confirm/edit → apply (agent.apply). */
/** Sprint 5 (M1, H18): seconds waiting for the model and «Cancelar». */
function Thinking({ loading }: { loading: boolean }) {
  const startedAt = useAgentStore((s) => s.proposeStartedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
      data-testid="assistant-thinking"
    >
      <Spinner />
      <span>
        {loading
          ? "Cargando modelo… (la primera vez puede tardar hasta un minuto)"
          : "Pensando un plan (en tu PC)…"}{" "}
        <span className="tabular-nums">{secs} s</span>
      </span>
      <Button
        size="xs"
        variant="outline"
        className="ml-auto"
        data-testid="assistant-cancel"
        tooltip="Dejar de esperar: el modelo deja de generar el plan"
        onClick={() => useAgentStore.getState().cancelPropose()}
      >
        <X /> Cancelar
      </Button>
    </div>
  );
}

export function AssistantPanel() {
  const error = useAgentStore((s) => s.proposeError);
  const draft = useAgentStore((s) => s.draft);
  const proposing = useAgentStore((s) => s.proposing);
  // Ollama has not loaded the model yet (/api/ps): the first LLM call loads it (≈5 GB).
  const loading = useAgentStore((s) => !!s.status?.ready && s.status.loaded === false);

  const focusTick = useAgentStore((s) => s.focusTick);

  // On mount and every time the user calls the assistant (Ctrl+Shift+A, palette): the panel may
  // have been mounted long ago (inactive tab) while Ollama or the api were still starting.
  useEffect(() => {
    const s = useAgentStore.getState();
    void s.loadStatus();
    void s.loadHistory();
  }, [focusTick]);

  return (
    <Panel title="Asistente">
      <div className="flex flex-col gap-4">
        <ModelStatus />
        <CommandBox />
        {error ? <ErrorNotice message={`No se pudo proponer un plan: ${error}`} /> : null}
        {/* BEGIN sprint5:M1 — «Pensando… 12 s» + Cancelar (H18) */}
        {proposing && !draft ? <Thinking loading={loading} /> : null}
        {/* END sprint5:M1 */}
        {draft ? (
          <PlanView />
        ) : !proposing ? (
          <EmptyState>
            Escribí lo que querés hacer con tus palabras. El asistente propone un plan y vos
            confirmás cada paso antes de aplicarlo.
          </EmptyState>
        ) : null}
        <PlanHistory />
      </div>
    </Panel>
  );
}
