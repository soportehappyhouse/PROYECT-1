# Módulo Sprint 3b — Consola Claude (agente "consola")

Contrato: `sprint3b-contratos.md` §A. Claude Code CLI con la suscripción Claude.ai (sin API key, sin Agent SDK).

## API (`apps/api/src/console/**`, `routes/console.ts`, 2 líneas en `routes/index.ts`)
- PTY: **`@lydell/node-pty` 1.2.0-beta.15** (prebuilds win/linux/mac, sin scripts de build). `node-pty` 1.1.0 se probó: pnpm 12 bloquea su build (`ERR_PNPM_IGNORED_BUILDS`) y no trae prebuild Linux → descartado (no toca `pnpm-workspace.yaml`). `@fastify/websocket` 11 registrado dentro del plugin de consola.
- Rutas (todas solo loopback + Origin permitido si viene): `GET /api/console/status` (`?refresh=1`), `POST /api/console/session {cols?,rows?}` → 201 `{token, cwd, storageDir, claudeInstalled, version, loggedIn, authMethod, bin, mcpReady, installCommand, loginCommand}`, `GET /api/console/ws?token=` (token de un solo uso, vence a 2 min sin conectar; cierre 4401 si es inválido), `POST /api/console/resize {token?, cols, rows}`, `DELETE /api/console/session/:token`, `POST /api/console/plans {plan, projectId?, command?, cursor?, save?=true}` (valida + resuelve un EditPlan escrito por Claude y lo guarda como plan del Asistente, `model: "claude-code"`), `GET /api/projects/:id/frame?t=&format=png|json`.
- WS (JSON): servidor → `output {data}` / `status {state: running|missing|exited|error}` / `exit {exitCode}`; cliente → `input {data}` / `resize` / `kill`. Cerrar el socket mata el proceso (SIGHUP, SIGKILL a los 3 s; en Windows `kill()` de ConPTY).
- Detección: `STUDIO_CLAUDE_BIN` (override, tests) → PATH (PATHEXT: .exe/.cmd) → `~/.local/bin` → Windows `%APPDATA%\npm\claude.cmd` y `npm root -g` → padre. `.cmd` vía `cmd.exe /d /c`. Versión `claude --version`; login `claude auth status` (documentado: JSON, exit 0/1, `authMethod`). Caché 20 s.
- Entorno del hijo: el de la API sin `*_API_KEY`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `ANTHROPIC_(AUTH|BASE_URL|API)*`; + `TERM`, `STUDIO_API_URL`, `STUDIO_CONSOLE=1`; cwd = raíz del repo.
- Sin `claude`: el WS escribe en la terminal el aviso en español con `npm i -g @anthropic-ai/claude-code`, `setup.cmd -WithClaude` y `claude auth login`.
- **Fotograma** (`console/frame.ts`): método «export» = el compilador de exportación con ventana `[t, t+2/fps)` → mp4 temporal → PNG del primer cuadro (`storage/renders/frames/<proyecto>-<ms>.png`; incluye textos, subtítulos, recortes, capas). Si falla, «proxy» = cuadro del clip de video superior bajo t (sin overlays).

## studio-mcp (`packages/studio-mcp`, `.mcp.json` → servidor `studio-mcp`)
- 16 herramientas del contrato (descripciones en español, zod, anotaciones readOnly/destructive). `studio_validate_plan` valida local (`validateEditPlan`) y guarda vía `/api/console/plans`; `studio_export` exige `confirmed: true`; `studio_apply_plan` pasa `confirmedIndexes` (la API responde 409 `CONFIRM_REQUIRED` sin ellos). Rutas absolutas con `storageDir` de `/api/console/status`. `studio_run_job` mapea 13 tipos a rutas (incluye `audio.stems` → `/api/audio/stems` y `style.infer`).
- Estilo: usa `STYLE_API_ROUTES` de `packages/shared/src/style.ts` (analyze → job → `contactSheetPath`; `POST /api/style/presets` con `source.via: "claude"`; `/presets/:id/apply`).
- `pnpm --filter @studio/studio-mcp smoke` (initialize + tools/list por stdio; `SMOKE_CALL`/`SMOKE_ARGS` llama una herramienta).

## Web
- `ConsolePanel.tsx` + `stores/console-store.ts` (máquina de estados pura `consoleReducer`, WS en el store, buffer de 256 KB para re-montar). Registro: `lib/layout.ts` (pestaña inactiva junto a Asistente), `panels/index.ts`, `lib/shortcuts.ts` (`console.open` = `Ctrl+Shift+C`; no global en campos: en la terminal es copiar), `dashboard/actions.ts`; la paleta lo lista sola. Evento `studio:console:paste` `{text, submit?}`: muestra el panel, abre sesión si hace falta y pega cuando Claude está listo. Jobs `agent.apply`/`timeline.*` sin intent (lanzados por la consola) → la web relee el proyecto (`adoptServerProject`).
- Test existente `settings-store.test.ts` (orden del layout) actualizado con `console` y `style`.

## Windows y docs
- `common.ps1`: `Find-ClaudeExe`, `Get-ClaudeVersion`, `Get-ClaudeAuthStatus`. `setup.ps1 -WithClaude` (default ON con Node ≥ 22) / `-SkipClaude`; `doctor.ps1` sección «Consola Claude» (versión, login, studio-mcp). `CLAUDE.md`, `docs/CONSOLA-CLAUDE.md`, sección en `INSTALACION-WINDOWS.md`.

## Verificado (Linux)
`pnpm -r typecheck` (solo falla `packages/shared/test/layers.test.ts`, de capas), api 228 tests, web lint/typecheck/182 tests/build, studio-mcp build/13 tests, lint raíz, prettier de mis archivos, 6 `.ps1` parsean con pwsh 7.4 (+ helpers probados con un `claude` falso). Real: API + shim → WS ida y vuelta, resize, token reusado → 4401, sin keys en el hijo; fotograma PNG exacto (1,5 s, texto visible); MCP por stdio contra la API: get_project, list_assets, preview_frame, validate_plan, apply_plan (409 sin confirmar; subconjunto aplicado).
Pendiente en la PC del usuario: `claude` real + `studio_get_project` desde la consola (criterio del sprint). Integración: agregar las rutas a `docs/ARQUITECTURA.md` y `STUDIO_CLAUDE_BIN` a `.env.example`.
