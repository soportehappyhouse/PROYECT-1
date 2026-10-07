"use client";

import { FACE_SWAPPER_INFO, LICENCES } from "@studio/shared";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { LICENCE_OPEN_EVENT } from "@/lib/api";
import { usePersonsStore } from "@/stores/persons-store";

/** Licences of the models FaceFusion always loads (docs/trabajo/fuentes-sprint4.md §1.5). */
const MODEL_LICENCES: readonly [string, string][] = [
  ["FaceFusion (código)", "OpenRAIL-AS: restricciones de uso"],
  ["ArcFace w600k r50 (reconocimiento)", "No comercial (InsightFace)"],
  ["kim_vocal_2", "No comercial"],
  ["XSeg 1 (máscara de oclusión), YOLOFace", "GPL-3.0"],
  ["Analizador de contenido (nsfw 1/2/3)", "Apache-2.0 / MIT — siempre activo"],
  ["GFPGAN 1.4 (mejorador)", "Apache-2.0"],
  ...Object.values(FACE_SWAPPER_INFO).map((m) => [m.name_es, m.licence] as [string, string]),
];

/**
 * Global «Licencia del cambio de cara» dialog: opened by the window event `studio:licence:open`
 * (Paquetes de IA «Leer y aceptar», first swap) and by every 403 LICENCE_REQUIRED. Accepting is
 * only possible here (the api refuses it from the console / assistant: HUMAN_ONLY).
 */
export function LicenceDialog() {
  const { open, licenceId } = usePersonsStore((s) => s.licenceDialog);
  const status = usePersonsStore((s) => s.licences.find((l) => l.id === licenceId));
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ licenceId?: string }>).detail?.licenceId;
      usePersonsStore.getState().openLicence(id === "faceswap" ? id : "faceswap");
    };
    window.addEventListener(LICENCE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(LICENCE_OPEN_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);
  const l = LICENCES[licenceId];
  const close = () => usePersonsStore.getState().closeLicence();
  return (
    <Dialog open={open} onClose={close} title={`Licencia: ${l.name_es}`}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="leading-relaxed">{l.text_es}</p>
        <table className="w-full text-xs">
          <tbody>
            {MODEL_LICENCES.map(([name, lic]) => (
              <tr key={name} className="border-b last:border-0">
                <td className="py-1 pr-2">{name}</td>
                <td className="py-1 text-muted-foreground">{lic}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="flex flex-col gap-1 text-xs">
          {l.urls.map((u) => (
            <li key={u}>
              <a
                href={u}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary underline"
              >
                <ExternalLink className="size-3" /> {u}
              </a>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          Texto versión {l.text_version}. Paquetes: {l.packs.join(", ")}. Sin aceptarla no se
          descarga ni se ejecuta nada del cambio de cara.
        </p>
        {status?.accepted && status.acceptance ? (
          <div className="flex items-center gap-2">
            <Badge tone="success">
              Aceptada el {new Date(status.acceptance.accepted_at).toLocaleString("es-AR")}
            </Badge>
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto text-destructive"
              onClick={() => void usePersonsStore.getState().revokeLicence(licenceId)}
            >
              Revocar
            </Button>
          </div>
        ) : (
          <>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>Entiendo que son de uso no comercial y con restricciones</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={close}>
                Ahora no
              </Button>
              <Button
                size="sm"
                disabled={!checked}
                onClick={async () => {
                  if (await usePersonsStore.getState().acceptLicence(licenceId)) {
                    window.dispatchEvent(
                      new CustomEvent("studio:licence:accepted", { detail: { licenceId } }),
                    );
                    close();
                  }
                }}
              >
                Aceptar
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
