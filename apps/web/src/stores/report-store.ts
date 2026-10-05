import type { ClientError, CreateReportResponse } from "@studio/shared";
import { create } from "zustand";
import { addBreadcrumb } from "./breadcrumbs-store";

/** What the "Reportar error" dialog starts with (Jobs panel / crash / failed-job toast). */
export interface ReportPrefill {
  title?: string;
  jobIds?: string[];
  clientError?: ClientError;
  /** Where it was opened from (breadcrumb only). */
  source?: "paleta" | "cabecera" | "trabajos" | "aviso" | "fallo";
}

interface ReportState {
  open: boolean;
  prefill: ReportPrefill;
  /** Last report created in this session (shown in the result view). */
  result: CreateReportResponse | undefined;
  openReport: (prefill?: ReportPrefill) => void;
  setResult: (result: CreateReportResponse | undefined) => void;
  close: () => void;
}

export const useReportStore = create<ReportState>()((set) => ({
  open: false,
  prefill: {},
  result: undefined,
  openReport: (prefill = {}) => {
    addBreadcrumb("ui", `Abrió «Reportar error»${prefill.source ? ` (${prefill.source})` : ""}`);
    set({ open: true, prefill, result: undefined });
  },
  setResult: (result) => set({ result }),
  close: () => set({ open: false }),
}));

/** Open the report dialog (usable from non-React code: palette actions, toasts). */
export function openReport(prefill?: ReportPrefill): void {
  useReportStore.getState().openReport(prefill);
}
