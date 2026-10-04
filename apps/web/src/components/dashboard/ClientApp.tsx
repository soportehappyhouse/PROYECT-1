"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { AppErrorBoundary } from "@/components/report/AppErrorBoundary";
import { ReportDialog } from "@/components/report/ReportDialog";
import { installGlobalErrorCapture } from "@/lib/global-errors";

/** The dashboard depends on window/localStorage/dockview: render it on the client only. */
const Dashboard = dynamic(() => import("./Dashboard").then((m) => m.Dashboard), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
      Cargando Studio…
    </div>
  ),
});

/**
 * The error boundary and the "Reportar error" dialog live outside the dashboard so a crash still
 * lets the user produce a report; window errors are captured into the breadcrumbs.
 */
export function ClientApp() {
  useEffect(() => installGlobalErrorCapture(), []);
  return (
    <>
      <AppErrorBoundary>
        <Dashboard />
      </AppErrorBoundary>
      <ReportDialog />
    </>
  );
}
