"use client";

import { detectedPublishFlags, hasAiContentHits, type AiContentHit } from "@studio/shared";
import { ShieldAlert, Sparkles } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Checkbox, Input } from "@/components/ui/input";
import { Badge, Section } from "@/components/ui/misc";
import { DEFAULT_AI_LABEL_TEXT } from "@/lib/ai-types";
import {
  effectiveFlags,
  hasAiContent,
  missingLockedFlags,
  projectAiContent,
  PUBLISH_FLAGS,
  projectPublish,
  socialPatch,
} from "@/lib/publish";
import { useMediaStore } from "@/stores/media-store";
import { usePersonsStore } from "@/stores/persons-store";
import { useProjectStore } from "@/stores/project-store";

/** One detected row: «Cara alterada con IA: «Doble» (pista «Video») · Persona: Ana». */
function DetectedRow({
  title,
  hits,
  personName,
  testId,
}: {
  title: string;
  hits: AiContentHit[];
  personName: (id: string) => string | undefined;
  testId: string;
}) {
  if (hits.length === 0) return null;
  return (
    <li className="text-[11px]" data-testid={testId}>
      <strong>{title}:</strong>{" "}
      {hits
        .map((h) => {
          const who = h.personId ? personName(h.personId) : undefined;
          return who ? `${h.label_es} · Persona: ${who}` : h.label_es;
        })
        .join("; ")}
    </li>
  );
}

/**
 * Exportar → «Revisión para redes» (project.publish): checklist of risky content with the
 * platform consequences and the burned-in «Contenido alterado con IA» label.
 *
 * Sprint 4: the AI content of the media (face swap, cloned / synthetic voice) is detected from its
 * provenance: «Cara» and «Voz clonada» check themselves and stay locked while detected; a voice
 * that is only synthetic is checked but editable. The label is proposed when «Voy a subirlo a
 * redes» is turned on (decision 4); the exported file always records what was detected in its
 * metadata (decision 9), with or without the label.
 */
export function SocialReview() {
  const project = useProjectStore((s) => s.project);
  const assets = useMediaStore((s) => s.assets);
  const persons = usePersonsStore((s) => s.list);
  const publish = projectPublish(project);
  const set = useProjectStore.getState().setPublish;
  const report = useMemo(() => projectAiContent(project, assets), [project, assets]);
  const detected = useMemo(() => detectedPublishFlags(report), [report]);
  const flags = effectiveFlags(publish.flags, detected);
  const ai = hasAiContent(flags);
  const checked = PUBLISH_FLAGS.filter((f) => flags[f.id]);
  const anyDetected = hasAiContentHits(report);
  const personName = (id: string) => persons.find((p) => p.id === id)?.name;
  const missing = publish.forSocial ? missingLockedFlags(publish.flags, detected) : undefined;

  // A face swap / cloned voice that appeared after «Voy a subirlo a redes»: persist the locked
  // flags (nextPublish then proposes the label, as when the box is checked).
  useEffect(() => {
    if (missing) set({ flags: missing });
  }, [missing?.aiFace, missing?.aiVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  const detection = anyDetected ? (
    <div
      className="flex flex-col gap-1 rounded-md bg-primary/10 px-2 py-1"
      data-testid="ai-detected"
    >
      <p className="flex items-center gap-1 text-[11px] font-medium">
        <Sparkles className="size-3.5" aria-hidden />
        Detectado en el proyecto (se marca solo)
      </p>
      <ul className="flex flex-col gap-0.5">
        <DetectedRow
          title="Cara alterada con IA"
          hits={report.face}
          personName={personName}
          testId="ai-detected-face"
        />
        <DetectedRow
          title="Voz clonada"
          hits={report.voiceCloned}
          personName={personName}
          testId="ai-detected-voice-cloned"
        />
        <DetectedRow
          title="Voz sintética"
          hits={report.voiceSynthetic}
          personName={personName}
          testId="ai-detected-voice-synthetic"
        />
      </ul>
      <p className="text-[10px] text-muted-foreground">
        El archivo exportado lo registra en sus metadatos, con o sin la etiqueta visible.
      </p>
    </div>
  ) : null;

  return (
    <Section title="Revisión para redes">
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={publish.forSocial}
          onChange={(e) => set(socialPatch(e.target.checked, report))}
        />
        Voy a subirlo a redes
      </label>
      {publish.forSocial ? (
        <div className="flex flex-col gap-2" data-testid="social-review">
          <p className="text-[11px] text-muted-foreground">
            Marcá lo que tiene el video. Studio te avisa qué piden YouTube, TikTok e Instagram.
          </p>
          {detection}
          <ul className="flex flex-col gap-1">
            {PUBLISH_FLAGS.map((f) => {
              const locked =
                (f.id === "aiFace" && detected.locked.aiFace) ||
                (f.id === "aiVoice" && detected.locked.aiVoice);
              return (
                <li key={f.id}>
                  <label className="flex flex-wrap items-center gap-2 text-xs">
                    <Checkbox
                      checked={flags[f.id]}
                      disabled={locked}
                      title={locked ? "Detectado en el proyecto: no se puede desmarcar" : undefined}
                      onChange={(e) => set({ flags: { [f.id]: e.target.checked } })}
                    />
                    <span className="flex-1">{f.label}</span>
                    {locked ? <Badge tone="danger">Detectado</Badge> : null}
                    {f.badges.map((b) => (
                      <Badge key={b.text} tone={b.tone}>
                        {b.text}
                      </Badge>
                    ))}
                  </label>
                </li>
              );
            })}
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
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground" data-testid="ai-label-off">
            Etiqueta IA desactivada (solo para redes)
          </p>
          {detection}
        </>
      )}
    </Section>
  );
}
