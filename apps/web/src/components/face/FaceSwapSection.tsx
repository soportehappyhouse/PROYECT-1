"use client";

import type { Clip, MediaAsset, Track } from "@studio/shared";
import { ScanFace, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Section } from "@/components/ui/misc";
import { canSwapFace, useFaceStore } from "@/stores/face-store";
import { usePersonsStore } from "@/stores/persons-store";

/** Propiedades of a video clip: «Cambiar cara…», and after a swap the «IA: cara» badge + undo. */
export function FaceSwapSection({
  clip,
  track,
  asset,
}: {
  clip: Clip;
  track: Track;
  asset: MediaAsset | undefined;
}) {
  const persons = usePersonsStore((s) => s.list);
  const swapped = clip.faceSwap;
  useEffect(() => {
    if (swapped && usePersonsStore.getState().status === "idle")
      void usePersonsStore.getState().refresh();
  }, [swapped]);
  if (!swapped && !canSwapFace(track, asset)) return null;
  const who = swapped
    ? (persons.find((p) => p.id === swapped.personId)?.name ?? "Persona")
    : undefined;
  return (
    <Section title="Cara (IA)">
      {swapped ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning" title="Contenido alterado con IA">
            IA: cara ({who})
          </Badge>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void useFaceStore.getState().undo(clip.id)}
          >
            <Undo2 /> Deshacer cambio de cara
          </Button>
        </div>
      ) : (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() => void useFaceStore.getState().openWizard(clip.id)}
        >
          <ScanFace /> Cambiar cara…
        </Button>
      )}
    </Section>
  );
}
