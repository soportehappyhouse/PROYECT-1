import type {
  ClientError,
  CreateReportRequestInput,
  Job,
  Project,
  ReportSeverity,
} from "@studio/shared";
import { getBreadcrumbs } from "@/stores/breadcrumbs-store";
import { useJobsStore } from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { API_URL } from "./api";

/** Template shown in "¿Qué intentabas hacer?" (Spanish, for non-developers). */
export const STEPS_TEMPLATE = ["1. ", "2. ", "3. ", "", "Esperaba que…", "Pero pasó…"].join("\n");

export interface ReportForm {
  title: string;
  steps: string;
  severity: ReportSeverity;
  includeMedia: boolean;
  jobIds: string[];
  clientError?: ClientError;
}

/** Browser / window facts that help reproduce layout or codec issues. */
export function browserInfo(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const nav = window.navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: nav.userAgent,
    language: nav.language,
    languages: nav.languages,
    platform: nav.platform,
    hardwareConcurrency: nav.hardwareConcurrency,
    ...(nav.deviceMemory !== undefined && { deviceMemoryGb: nav.deviceMemory }),
    online: nav.onLine,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen?.width, height: window.screen?.height },
    devicePixelRatio: window.devicePixelRatio,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    url: window.location.href,
    apiUrl: API_URL,
  };
}

/** Settings without layout noise (dockview JSON / saved layout payloads). */
export function settingsSnapshot(): Record<string, unknown> {
  const s = useSettingsStore.getState();
  return {
    theme: s.theme,
    accent: s.accent,
    density: s.density,
    shortcuts: s.shortcuts,
    openPanels: s.openPanels,
    layoutPresets: s.layoutPresets.map((p) => p.name),
    customLayout: s.layout !== undefined,
    syncState: s.syncState,
    updatedAt: s.updatedAt,
  };
}

function projectSummary(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    settings: project.settings,
    tracks: project.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      clips: t.clips.length,
      ...(t.locked && { locked: true }),
      ...(t.muted && { muted: true }),
    })),
    subtitles: project.subtitles.length,
  };
}

function jobSummary(j: Job): Record<string, unknown> {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    progress: j.progress,
    createdAt: j.createdAt,
    ...(j.error && { error: j.error }),
    ...(j.message && { message: j.message }),
  };
}

/** Ids of failed jobs currently known by the dashboard (newest first, max 10). */
export function failedJobIds(): string[] {
  return Object.values(useJobsStore.getState().jobs)
    .filter((j) => j.status === "failed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map((j) => j.id);
}

/** Assemble POST /api/reports from the form + everything the dashboard knows automatically. */
export function buildReportRequest(form: ReportForm): CreateReportRequestInput {
  const p = useProjectStore.getState();
  const jobs = useJobsStore.getState();
  const jobIds = [...new Set([...form.jobIds, ...(form.jobIds.length ? [] : failedJobIds())])];
  return {
    title: form.title.trim(),
    steps: form.steps.trim() === STEPS_TEMPLATE.trim() ? "" : form.steps,
    severity: form.severity,
    includeMedia: form.includeMedia,
    uiBreadcrumbs: getBreadcrumbs(),
    jobIds,
    projectId: p.project.id,
    project: p.project,
    ...(form.clientError && { clientError: form.clientError }),
    uiState: {
      browser: browserInfo(),
      settings: settingsSnapshot(),
      project: projectSummary(p.project),
      editor: {
        selectedClipId: p.selectedClipId,
        selectedAssetId: p.selectedAssetId,
        playhead: p.playhead,
        playing: p.playing,
        zoom: p.zoom,
        saveState: p.saveState,
        undoDepth: p.past.length,
      },
      jobs: {
        connection: jobs.connection,
        recent: Object.values(jobs.jobs)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
          .map(jobSummary),
      },
    },
  };
}

/** Copy text to the clipboard (falls back to a hidden textarea on non-secure origins). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
