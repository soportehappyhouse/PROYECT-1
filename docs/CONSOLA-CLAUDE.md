# Consola Claude

La **Consola Claude** es una terminal dentro de Studio donde corre **Claude Code**, el asistente de
Anthropic para la línea de comandos, con **tu suscripción de Claude.ai** (Pro o Max). No usa API key
ni cobra aparte: consume el mismo cupo que usás en claude.ai.

A diferencia del **Asistente** (`Ctrl+Shift+A`, modelo local de Ollama, 100 % en tu PC), la consola
usa Claude en la nube: entiende pedidos largos, mira imágenes (fotogramas, hojas de contactos) y
puede encadenar muchos pasos. Los dos terminan en lo mismo: un **plan de edición** que Studio valida
y que vos confirmás.

## Qué necesitás

- Studio instalado con `scripts\windows\setup.cmd` (instala Claude Code con
  `npm i -g @anthropic-ai/claude-code` cuando hay Node.js 22; se puede saltear con `-SkipClaude`).
- Una cuenta de Claude.ai con plan Pro o Max.

## Primer uso

1. Abrí Studio y apretá `Ctrl+Shift+C` (o la paleta `Ctrl+K` → «Consola Claude»). El panel aparece
   como pestaña junto al Asistente.
2. Arriba ves el estado: **Instalado** (versión), **Sesión** (iniciada / sin iniciar / desconocida) y
   **Corriendo**. Si dice «No instalado», el panel muestra el comando para instalarlo.
3. Tocá **Nueva sesión**. La primera vez Claude Code te pide iniciar sesión: escribí `/login` y
   seguí los pasos en el navegador. También podés hacerlo antes en cualquier terminal con
   `claude auth login`.
4. Claude Code pregunta si confiás en la carpeta y si habilitás el servidor MCP **studio-mcp**
   (definido en `.mcp.json`). Aceptá: son las herramientas para leer y editar el proyecto.
5. Escribí tu pedido en español o tocá uno de los pedidos sugeridos (se pegan en la terminal; revisalos
   y apretá Enter).

Botones: **Nueva sesión** (arranca otra), **Reiniciar** (cierra y vuelve a abrir), cuadrado (cerrar),
**Copiar selección** y **Pegar**. En la terminal: `Ctrl+Shift+C` o `Ctrl+C` con texto seleccionado
copia; `Ctrl+V` pega. Nota: algunos navegadores reservan `Ctrl+Shift+C` (inspector); si no abre el
panel, cambiá el atajo en Ajustes → Atajos.

## Qué puede hacer

Claude ve el proyecto a través de las herramientas de Studio (no edita archivos a mano):

- Leer el proyecto, los medios y la transcripción; mirar un **fotograma** de la vista previa.
- Proponer y aplicar **planes de edición** (cortar silencios, títulos, subtítulos con estilo,
  reencuadre, música, exportación). Antes de borrar clips o exportar **te pregunta** en la consola.
- Lanzar trabajos (transcribir, detectar escenas, quitar fondo, voz, stems) y esperar el resultado.
- **Perfil de estilo**: analizar un video de referencia (hoja de contactos + ritmo de cortes +
  audio), deducir el estilo y guardarlo como perfil para aplicarlo a tus proyectos.
- Redactar y crear un **reporte de error** con los diagnósticos.

Lo que aplica queda en el historial del panel Asistente y se deshace con **Deshacer todo**.

### Ejemplos de pedidos

- «Analizá el video de referencia y proponé un perfil de estilo»
- «Cortá los silencios y exportá para Reels»
- «Poné un título "Receta de pan" al principio con el estilo de la marca y subtítulos animados»
- «Mirá el segundo 12: ¿el texto tapa la cara? Si es así, subilo»
- «Buscá un sonido de whoosh en la biblioteca y ponelo en cada cambio de escena»
- «Redactá un reporte del último error»

## Límites de la suscripción

- Claude Code comparte el cupo de uso de tu plan con claude.ai. Los pedidos con muchas imágenes o
  muchos pasos consumen más. Si llegás al límite, Claude Code te avisa y te dice cuándo se renueva.
- Para ver la cuenta y el modelo en uso: `/status` dentro de la consola.
- Studio no usa el Agent SDK ni ninguna API paga: si no hay sesión iniciada, la consola no funciona
  (el Asistente local sigue andando sin internet).

## Privacidad

- Lo que Claude **lee** (tus pedidos, el resumen del proyecto, la transcripción, los fotogramas o
  imágenes que abre) se envía a Anthropic para responder, según la configuración de privacidad de
  tu cuenta de Claude.ai. Tus videos no se suben enteros: solo lo que Claude abre.
- La consola y las herramientas solo aceptan conexiones de tu propia PC (`127.0.0.1`).
- Studio quita del entorno de Claude Code las variables con pinta de clave: las que terminan en
  `_API_KEY` (incluida `ANTHROPIC_API_KEY`), las que contienen `TOKEN`, `SECRET`, `PASSWORD` o
  `CREDENTIAL`, `ANTHROPIC_AUTH_*` / `ANTHROPIC_BASE_URL`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` y `GOOGLE_APPLICATION_CREDENTIALS`. Solo deja
  `CLAUDE_CODE_OAUTH_TOKEN` (el inicio de sesión de tu suscripción con `claude setup-token`, no una
  API key).
- Además, la consola arranca Claude Code con
  `--settings apps/api/console/claude-console-settings.json`, que **bloquea** (`permissions.deny`)
  leer `.env*` y `models/`, crear o modificar archivos en `storage/`, leer la base
  (`storage/studio.db*`), los reportes (`storage/reports/`) y el registro de Personas
  (`storage/consent/`: fotos, muestras de voz, firmas), y `WebFetch`. Claude sí puede **abrir**
  las imágenes que le devuelven las herramientas (fotogramas, hojas de contactos, miniaturas), que
  están en `storage/`. No toca tu `.claude/settings.json` ni `.mcp.json`; las herramientas `studio_*`
  pasan por la API. Si cambiaste `STORAGE_DIR` a otra carpeta, estas reglas de `storage/` no la
  cubren. Claude también tiene la regla (en `CLAUDE.md`) de no leer `.env` ni tocar `storage/` a
  mano.
- **Personas y licencias (sprint 4)**: desde la consola Claude puede listar las Personas
  (`studio_list_persons`, sin rutas) y cambiar la cara de un clip (`studio_face_swap`, siempre
  preguntándote antes), pero **no** registrar consentimientos ni aceptar licencias: no hay
  herramienta y la API los rechaza (`403 HUMAN_ONLY`, `studio-mcp` manda `X-Studio-Client: mcp`).
  Eso se hace solo desde la pantalla de Studio (Ajustes → Personas, Paquetes de IA).
- Para borrar las conversaciones locales de Claude Code de este proyecto:
  `claude purge <carpeta de Studio>` (agregá `--dry-run` para ver antes qué borra; detalle en
  `claude --help`).

## Problemas comunes

| Síntoma                              | Qué hacer                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| «No instalado»                       | `npm i -g @anthropic-ai/claude-code` o `scripts\windows\setup.cmd`           |
| «Sin iniciar sesión»                 | `/login` en la consola o `claude auth login` en una terminal                 |
| Claude no ve las herramientas Studio | `pnpm build:packages` y en la consola `/mcp` → habilitar `studio-mcp`        |
| «No se pudo conectar con la API»     | Abrí Studio con `scripts\windows\start.cmd` (la API corre en el puerto 3001) |
| La sesión se cerró sola              | «Nueva sesión»; si se repite, `scripts\windows\doctor.cmd`                   |

`scripts\windows\doctor.cmd` muestra la sección «Consola Claude» (versión, sesión, herramientas).
