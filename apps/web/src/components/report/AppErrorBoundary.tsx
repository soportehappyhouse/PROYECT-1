"use client";

import { Bug, RotateCw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { recordCrash, toClientError } from "@/lib/global-errors";
import { addBreadcrumb } from "@/stores/breadcrumbs-store";
import { openReport } from "@/stores/report-store";

interface State {
  error?: Error;
  componentStack?: string;
}

/**
 * Global error boundary: when the dashboard crashes it shows a friendly screen that offers
 * "Reportar error" (prefilled with the crash) instead of a blank page.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? undefined;
    recordCrash({ ...toClientError(error), ...(componentStack && { componentStack }) });
    addBreadcrumb("error", `La interfaz se cerró por un error: ${error.message}`, {
      ...(componentStack && {
        componentStack: componentStack.trim().split("\n").slice(0, 8).join("\n"),
      }),
    });
    this.setState({ ...(componentStack && { componentStack }) });
  }

  report = (): void => {
    const { error, componentStack } = this.state;
    if (!error) return;
    openReport({
      title: `La interfaz se cerró: ${error.message}`.slice(0, 200),
      clientError: { ...toClientError(error), ...(componentStack && { componentStack }) },
      source: "fallo",
    });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
        <div
          role="alert"
          className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-6 shadow-lg"
        >
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-destructive" aria-hidden />
            <h1 className="text-base font-semibold">Algo salió mal en Studio</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            La interfaz encontró un error y se detuvo. Tu proyecto se guarda automáticamente. Generá
            un reporte para que Claude pueda reproducirlo y arreglarlo.
          </p>
          <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
            {error.message}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button onClick={this.report}>
              <Bug /> Reportar error
            </Button>
            <Button variant="outline" onClick={() => this.setState({ error: undefined })}>
              Intentar de nuevo
            </Button>
            <Button variant="ghost" onClick={() => window.location.reload()}>
              <RotateCw /> Recargar
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
