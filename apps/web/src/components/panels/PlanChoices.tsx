"use client";

import { ASPECT_FIT_HELP_ES, type AspectFit } from "@studio/shared";
import { Crop, ScanFace, Sparkles, SquareDashed } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { choosePlanOption } from "@/lib/api-export";
import { useAgentStore } from "@/stores/agent-store";

const ICONS: Record<AspectFit, React.ReactNode> = {
  reframe: <ScanFace />,
  center: <Crop />,
  blur: <SquareDashed />,
};

/**
 * Sprint 5 (M3): questions the api leaves in a plan (e.g. «El video es horizontal y Reels es
 * vertical. ¿Cómo lo encuadro?») shown as buttons; picking one asks the api to apply it and shows
 * the new preview. Also lists the ops Studio added by itself (reframe before a 9:16 export).
 */
export function PlanChoices() {
  const record = useAgentStore((s) => s.draft?.record);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  if (!record) return null;
  const choices = record.choices ?? [];
  const added = record.added ?? [];
  if (choices.length === 0 && added.length === 0) return null;
  const locked = record.status !== "proposed";

  const pick = async (choiceId: string, optionId: AspectFit) => {
    setBusy(`${choiceId}:${optionId}`);
    try {
      const updated = await choosePlanOption(record.id, choiceId, optionId);
      useAgentStore.getState().receivePlan(updated);
    } catch (err) {
      toast.error("No se pudo cambiar el plan", { description: errorMessage(err) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="plan-choices">
      {added.map((a) => (
        <p
          key={a.index}
          className="flex items-start gap-1 rounded-md bg-primary/5 px-2 py-1 text-[11px]"
          data-testid="plan-added"
        >
          <Sparkles className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>
            Operación {a.index + 1} agregada por Studio: {a.reason_es}
          </span>
        </p>
      ))}
      {choices.map((c) => (
        <fieldset
          key={c.id}
          className="flex flex-col gap-1.5 rounded-md border border-primary/40 bg-primary/5 p-2"
          data-testid="plan-choice"
        >
          <legend className="px-1 text-xs font-medium">{c.question_es}</legend>
          <div className="flex flex-wrap gap-1">
            {c.options.map((o) => (
              <Button
                key={o.id}
                size="xs"
                variant={o.id === "reframe" ? "default" : "outline"}
                disabled={locked || busy !== undefined}
                title={ASPECT_FIT_HELP_ES[o.id]}
                onClick={() => void pick(c.id, o.id)}
              >
                {busy === `${c.id}:${o.id}` ? <Spinner className="size-3" /> : ICONS[o.id]}
                {o.label_es}
              </Button>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
