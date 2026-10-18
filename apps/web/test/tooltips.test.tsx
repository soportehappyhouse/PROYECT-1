import { DndContext } from "@dnd-kit/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimelinePanel } from "@/components/panels/TimelinePanel";
import { Button } from "@/components/ui/button";
import { TIPS, type TipKey } from "@/lib/tooltips";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 5 (M2, H21): tooltips explain what an icon button does (not its aria-label again). */
const ARIA: Record<TipKey, string> = {
  panels: "Paneles",
  layouts: "Layouts",
  theme: "Tema",
  report: "Reportar error",
  settings: "Ajustes",
  gpu: "Estado de la IA local",
  toStart: "Ir al inicio",
  frameBack: "Fotograma anterior",
  play: "Reproducir",
  frameFwd: "Fotograma siguiente",
  toEnd: "Ir al final",
  previewOpts: "Opciones de la vista previa",
  removeBg: "Quitar fondo",
  sam: "Máscara (SAM 2)",
  reframe: "Reencuadrar",
  track: "Seguir objeto",
  undo: "Deshacer",
  redo: "Rehacer",
  split: "Cortar en el cursor",
  delete: "Eliminar clip",
  snap: "Imán (snapping)",
  silences: "Quitar silencios y muletillas",
  zoomIn: "Acercar",
  zoomOut: "Alejar",
  trackMute: "Silenciar",
  trackHide: "Ocultar pista",
  trackLock: "Bloquear pista",
  trackDelete: "Eliminar pista",
  trackOrder: "Orden de capa",
  mediaReload: "Recargar medios",
  mediaProxy: "Generar proxy",
  mediaAdd: "Añadir a la línea de tiempo",
  mediaDelete: "Eliminar",
  jobsReload: "Recargar trabajos",
  jobsClear: "Limpiar terminados",
  jobCancel: "Cancelar",
  jobOpen: "Abrir",
  jobReport: "Reportar",
  presetDup: "Duplicar preset",
  presetDel: "Borrar preset",
  subAdd: "Añadir segmento en el cursor",
  subDel: "Eliminar segmento",
  subSrt: "Descargar SRT",
  motionReload: "Recargar plantillas",
  styleReload: "Actualizar perfiles",
  styleDel: "Borrar el perfil",
  libPlay: "Escuchar",
  libAdd: "Añadir a la línea de tiempo",
  libUpload: "Subir sonidos a la biblioteca",
  kfCopy: "Copiar keyframes",
  kfPaste: "Pegar keyframes en el cursor",
};

describe("TIPS", () => {
  it("has the 51 keys of the contract, each ≥ 20 characters and not its aria-label", () => {
    expect(Object.keys(TIPS)).toHaveLength(51);
    expect(Object.keys(TIPS).sort()).toEqual(Object.keys(ARIA).sort());
    for (const [key, text] of Object.entries(TIPS)) {
      expect(text.length, key).toBeGreaterThanOrEqual(20);
      expect(text.toLowerCase(), key).not.toBe(ARIA[key as TipKey].toLowerCase());
    }
  });

  it("Button tip: the TIPS text (plus the reason when disabled) without repeating the shortcut", () => {
    const { container } = render(
      <>
        <Button
          size="icon-sm"
          aria-label="Cortar en el cursor"
          tip="split"
          shortcut="timeline.split"
        >
          x
        </Button>
        <Button
          size="icon-sm"
          aria-label="Quitar fondo"
          tip="removeBg"
          disabled
          disabledReason="La IA local está apagada"
        >
          y
        </Button>
      </>,
    );
    const [split, bg] = [...container.querySelectorAll("button")];
    expect(split!.dataset.tooltip).toBe(TIPS.split);
    expect(split!.dataset.tip).toBe("split");
    expect(bg!.dataset.tooltip).toBe(`${TIPS.removeBg}. La IA local está apagada`);
  });

  it("a text button without its own tooltip shows the disabled reason (integration)", () => {
    const { container } = render(
      <>
        <Button disabled disabledReason="La IA local está apagada">
          Transcribir clip
        </Button>
        <Button disabledReason="no se muestra">Habilitado</Button>
      </>,
    );
    const [off, on] = [...container.querySelectorAll("button")];
    expect(off!.dataset.tooltip).toBe("La IA local está apagada");
    expect(on!.dataset.tooltip).toBeUndefined();
  });

  it("every icon button of the timeline panel explains itself", () => {
    useProjectStore.getState().loadProject(createEmptyProject("Tips"));
    const { container } = render(
      <DndContext>
        <TimelinePanel />
      </DndContext>,
    );
    const icons = [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")].filter(
      (b) => !b.textContent?.trim(),
    );
    expect(icons.length).toBeGreaterThan(15);
    for (const b of icons) {
      const tip = b.dataset.tooltip ?? "";
      const label = b.getAttribute("aria-label")!;
      expect(tip.length, label).toBeGreaterThanOrEqual(20);
      expect(tip, label).not.toBe(label);
    }
  });
});
