"use client";

import { fmtDurEs, SUGGESTION_UI_ES, type CutRange, type ImportSuggestion } from "@studio/shared";
import { AudioLines, BellOff, Check, Scissors, TriangleAlert, Volume2, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Section, Spinner } from "@/components/ui/misc";
import { TIPS } from "@/lib/tooltips";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/stores/project-store";
import { selectVisibleSuggestions, useSuggestionsStore } from "@/stores/suggestions-store";

const T = SUGGESTION_UI_ES;

const KIND_ICON = {
  silences: Scissors,
  low_voice: Volume2,
  clipping: AudioLines,
} as const;

/** Extent (timeline seconds) of the card's clips, for the evidence bar. */
function clipsExtent(s: ImportSuggestion): { from: number; to: number } | undefined {
  const project = useProjectStore.getState().project;
  let from = Infinity;
  let to = -Infinity;
  for (const t of project.tracks)
    for (const c of t.clips)
      if (s.clipIds.includes(c.id)) {
        from = Math.min(from, c.start);
        to = Math.max(to, c.start + (c.out - c.in) / (c.speed || 1));
      }
  return Number.isFinite(from) && to > from ? { from, to } : undefined;
}

/** Mini bar with the detected ranges along the clip (silences). */
export function EvidenceBar({
  ranges,
  from,
  to,
}: {
  ranges: readonly CutRange[];
  from: number;
  to: number;
}) {
  const span = to - from;
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
      title={TIPS.suggestionEvidence}
      aria-label={TIPS.suggestionEvidence}
      role="img"
      data-testid="suggestion-evidence"
    >
      {ranges.map((r) => (
        <span
          key={`${r.start}-${r.end}`}
          className="absolute inset-y-0 bg-primary/70"
          style={{
            left: `${Math.max(0, ((r.start - from) / span) * 100)}%`,
            width: `${Math.max(0.6, ((r.end - r.start) / span) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

export function SuggestionCard({ suggestion }: { suggestion: ImportSuggestion }) {
  const busy = useSuggestionsStore((s) => s.busy === suggestion.id);
  const anyBusy = useSuggestionsStore((s) => !!s.busy);
  const { apply, dismiss } = useSuggestionsStore.getState();
  const Icon = KIND_ICON[suggestion.kind];
  const stale = suggestion.status === "stale";
  const extent = suggestion.evidence?.ranges?.length ? clipsExtent(suggestion) : undefined;
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-md border p-2 text-xs",
        stale && "border-dashed opacity-70",
      )}
      data-testid="suggestion-card"
      data-kind={suggestion.kind}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">{suggestion.title_es}</span>
          {suggestion.detail_es ? (
            <span className="text-muted-foreground">{suggestion.detail_es}</span>
          ) : null}
        </div>
        {stale ? (
          <Badge tone="muted" title={TIPS.suggestionStale}>
            <TriangleAlert className="mr-0.5 inline size-3" aria-hidden />
            {T.stale}
          </Badge>
        ) : null}
      </div>
      {extent && suggestion.evidence?.ranges ? (
        <EvidenceBar ranges={suggestion.evidence.ranges} from={extent.from} to={extent.to} />
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="xs"
          disabled={stale || anyBusy}
          tip={stale ? "suggestionStale" : "suggestionApply"}
          data-testid="suggestion-apply"
          onClick={() => void apply(suggestion.id)}
        >
          {busy ? <Spinner className="size-3" /> : <Check />} {T.apply}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          tip="suggestionDismiss"
          data-testid="suggestion-dismiss"
          onClick={() => void dismiss(suggestion.id)}
        >
          <X /> {T.dismiss}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          tip="suggestionMute"
          data-testid="suggestion-mute"
          onClick={() => void dismiss(suggestion.id, true)}
        >
          <BellOff /> {T.mute}
        </Button>
      </div>
      {suggestion.kind === "silences" && suggestion.impact.seconds_saved ? (
        <span className="text-[10px] text-muted-foreground">
          Ahorra ≈ {fmtDurEs(suggestion.impact.seconds_saved)}
        </span>
      ) : null}
    </li>
  );
}

/** Section «Sugerencias» at the top of the Asistente (hidden when there is nothing to show). */
export function SuggestionsSection() {
  const projectId = useProjectStore((s) => s.project.id);
  const cards = useSuggestionsStore(selectVisibleSuggestionsShallow);
  useEffect(() => {
    void useSuggestionsStore.getState().load(projectId);
  }, [projectId]);
  // «Analizando N medios…» lives in the JobsIndicator (integration S6, M3 cross request 5).
  if (cards.length === 0) return null;
  return (
    <Section title={T.section}>
      <div className="flex flex-col gap-2" data-testid="suggestions">
        <p className="text-[11px] text-muted-foreground">{T.sectionHelp}</p>
        {cards.length ? (
          <ul className="flex flex-col gap-2" aria-label={T.section}>
            {cards.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} />
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

// Stable selector result (zustand re-renders on reference change).
let lastIn: ImportSuggestion[] | undefined;
let lastOut: ImportSuggestion[] = [];
function selectVisibleSuggestionsShallow(s: { suggestions: ImportSuggestion[] }) {
  if (s.suggestions !== lastIn) {
    lastIn = s.suggestions;
    lastOut = selectVisibleSuggestions(s);
  }
  return lastOut;
}
