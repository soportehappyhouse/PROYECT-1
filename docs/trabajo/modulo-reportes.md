# Módulo reportes de error — 2026-10-04

Diagnóstico pegable en ≤3 clics para que Claude reproduzca y arregle un fallo. Guía: `docs/REPORTAR-ERRORES.md`.

- **shared** (aditivo): `report.ts` (request/response, `UiBreadcrumb`, `ClientError`, `JobDiagnostics`,
  etiquetas de severidad); `API_ROUTES.reports|reportDownload|jobDiagnostics`; `LOGS_SUBDIR`, `REPORTS_SUBDIR`.
- **api**: `lib/log-file.ts` (pino → stdout + `storage/logs/api-YYYY-MM-DD.log`, rotación diaria, 7 días,
  redactado); `lib/redact.ts`; `lib/zip.ts` (ZIP sin dependencias); `jobs/diagnostics.ts` (AsyncLocalStorage:
  `runFfmpeg`, `runProcess`, `runFfprobe` y POST a workers registran comando, código, duración y stderr sin
  tocar handlers); migración v3 `jobs.diagnostics` (200 líneas + tiempos); `reports/*`; rutas
  `POST/GET /api/reports`, `GET /api/reports/:id/download`, `GET /api/jobs/:id/diagnostics`; `/files` ya no
  sirve `logs/` ni `reports/`.
- **web**: `stores/breadcrumbs-store.ts` (anillo de 50); migas en stores project/settings/jobs, dock,
  `apiFetch`/`uploadFile` y `lib/global-errors.ts` (`onerror`/`unhandledrejection`); `components/report/`
  (`ReportDialog`, `AppErrorBoundary`, montados en `ClientApp`); entradas: botón 🐞 de cabecera, paleta,
  **Reportar** en trabajos fallidos y en el aviso de fallo.
- **scripts/windows/reportar-error.ps1|.cmd**: sin app (doctor, logs, 20 jobs vía Node → sqlite3 → copia de
  la db, `.env` redactado, versiones), misma carpeta/zip, abre el Explorador, copia el prompt.
- **.github/ISSUE_TEMPLATE** `bug.yml` + `config.yml`; enlace en README.

**Verificación:** `pnpm lint`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test` OK (api 109 + 1 skip, web 61);
`prettier --check` OK en lo tocado (solo fallan `scripts/e2e/*` del agente QA, en curso). Los `.ps1`
parsean con pwsh 7.5 y `reportar-error.ps1` corrió completo en Linux con una db falsa (claves tapadas).
Smoke real: api compilada + mp4 roto → `media.probe` falla → diagnóstico con comando ffprobe y stderr →
`POST /api/reports` genera carpeta + zip; el log diario se escribe y no contiene la clave de `.env`.

**Pendiente:** ARQUITECTURA §2 aún no lista las rutas nuevas; logs de workers/web solo con `start.ps1 -SingleConsole`;
sin probar en Windows real: `Compress-Archive`, Explorador y `Set-Clipboard`.
