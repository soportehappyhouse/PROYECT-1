import type { PanelId } from "@studio/shared";
import type { ComponentType } from "react";
import { InspectorPanel } from "./InspectorPanel";
import { JobsPanel } from "./JobsPanel";
import { LibraryPanel } from "./LibraryPanel";
import { MediaPanel } from "./MediaPanel";
import { MotionPanel } from "./MotionPanel";
import { PreviewPanel } from "./PreviewPanel";
import { SubtitlesPanel } from "./SubtitlesPanel";
import { TimelinePanel } from "./TimelinePanel";
import { VoicePanel } from "./VoicePanel";

/** PanelId -> component. Adding a panel = add the id in @studio/shared + an entry here. */
export const PANEL_COMPONENTS: Record<PanelId, ComponentType> = {
  media: MediaPanel,
  preview: PreviewPanel,
  inspector: InspectorPanel,
  timeline: TimelinePanel,
  motion: MotionPanel,
  voice: VoicePanel,
  subtitles: SubtitlesPanel,
  library: LibraryPanel,
  jobs: JobsPanel,
};
