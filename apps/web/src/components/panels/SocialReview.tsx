"use client";

import { ShieldAlert } from "lucide-react";
import { Checkbox, Input } from "@/components/ui/input";
import { Badge, Section } from "@/components/ui/misc";
import { DEFAULT_AI_LABEL_TEXT } from "@/lib/ai-types";
import { hasAiContent, PUBLISH_FLAGS, projectPublish } from "@/lib/publish";
import { useProjectStore } from "@/stores/project-store";

/**
 * Exportar → «Revisión para redes» (project.publish): checklist of risky content with the
 * platform consequences and the burned-in «Contenido alterado con IA» label.
 */
export function SocialReview() {
  const project = useProjectStore((s) => s.project);
  const publish = projectPublish(project);
  const set = useProjectStore.getState().setPublish;
  const ai = hasAiContent(publish.flags);
  const checked = PUBLISH_FLAGS.filter((f) => publish.flags[f.id]);

  return (
    <Section title="Revisión para redes">
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={publish.forSocial}
          onChange={(e) => set({ forSocial: e.target.checked })}
        />
        Voy a subirlo a redes
      </label>
      {publish.forSocial ? (
        <div className="flex flex-col gap-2" data-testid="social-review">
          <p className="text-[11px] text-muted-foreground">
            Marcá lo que tiene el video. Studio te avisa qué piden YouTube, TikTok e Instagram.
          </p>
          <ul className="flex flex-col gap-1">
            {PUBLISH_FLAGS.map((f) => (
              <li key={f.id}>
                <label className="flex flex-wrap items-center gap-2 text-xs">
                  <Checkbox
                    checked={publish.flags[f.id]}
                    onChange={(e) => set({ flags: { [f.id]: e.target.checked } })}
                  />
                  <span className="flex-1">{f.label}</span>
                  {f.badges.map((b) => (
                    <Badge key={b.text} tone={b.tone}>
                      {b.text}
                    </Badge>
                  ))}
                </label>
              </li>
            ))}
          </ul>
          {checked.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="Avisos">
              {checked.map((f) => (
                <li
                  key={f.id}
                  className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-300"
                >
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    <strong>{f.label}:</strong> {f.warning}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={publish.aiLabel}
              onChange={(e) => set({ aiLabel: e.target.checked })}
            />
            Etiqueta «Contenido alterado con IA» en el video
          </label>
          {publish.aiLabel ? (
            <>
              <Input
                aria-label="Texto de la etiqueta"
                maxLength={120}
                value={publish.aiLabelText ?? DEFAULT_AI_LABEL_TEXT}
                onChange={(e) => set({ aiLabelText: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                Se quema chica en la esquina inferior izquierda durante todo el video. Igual marcá
                «contenido alterado o sintético» al subirlo en cada red.
              </p>
            </>
          ) : ai ? (
            <p className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              Sin etiqueta, un video con IA realista puede darse de baja o penalizar la cuenta.
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
