import type { ComponentType } from "react";
import type { WebPanelId } from "@/lib/layout";
import { AssistantPanel } from "./AssistantPanel";
import { ExportPanel } from "./ExportPanel";
import { InspectorPanel } from "./InspectorPanel";
import { JobsPanel } from "./JobsPanel";
import { LibraryPanel } from "./LibraryPanel";
import { MediaPanel } from "./MediaPanel";
import { MotionPanel } from "./MotionPanel";
import { PreviewPanel } from "./PreviewPanel";
import { SubtitlesPanel } from "./SubtitlesPanel";
import { TimelinePanel } from "./TimelinePanel";
import { VoicePanel } from "./VoicePanel";

/** Panel id -> component. Adding a panel = add it to PANELS in lib/layout.ts + an entry here. */
export const PANEL_COMPONENTS: Record<WebPanelId, ComponentType> = {
  media: MediaPanel,
  library: LibraryPanel,
  preview: PreviewPanel,
  inspector: InspectorPanel,
  timeline: TimelinePanel,
  motion: MotionPanel,
  voice: VoicePanel,
  subtitles: SubtitlesPanel,
  export: ExportPanel,
  jobs: JobsPanel,
  assistant: AssistantPanel,
};
