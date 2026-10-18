import { toast } from "sonner";
import { useProjectStore } from "@/stores/project-store";

/**
 * Sprint 5 (H7/H26): after the first video lands on the timeline, tell what changed (project
 * name, canvas) with a «Deshacer» action. The change itself is one undo step (project-store).
 */
export function announceFirstVideoAdjust(): void {
  const adjust = useProjectStore.getState().firstVideoAdjust;
  if (!adjust) return;
  useProjectStore.setState({ firstVideoAdjust: undefined });
  const parts: string[] = [];
  if (adjust.canvas)
    parts.push(`Ajusté el lienzo a ${adjust.canvas.width}×${adjust.canvas.height}`);
  if (adjust.name) parts.push(`El proyecto ahora se llama «${adjust.name}»`);
  toast.message(parts.join(" · "), {
    description: "Lo hice al importar el primer video. Si no te sirve, deshacelo.",
    duration: 10_000,
    action: { label: "Deshacer", onClick: () => useProjectStore.getState().undo() },
  });
}
