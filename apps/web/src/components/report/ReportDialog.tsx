"use client";

import {
  REPORT_SEVERITY_LABELS,
  ReportSeveritySchema,
  type CreateReportResponse,
  type ReportSeverity,
} from "@studio/shared";
import { Bug, Check, Copy, Download, FolderOpen } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Input, Label, Select, Textarea } from "@/components/ui/input";
import { ErrorNotice, Spinner, Tabs } from "@/components/ui/misc";
import { api, errorMessage } from "@/lib/api";
import { lastClientError } from "@/lib/global-errors";
import { buildReportRequest, copyText, failedJobIds, STEPS_TEMPLATE } from "@/lib/report";
import { useBreadcrumbsStore } from "@/stores/breadcrumbs-store";
import { useReportStore, type ReportPrefill } from "@/stores/report-store";

const SEVERITIES = ReportSeveritySchema.options;

function useCopied(): [string | undefined, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(undefined), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  return [
    copied,
    (id, text) =>
      void copyText(text).then((ok) => {
        if (ok) setCopied(id);
      }),
  ];
}

function ReportForm({
  prefill,
  onDone,
}: {
  prefill: ReportPrefill;
  onDone: (r: CreateReportResponse) => void;
}) {
  const [title, setTitle] = useState(prefill.title ?? "");
  const [steps, setSteps] = useState(STEPS_TEMPLATE);
  const [severity, setSeverity] = useState<ReportSeverity>(prefill.clientError ? "high" : "medium");
  const [includeMedia, setIncludeMedia] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [copied, copy] = useCopied();
  const crumbs = useBreadcrumbsStore((s) => s.crumbs.length);
  const clientError = prefill.clientError ?? lastClientError();
  const jobIds = prefill.jobIds?.length ? prefill.jobIds : failedJobIds();

  const request = () =>
    buildReportRequest({
      title: title.trim() || "Error sin título",
      steps,
      severity,
      includeMedia,
      jobIds: prefill.jobIds ?? [],
      ...(clientError && { clientError }),
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("Escribí un título corto (por ejemplo: «La exportación 9:16 falla al 40 %»).");
      return;
    }
    setSending(true);
    setError(undefined);
    api
      .createReport(request())
      .then(onDone)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSending(false));
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label="Formulario de reporte">
      <Label>
        Título
        <Input
          autoFocus
          value={title}
          maxLength={200}
          placeholder="Ej.: La exportación 9:16 falla al 40 %"
          onChange={(e) => setTitle(e.target.value)}
        />
      </Label>
      <Label>
        ¿Qué intentabas hacer? (pasos, qué esperabas y qué pasó)
        <Textarea rows={8} value={steps} onChange={(e) => setSteps(e.target.value)} />
      </Label>
      <div className="flex flex-wrap items-end gap-4">
        <Label className="min-w-56 flex-1">
          Severidad
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as ReportSeverity)}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {REPORT_SEVERITY_LABELS[s]}
              </option>
            ))}
          </Select>
        </Label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Checkbox checked={includeMedia} onChange={(e) => setIncludeMedia(e.target.checked)} />
          Incluir medios pequeños
        </label>
      </div>
      <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">Se adjunta automáticamente:</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>tus últimas {crumbs} acciones en la interfaz (paneles, clips, trabajos, errores);</li>
          <li>el proyecto actual (sin tus videos) y los ajustes;</li>
          <li>
            {jobIds.length
              ? `${jobIds.length} trabajo(s) fallido(s) con su comando y su salida de error;`
              : "los trabajos fallidos recientes, si hay;"}
          </li>
          <li>versiones (Node, Python, FFmpeg, GPU), logs recientes y datos del navegador.</li>
        </ul>
        <p className="mt-1">
          Las claves y tokens se ocultan.{" "}
          {includeMedia
            ? "Se copiarán miniaturas y archivos de hasta 25 MB: revisalos antes de compartir."
            : "No se copian tus videos ni audios."}
        </p>
        {clientError ? (
          <p className="mt-1 text-destructive">Error capturado: {clientError.message}</p>
        ) : null}
      </div>
      {error ? (
        <ErrorNotice
          message={`No se pudo generar el reporte: ${error}`}
          action={
            <div className="mt-2 flex flex-col gap-1">
              <p>
                Si la API no responde, ejecutá <code>scripts\windows\reportar-error.cmd</code>{" "}
                (funciona sin la app) o copiá estos datos y pegalos en el issue.
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="self-start"
                onClick={() => copy("browser", JSON.stringify(request(), null, 2))}
              >
                {copied === "browser" ? <Check /> : <Copy />} Copiar diagnóstico del navegador
              </Button>
            </div>
          }
        />
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => useReportStore.getState().close()}>
          Cancelar
        </Button>
        <Button type="submit" disabled={sending}>
          {sending ? <Spinner /> : <Bug />} Generar reporte
        </Button>
      </div>
    </form>
  );
}

function ReportResult({ result }: { result: CreateReportResponse }) {
  const [tab, setTab] = useState<"prompt" | "markdown">("prompt");
  const [copied, copy] = useCopied();
  return (
    <div className="flex flex-col gap-3" data-testid="report-result">
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs">
        <p className="font-medium text-foreground">Reporte creado: {result.title}</p>
        <p className="mt-1 flex items-start gap-1 text-muted-foreground">
          <FolderOpen className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            La carpeta está en <code className="break-all">{result.dir}</code> y el zip en{" "}
            <code className="break-all">{result.zipPath}</code>.
          </span>
        </p>
        <p className="mt-1 text-muted-foreground">
          Pegá el prompt en la sesión de Claude Code de este repo. Si Claude no puede leer tu disco,
          adjuntá el .zip.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => copy("prompt", result.prompt)}>
          {copied === "prompt" ? <Check /> : <Copy />}
          {copied === "prompt" ? "¡Copiado!" : "Copiar prompt para Claude"}
        </Button>
        <Button
          variant="outline"
          onClick={() => window.open(api.reportDownloadUrl(result.id), "_blank")}
        >
          <Download /> Descargar .zip
        </Button>
        <Button variant="ghost" onClick={() => copy("markdown", result.markdown)}>
          {copied === "markdown" ? <Check /> : <Copy />} Copiar reporte completo
        </Button>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "prompt", label: "Prompt para Claude" },
          { value: "markdown", label: "reporte.md" },
        ]}
      />
      <pre className="max-h-[40vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
        {tab === "prompt" ? result.prompt : result.markdown}
      </pre>
    </div>
  );
}

/** "Reportar error" dialog: form -> POST /api/reports -> prompt + zip. Mounted once (ClientApp). */
export function ReportDialog() {
  const open = useReportStore((s) => s.open);
  const prefill = useReportStore((s) => s.prefill);
  const result = useReportStore((s) => s.result);
  const { close, setResult } = useReportStore.getState();
  return (
    <Dialog open={open} onClose={close} title={result ? "Reporte listo" : "Reportar error"}>
      {result ? (
        <ReportResult result={result} />
      ) : (
        <ReportForm prefill={prefill} onDone={setResult} />
      )}
    </Dialog>
  );
}
