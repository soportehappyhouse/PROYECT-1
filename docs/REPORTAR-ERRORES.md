# Reportar errores

Cuando algo falla, Studio arma un **reporte completo** (qué hiciste, qué pasó y en qué equipo) que
se pega tal cual en la sesión de Claude Code de este repo para que lo reproduzca y lo arregle.
No hace falta saber programar: son 3 clics.

## Las 3 formas

| Situación                               | Qué hacer                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **La app funciona** (lo normal)         | Botón 🐞 **Reportar error** (arriba a la derecha) → completar → **Generar reporte**            |
| **La app no abre / la API no responde** | Doble clic en `scripts\windows\reportar-error.cmd` (o el `.ps1`, ver abajo)                    |
| **Querés dejarlo registrado en GitHub** | _Issues → New issue → Reportar un error_ y adjuntar el `.zip` que generó cualquiera de las dos |

### 1. Botón en la app

Se abre desde cualquiera de estos lugares:

- el botón 🐞 de la cabecera;
- la paleta de comandos (`Ctrl+K`) → «Reportar error (diagnóstico para Claude)»;
- el botón **Reportar** de un trabajo que falló en el panel **Trabajos** (o el botón «Reportar» del
  aviso rojo): el reporte ya lleva ese trabajo;
- la pantalla «Algo salió mal en Studio» si la interfaz se cae (lleva el error y su stack).

El formulario pide **título**, **qué intentabas hacer** (plantilla «1. … 2. … Esperaba que… Pero
pasó…»), **severidad** y la casilla **incluir medios pequeños**. Todo lo demás se adjunta solo.
Al terminar muestra el **Prompt para Claude** con los botones **Copiar prompt para Claude** y
**Descargar .zip**, y la ruta de la carpeta en tu disco.

### 2. Script sin conexión

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\reportar-error.ps1
# opciones: -Titulo "No arranca la API" -Pasos "1. start.ps1 ..." -Severidad bloqueante
#           -SinDoctor (más rápido)  -NoAbrir  -NoInteractivo
```

Pregunta título, pasos y severidad; ejecuta `doctor.ps1`; lee los últimos 20 trabajos de
`storage\studio.db` (con Node, o `sqlite3`; si ninguno funciona copia la base); junta los logs y tu
`.env` con las claves tapadas; arma la misma carpeta y `.zip`, **abre el Explorador** en el zip,
imprime el Prompt para Claude y lo deja **copiado en el portapapeles**.

### 3. Issue en GitHub

El formulario _Reportar un error_ pide pasos, qué esperabas, qué pasó, severidad, el Prompt para
Claude, el `.zip` y la salida de `doctor.ps1`. Revisá el zip antes de subirlo (ver Privacidad).

## Qué contiene el reporte

Carpeta `storage\reports\<yyyyMMdd-HHmmss>-<titulo>\` y, al lado, `<misma>.zip`:

| Archivo                           | Contenido                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reporte.md`                      | Resumen en español; arriba de todo, el bloque **Prompt para Claude**                                                                                              |
| `reporte.json`                    | Lo mismo para máquinas: pasos, severidad, últimas 50 acciones de la interfaz, estado de la UI, trabajos                                                           |
| `entorno.json`                    | Windows, CPU/RAM, Node, pnpm, Python, FFmpeg, GPU, commit (`VERSION` o `git rev-parse`), `/health` de api y workers, configuración sin claves                     |
| `jobs/<id>.json`                  | Cada trabajo adjunto: payload, error, **comandos completos** (ffmpeg / llamadas a workers) con tiempos y código de salida, y las **últimas 200 líneas de stderr** |
| `jobs/recientes.json`             | Los últimos 20 trabajos (tipo, estado, error)                                                                                                                     |
| `logs/`                           | Últimas 500 líneas de cada log de `storage\logs` (api `api-AAAA-MM-DD.log`, workers/web con `start.ps1 -SingleConsole`)                                           |
| `proyecto.json`                   | El proyecto abierto (con cambios sin guardar) y los metadatos de sus medios, con **rutas relativas**                                                              |
| `medios/`                         | Solo con «incluir medios pequeños»: miniaturas y archivos de hasta 25 MB (máx. 100 MB en total)                                                                   |
| `doctor.txt`, `env-redactado.txt` | Solo el script sin conexión                                                                                                                                       |

Sin pedirlo nunca se copian tus videos ni audios. Si no marcaste trabajos, se adjuntan los que
fallaron en las últimas 24 h.

**Acciones de la interfaz («migas»)**: la app recuerda las últimas 50 — paneles abiertos, clips
añadidos/movidos/recortados/divididos, pistas, trabajos iniciados o fallidos, cambios de ajustes,
errores de la API (método, ruta y código) y errores de JavaScript (`window.onerror` y promesas sin
manejar). Viven solo en memoria del navegador hasta que generás un reporte.

## Cómo pasárselo a Claude

1. Abrí la sesión de Claude Code de este repo.
2. Pegá el bloque **Prompt para Claude** (botón «Copiar prompt para Claude» o el portapapeles tras
   el script).
3. Si la sesión corre en tu PC, Claude lee la carpeta indicada en el prompt. Si corre en la nube,
   **adjuntá el .zip** (o pedile que te indique dónde subirlo).

El bloque siempre tiene este orden:

```text
Hola Claude. Encontré un error en Studio (este repo). Reproducilo …, encontrá la causa y arreglalo con un test.

## Contexto            ← reporte, severidad, commit, Windows/Node/pnpm/Python/FFmpeg/GPU, servicios, proyecto
## Pasos               ← lo que escribiste en el formulario
## Error               ← trabajo fallido + comando + últimas líneas de stderr, error del navegador,
                         errores de API recientes, errores del log de la api
## Últimas acciones en la interfaz   ← 15 migas con hora
## Archivos adjuntos   ← carpeta + zip + lista de archivos y por dónde empezar
```

## Logs de la api

La api escribe en consola **y** en `storage\logs\api-AAAA-MM-DD.log` (JSON por línea, rota a
medianoche y borra los de más de 7 días). Cada trabajo guarda en la base su línea de comandos
completa, las últimas 200 líneas de stderr y sus tiempos (`GET /api/jobs/:id/diagnostics`).
Endpoints: `POST /api/reports`, `GET /api/reports`, `GET /api/reports/:id/download`. Ni
`storage\logs` ni `storage\reports` se sirven por `/files`.

## Privacidad

Antes de escribir cualquier archivo se tapa con `[REDACTED]`:

- los valores de las claves de tu `.env` (`*_API_KEY`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`…), donde
  aparezcan;
- todo lo que parezca una clave: `sk-…`/`sk-ant-…`, `ghp_…`, `hf_…`, `AKIA…`, `AIza…`, JWT,
  `Bearer …`, `?token=` / `?api_key=` en URLs, `NOMBRE_KEY=valor`, `"apiKey": "…"`;
- tu carpeta de usuario (`C:\Users\<vos>`) se reemplaza por `~`.

Lo que **sí** queda y conviene mirar antes de compartir fuera de tu PC:

- nombres de archivos y de proyectos, textos de títulos/subtítulos y el texto que mandaste a TTS;
- rutas fuera de tu carpeta de usuario (por ejemplo `D:\clientes\…`);
- con «incluir medios pequeños», las miniaturas y archivos de `medios/`;
- `doctor.txt` muestra el `PATH` de tu sesión.

Si algo no debería salir, borralo de la carpeta y volvé a comprimirla (clic derecho → _Enviar a →
Carpeta comprimida_) o generá el reporte sin medios.
