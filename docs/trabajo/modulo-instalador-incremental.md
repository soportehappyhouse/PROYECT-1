# Módulo: instalador Windows incremental (2026-10-05)

Pedido del dueño: "una nueva versión debe reconocer lo ya descargado y pasar solo a lo que falta".

## Qué hace cada paso de `setup.ps1` antes de actuar

| Paso                     | Se omite cuando                                                                  |
| ------------------------ | -------------------------------------------------------------------------------- |
| winget (Git/Node/Py/FFmpeg/VC++) | presente y versión ≥ mínima (Git 2.40, Node 22.12); si es vieja, `winget upgrade` |
| `.env` + carpetas        | `.env` y todas las carpetas existen                                              |
| pnpm global / `pnpm install` | pnpm 12.x / sello `node_modules\.studio-install` = hash(lockfile, package.json, node, pnpm) y existe `.modules.yaml` |
| Remotion browser         | `Find-RemotionBrowser` encuentra `chrome-headless-shell.exe`                     |
| `.venv` + pip            | sello `.venv\.studio-install`: línea 1 `<perfil> <SHA256 requirements>` (formato viejo, se reconoce), línea 2 hash de `pyproject.toml`. Perfil cuda/norvc se hereda si no se pasa el switch |
| Modelos                  | `models_cli --check --update` informa 0 faltantes                                |
| Build                    | sello `apps\web\.next\.studio-build` = hash del contenido de web/api/packages + lockfile + `.env` (`NEXT_PUBLIC_*`, `*_PORT`); builds viejos sin sello se adoptan con la regla de fechas |

Cada fila del resumen lleva segundos y `[omitido]`/`[ejecutado]`; total y conteos en `storage\run\setup-last.json`.
`-Update`: sin git, modelos del manifiesto incluidos, mensaje de qué conservar. `-Force` ignora sellos.

## Modelos (`apps/workers/studio_workers/models_manifest.py`)
- `models/manifest.json`: por archivo `name, group, path, size, sha256, md5 (Piper), source, date, mtime_ns`.
- Skip: existe + tamaño (+ md5 del catálogo / sha256 previo). Si size+mtime coinciden con el manifiesto no se re-hashea; `--verify` fuerza.
- Descarga a `.part` con `Range: bytes=N-` (206 append, 200 reinicia, 416 verifica); verifica tamaño, md5, sha256 de `X-Linked-Etag` (HF); si un `.part` reanudado no verifica, reintenta desde cero una vez. Corte de red: el `.part` queda.
- Whisper: snapshot HF (huggingface_hub reanuda); presente si hay `model.bin` + `config.json`; sha256 = nombre del blob.
- CLI: `--check` (tabla, offline), `--update` (solo faltantes + grupos del manifiesto), `--report`, `--no-write` (doctor).

## Pendiente / riesgo
- No probado en Windows real: parseo con pwsh 7 + simulación en Linux; CI windows-smoke corre setup dos veces y exige 0 ejecutados en la segunda.
- ZIP encima no borra archivos eliminados en la versión nueva (documentado).
- Descargas hechas desde la UI (`/models/download`) no escriben el manifiesto; `--check` las adopta.
