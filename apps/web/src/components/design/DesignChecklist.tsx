"use client";

import {
  DESIGN_RULES,
  DESIGN_TEXTS_ES,
  ProjectSchema,
  type DesignAspect,
  type DesignCheckResult,
} from "@studio/shared";
import { Check, Wand2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Tabs } from "@/components/ui/misc";
import { saveProjectNow } from "@/hooks/use-project-sync";
import { errorMessage } from "@/lib/api";
import { designApi } from "@/lib/api-design";
import { useProjectStore } from "@/stores/project-store";
import { KIT_TEXTS_ES } from "./texts";

/**
 * The 10-rule design checklist of the open project (POST /api/design/check) and «Arreglar
 * automáticamente» (fix:true) applied as ONE undo step.
 */
export function DesignChecklist({ compact = false }: { compact?: boolean }) {
  const projectId = useProjectStore((s) => s.project.id);
  const canvas = useProjectStore((s) => s.project.settings);
  const [aspect, setAspect] = useState<DesignAspect>(
    canvas.width < canvas.height ? "9:16" : "16:9",
  );
  const [result, setResult] = useState<DesignCheckResult>();
  const [busy, setBusy] = useState(false);

  const run = async (fix = false) => {
    setBusy(true);
    try {
      // The api checks the stored project: save the local one first (best effort), with the same
      // helper as Guion and Sugerencias (local copy + save state; integration S6).
      await saveProjectNow().catch(() => undefined);
      const r = await designApi.check(projectId, { aspect, fix });
      if (fix && r.project) {
        const fixed = ProjectSchema.parse(r.project);
        const st = useProjectStore.getState();
        st.adoptServerProject(fixed, "Arreglar el diseño (kit de marca)");
        st.setSaveState("dirty");
        toast.success(KIT_TEXTS_ES.fixedN.replace("{n}", String(r.fixed)));
      }
      setResult(r);
    } catch (err) {
      toast.error("No se pudo revisar el diseño", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const fixable = result?.issues.some((i) => i.autofix) ?? false;
  return (
    <div className="flex flex-col gap-2" data-testid="design-checklist">
      <div className="flex items-center gap-2">
        <Tabs<DesignAspect>
          className="w-48"
          value={aspect}
          onChange={setAspect}
          items={[
            { value: "9:16", label: "9:16" },
            { value: "16:9", label: "16:9" },
          ]}
        />
        <Button
          size="sm"
          variant="outline"
          tip="designCheck"
          disabled={busy}
          onClick={() => void run(false)}
        >
          {KIT_TEXTS_ES.checkRun}
        </Button>
        {fixable ? (
          <Button size="sm" tip="designFix" disabled={busy} onClick={() => void run(true)}>
            <Wand2 /> {KIT_TEXTS_ES.fixAll}
          </Button>
        ) : null}
      </div>
      {result ? (
        <>
          <p className="text-xs" role="status">
            {result.passed === 10
              ? DESIGN_TEXTS_ES.allRulesPass
              : DESIGN_TEXTS_ES.rulesFailed.replace("{n}", String(10 - result.passed))}
          </p>
          <ul className="flex flex-col gap-1 text-xs">
            {result.rules.map((r) => {
              const def = DESIGN_RULES.find((d) => d.id === r.id)!;
              const issues = result.issues.filter((i) => i.rule === r.id);
              if (compact && r.passed) return null;
              return (
                <li key={r.id} className="flex flex-col gap-0.5" title={def.help_es}>
                  <span className="flex items-center gap-1.5">
                    {r.passed ? (
                      <Check className="size-3.5 text-[var(--ok)]" aria-label="Cumple" />
                    ) : (
                      <X className="size-3.5 text-destructive" aria-label="No cumple" />
                    )}
                    {def.label_es}
                    {def.severity === "guide" ? <Badge tone="muted">guía</Badge> : null}
                  </span>
                  {issues.slice(0, 3).map((i, k) => (
                    <span key={k} className="pl-5 text-muted-foreground">
                      {i.message_es}
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
