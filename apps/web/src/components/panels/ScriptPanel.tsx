"use client";

import {
  FILLER_LEVEL_ES,
  fmtS,
  isAcoustic,
  NEED_SPEECH_CLIP_ES,
  replaceWordsText,
  SCRIPT_RULES,
  SCRIPT_PANEL_TEXTS_ES,
  SCRIPT_TEXTS_ES,
  type Script,
  type Word,
} from "@studio/shared";
import { AlertTriangle, Mic, Scissors, Sparkles, Timer, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useAiAvailability } from "@/hooks/use-ai-availability";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label } from "@/components/ui/input";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { fitChoices, localScript, nextReviewIndex, scriptTargetClip } from "@/lib/script";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { useScriptStore } from "@/stores/script-store";
import { Panel } from "./Panel";

/**
 * Sprint 6 M1 «Guion»: the video as text. Click = move the playhead; drag or Mayús+clic = range;
 * Supr/Retroceso = cut the words and close the gap on every unlocked track (12 ms fades, one undo
 * step); Mayús+M = quitar muletillas seguras; «.» / «,» = next / previous probable or doubtful
 * filler or long pause; F2 / doble clic = correct the text without moving the timings.
 */

const LONG_PAUSE_S = SCRIPT_RULES.pause_long_ms / 1000;
const PARAGRAPH_S = SCRIPT_RULES.paragraph_pause_ms / 1000;

function fillerClass(w: Word): string {
  switch (w.filler?.level) {
    case "safe":
      return "rounded bg-amber-300/60 px-0.5 dark:bg-amber-500/40";
    case "probable":
      return "underline decoration-amber-500 decoration-2 underline-offset-2";
    case "doubtful":
      return "underline decoration-muted-foreground decoration-dotted underline-offset-2";
    default:
      return "";
  }
}

function wordTitle(w: Word): string {
  const parts = [`${fmtS(w.start)} s`];
  if (w.filler) parts.push(`${FILLER_LEVEL_ES[w.filler.level]}: ${w.filler.reason_es}`);
  if (w.corrected) parts.push(SCRIPT_TEXTS_ES.corrected);
  if (w.harsh) parts.push("Pegada a la palabra vecina: cortarla puede sonar brusco");
  return parts.join(" · ");
}

/** Words split in paragraphs (pause ≥ 1,5 s) for reading. */
function paragraphs(script: Script): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  script.words.forEach((w, i) => {
    const prev = script.words[i - 1];
    if (prev && w.start - prev.end >= PARAGRAPH_S && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  });
  if (cur.length) out.push(cur);
  return out;
}

export function ScriptPanel() {
  const project = useProjectStore((s) => s.project);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const st = useScriptStore();
  const ai = useAiAvailability("transcribe");
  const [target, setTarget] = useState("");
  const [sentencesOk, setSentencesOk] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const script = useMemo(
    () => localScript(project, st.acoustic, st.meta),
    [project, st.acoustic, st.meta],
  );
  const hasWords = script.words.length > 0;
  const longAfter = useMemo(
    () => new Map(script.pauses.filter((p) => p.long).map((p) => [p.after, p])),
    [script.pauses],
  );
  const review = script.stats.fillers.probable + script.stats.fillers.doubtful;
  const target_clip = scriptTargetClip(project, selectedClipId);
  const selected = useMemo(() => new Set(st.selected), [st.selected]);
  const harsh = useMemo(() => new Set(st.harshSkipped), [st.harshSkipped]);

  // Re-read the audio artifact when the project changes or the first subtitles arrive.
  const hasSubs = project.subtitles.length > 0;
  useEffect(() => {
    void useScriptStore.getState().refresh();
  }, [project.id, hasSubs]);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const focusWord = (id: string | undefined) => {
    if (!id) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-word-id="${id}"]`);
    el?.focus();
    el?.scrollIntoView?.({ block: "nearest" });
  };

  const jump = (dir: 1 | -1) => {
    const from = script.words.findIndex((w) => w.id === (st.active ?? st.selected[0]));
    const i = nextReviewIndex(script, from < 0 && dir < 0 ? script.words.length : from, dir);
    if (i === undefined) return;
    const w = script.words[i]!;
    st.select(w.id);
    useProjectStore.getState().setPlayhead(w.start);
    focusWord(w.id);
  };

  const commitFix = (w: Word, text: string) => {
    st.setEditing(undefined);
    const clean = text.trim();
    if (!clean || clean === w.text) return;
    const store = useProjectStore.getState();
    store.setSubtitles(replaceWordsText(store.project.subtitles, [w.id], clean));
    focusWord(w.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Delete" || e.key === "Backspace") {
      handled();
      void st.deleteSelection();
    } else if (e.key === "Escape") {
      handled();
      st.clearSelection();
    } else if ((e.key === "M" || e.key === "m") && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      handled();
      void st.removeSafe();
    } else if (e.key === "." && !e.ctrlKey) {
      handled();
      jump(1);
    } else if (e.key === "," && !e.ctrlKey) {
      handled();
      jump(-1);
    } else if (e.key === "F2") {
      handled();
      const id = st.active ?? st.selected[0];
      const w = script.words.find((x) => x.id === id);
      if (w && !isAcoustic(w)) st.setEditing(w.id);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const i = script.words.findIndex((w) => w.id === st.active);
      const j = Math.max(
        0,
        Math.min(script.words.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)),
      );
      const w = script.words[j];
      if (!w) return;
      handled();
      if (e.shiftKey) st.select(w.id, "extend");
      else st.setActive(w.id);
      focusWord(w.id);
    }
  };

  const fit = st.fit;
  const choices = fit ? fitChoices(fit.preview) : [];
  const needsConfirm = !!fit?.enabled.includes("sentence");

  const toolbar = hasWords ? (
    <>
      <Button
        size="xs"
        data-testid="script-remove-safe"
        disabled={st.busy || script.stats.fillers.safe === 0}
        tip="scriptRemoveSafe"
        onClick={() => void st.removeSafe()}
      >
        <Wand2 />{" "}
        {SCRIPT_PANEL_TEXTS_ES.removeSafe.replace("{n}", String(script.stats.fillers.safe))}
      </Button>
      <Button
        size="xs"
        variant="outline"
        data-testid="script-review"
        disabled={review === 0 && script.stats.long_pauses === 0}
        tip="scriptReviewDoubtful"
        onClick={() => jump(1)}
      >
        {SCRIPT_PANEL_TEXTS_ES.reviewDoubtful.replace("{n}", String(review))}
      </Button>
      <Button
        size="xs"
        variant="outline"
        data-testid="script-shorten-pauses"
        disabled={st.busy || script.stats.long_pauses === 0}
        tip="scriptShortenPauses"
        onClick={() => void st.shortenPauses()}
      >
        <Timer />
        {SCRIPT_PANEL_TEXTS_ES.shortenPauses.replace("{n}", String(script.stats.long_pauses))}
      </Button>
      <Button
        size="xs"
        variant="outline"
        data-testid="script-delete"
        disabled={st.busy || st.selected.length === 0}
        tip="scriptDelete"
        onClick={() => void st.deleteSelection()}
      >
        <Scissors /> {SCRIPT_PANEL_TEXTS_ES.deleteSelection}
        {st.selected.length ? ` (${st.selected.length})` : ""}
      </Button>
      <form
        className="ml-auto flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(target.replace(",", "."));
          if (Number.isFinite(n) && n >= 3) void st.previewFit(n);
        }}
      >
        <Label htmlFor="script-fit" className="text-xs">
          {SCRIPT_PANEL_TEXTS_ES.fitLabel}
        </Label>
        <Input
          id="script-fit"
          data-testid="script-fit-target"
          inputMode="decimal"
          className="h-6 w-14 text-xs"
          placeholder="45"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <span className="text-xs">s</span>
        <Button
          size="xs"
          type="submit"
          variant="secondary"
          disabled={st.busy || !target}
          tip="scriptFit"
        >
          <Sparkles /> {SCRIPT_PANEL_TEXTS_ES.fitPreview}
        </Button>
      </form>
    </>
  ) : undefined;

  return (
    <Panel title="Guion" toolbar={toolbar}>
      {st.transcribing ? (
        <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> {SCRIPT_PANEL_TEXTS_ES.transcribing}
        </p>
      ) : null}
      {!hasWords ? (
        <EmptyState>
          <span data-testid="script-empty" className="flex flex-col items-center gap-2">
            <span>{SCRIPT_TEXTS_ES.empty}</span>
            <Button
              size="sm"
              data-testid="script-transcribe"
              disabled={!!st.transcribing || !ai.enabled || !target_clip}
              disabledReason={
                !ai.enabled ? ai.reason_es : !target_clip ? NEED_SPEECH_CLIP_ES : undefined
              }
              tip="scriptTranscribe"
              onClick={() => target_clip && void st.transcribe(target_clip.id)}
            >
              <Mic /> {SCRIPT_PANEL_TEXTS_ES.transcribe}
            </Button>
          </span>
        </EmptyState>
      ) : (
        <>
          {script.stale ? (
            <p role="alert" className="mb-2 rounded border border-amber-500 p-2 text-xs">
              {SCRIPT_TEXTS_ES.stale}
            </p>
          ) : null}
          <p className="mb-2 text-xs text-muted-foreground" data-testid="script-stats">
            {script.stats.words} palabras · {fmtS(script.stats.duration_s)} s ·{" "}
            {SCRIPT_TEXTS_ES.longPauses.replace("{n}", String(script.stats.long_pauses))} ·{" "}
            {script.stats.fillers.safe} seguras, {script.stats.fillers.probable} probables,{" "}
            {script.stats.fillers.doubtful} dudosas
            {!script.audio ? ` · ${SCRIPT_PANEL_TEXTS_ES.noAudioArtifact}` : ""}
          </p>
          {fit ? (
            <div data-testid="script-fit-preview" className="mb-2 rounded border p-2 text-xs">
              <p className="mb-1 font-medium">
                {fmtS(fit.preview.from_s)} s → {fmtS(fit.preview.to_s)} s
              </p>
              {choices.map((c) => (
                <label key={c.id} className="flex items-center gap-1">
                  <Checkbox
                    checked={fit.enabled.includes(c.id)}
                    onChange={(e) => st.toggleFit(c.id, e.target.checked)}
                  />
                  {c.label_es}
                </label>
              ))}
              {fit.preview.question_es ? (
                <p className="mt-1 text-muted-foreground">{fit.preview.question_es}</p>
              ) : null}
              {needsConfirm ? (
                <label className="mt-1 flex items-center gap-1 text-amber-600">
                  <Checkbox
                    checked={sentencesOk}
                    onChange={(e) => setSentencesOk(e.target.checked)}
                  />
                  Entiendo que quita oraciones enteras (contenido)
                </label>
              ) : null}
              <div className="mt-2 flex gap-1">
                <Button
                  size="xs"
                  data-testid="script-fit-apply"
                  disabled={choices.length === 0 || (needsConfirm && !sentencesOk)}
                  tip="scriptFitApply"
                  onClick={() => void st.applyFit(sentencesOk)}
                >
                  {SCRIPT_PANEL_TEXTS_ES.fitApply}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => st.closeFit()}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : null}
          <div
            ref={containerRef}
            role="listbox"
            aria-multiselectable="true"
            aria-label="Palabras del guion"
            data-testid="script-words"
            className="flex flex-col gap-2 leading-7 outline-none select-none"
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            {paragraphs(script).map((para) => (
              <p key={para[0]!.id} className="flex flex-wrap gap-x-1">
                {para.map((w) => {
                  const pause = longAfter.get(w.id);
                  const isSel = selected.has(w.id);
                  if (st.editing === w.id)
                    return (
                      <Input
                        key={w.id}
                        autoFocus
                        aria-label={SCRIPT_PANEL_TEXTS_ES.fixPrompt}
                        data-testid="script-fix-input"
                        defaultValue={w.text}
                        className="h-6 w-32 text-sm"
                        onBlur={(e) => commitFix(w, e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") commitFix(w, e.currentTarget.value);
                          if (e.key === "Escape") st.setEditing(undefined);
                        }}
                      />
                    );
                  return (
                    <span key={w.id} className="inline-flex items-center gap-1">
                      <span
                        role="option"
                        aria-selected={isSel}
                        tabIndex={
                          st.active === w.id || (!st.active && w === script.words[0]) ? 0 : -1
                        }
                        title={wordTitle(w)}
                        data-testid="script-word"
                        data-word-id={w.id}
                        data-filler={w.filler?.level}
                        className={cn(
                          "cursor-pointer rounded-sm",
                          fillerClass(w),
                          isAcoustic(w) && "italic text-muted-foreground",
                          w.corrected && "outline-1 outline-dashed outline-muted-foreground",
                          isSel && "bg-primary text-primary-foreground no-underline",
                        )}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          dragging.current = true;
                          if (e.shiftKey) st.select(w.id, "range");
                          else if (e.ctrlKey || e.metaKey) st.select(w.id, "toggle");
                          else {
                            st.select(w.id);
                            useProjectStore.getState().setPlayhead(w.start);
                          }
                          (e.currentTarget as HTMLElement).focus();
                        }}
                        onMouseEnter={(e) => {
                          if (dragging.current && e.buttons === 1) st.select(w.id, "extend");
                        }}
                        onDoubleClick={() => !isAcoustic(w) && st.setEditing(w.id)}
                      >
                        {w.text}
                        {harsh.has(w.id) ? (
                          <AlertTriangle
                            aria-label={SCRIPT_PANEL_TEXTS_ES.harsh}
                            className="ml-0.5 inline size-3 text-amber-600"
                          />
                        ) : null}
                      </span>
                      {pause && pause.end - pause.start > LONG_PAUSE_S ? (
                        <span
                          data-testid="script-pause"
                          title="Pausa larga: «Acortar pausas largas» la deja en 0,25 s"
                          className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
                        >
                          {fmtS(pause.end - pause.start)} s
                        </span>
                      ) : null}
                    </span>
                  );
                })}
              </p>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
