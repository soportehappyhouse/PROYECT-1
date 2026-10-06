# Sprint 4 — Contratos acordados (Fase C: cara y voz)

Plan: `docs/01-PLAN-BASE-v2.md` (decisiones 2–6 y 9, líneas del Sprint 4, criterio 5, supuestos). Investigación: `docs/INVESTIGACION-IA-LOCAL.md` §6 (cambio de cara; §6.4 compuerta; §6.5 integración), §8 (voz), §10 (GPU), §11 (instalador) y, **vinculante cuando difiere**, `docs/trabajo/fuentes-sprint4.md` (FaceFusion 3.9.1, Chatterbox, RVC, onnxruntime-gpu; verificado 2026-10-06). Patrón de aislamiento a reutilizar: `.venv-gpl` (`apps/workers/studio_workers/vision/gpl.py`: venv propio, sello con hash de requirements, subproceso con argv fijo y JSON por stdout; `models_cli --gpl-venv`; paso 5b de `setup.ps1`). Fecha: 2026-10-06.

## Decisiones del usuario (vinculantes)
- **D3 Cambio de cara** solo con aprobación previa de la persona (caso de uso: dobles de riesgo) → registro de **Personas** con consentimiento y compuerta en el servidor.
- **D4 Etiqueta «Contenido alterado con IA»**: opcional; apagada para uso interno; se propone encendida al marcar «Voy a subirlo a redes» (lógica `forSocial && aiLabel` de Sprint 1: `aiLabelText()` en shared, `nextPublish()` en `apps/web/src/lib/publish.ts`).
- **Licencias**: no existe hoy una cadena de cambio de cara 100 % comercial (FaceFusion carga siempre `arcface_w600k_r50` y `kim_vocal_2`, no comerciales, y `xseg_1`, GPL-3) → **una sola aceptación en pantalla, «Cambio de cara (modelos no comerciales + OpenRAIL-AS)»**, registrada con versión del texto y fecha, exigida **antes de bajar el paquete y antes de cada trabajo de cara** (en el servidor). El analizador NSFW de FaceFusion queda **siempre activo** (no hay flag; su código se autovalida por hash): Studio no lo toca.
- **D2**: todo lo GPL / no comercial / con dependencias en conflicto va en **venv aislado ejecutado como subproceso** (como `.venv-gpl`). Nada de eso se importa en el venv de los workers ni se versiona en el repo.
- **D9 acento rioplatense (revisada con la investigación verificada)**: **sin fine-tuning**. Voz española por defecto = **Chatterbox Multilingual V3** (código de GitHub fijado por SHA; respaldo V2 de PyPI) con `language_id="es"`. El rioplatense sale de **clonar zero-shot ~10 s** de una muestra que consiente: **«Voz propia»** (la del usuario; no necesita registro de consentimiento, lo declara al grabar) o una **Persona** con consentimiento `voice`/`both` (misma compuerta que la cara). **No hay paquete `es-mx-latam` en este sprint** (el código público no lo carga; ver Descubierto). Piper `es_AR-daniela-high` sigue como voz rápida sin GPU y respaldo sin paquete. RVC encima de cualquier TTS sigue disponible.
- **Sin API keys ni URLs privadas**: solo hosts públicos (GitHub releases/tags, `facefusion/facefusion-assets`, Hugging Face sin token, `download.pytorch.org`, PyPI).

## Decisiones tomadas en este documento (puntos abiertos resueltos)
1. **Instalación bajo demanda vía paquetes** (D6), sin flags nuevos en `setup.ps1`: cada venv se crea al descargar su paquete desde la app (como `matting` → `.venv-gpl`). `-Full` (D5) baja `tts-chatterbox` y **solo** baja `faceswap`/`faceswap-extra` si la licencia ya figura aceptada (criterio 5 literal: nada de cambio de cara en disco sin aceptar). `-Update` actualiza los venvs que ya existen si cambió su requirements/lock. El único paso nuevo fijo es **«Runtime Python 3.12 para herramientas»** (winget, igual que el 3.11; se omite si ya está), porque FaceFusion 3.9.1 exige ≥ 3.12.
2. FaceFusion **3.9.1** (`72470819a0373be3388b3929c8f8f311f418fc3c`) en `tools/facefusion/.venv` con **Python 3.12**; Chatterbox en `tools/chatterbox/.venv` con el **Python 3.11.9** de Studio.
3. Swapper por defecto **`hyperswap_1a_256`** (licencia ResearchRAIL, default de FaceFusion, 256 px). Alternativas en el paquete opcional `faceswap-extra`: `ghost_1_256` (Apache-2.0) e `inswapper_128_fp16` (no comercial). La UI muestra cada modelo **con su licencia** (todos pasan por ArcFace, no comercial).
4. **Chatterbox como subproceso persistente por stdin/stdout** (JSON por línea), no servidor HTTP en :8002: sin puerto nuevo; se apaga tras `CHATTERBOX_IDLE_S` (120 s) o cuando el presupuesto de GPU lo pide.
5. Selector de cara destino: `reference` (cara elegida en un fotograma, por defecto) o `one`; **no se ofrece «todas las caras»**.
6. `confirmed: true` en `face.swap` = el usuario confirmó **las dos cosas**: la persona dio su consentimiento y **nadie en el video es menor de edad** (la mayoría de edad de la Persona origen está en el texto del consentimiento).
7. Consentimientos con **historial** (`Person.consents[]`; vale el último vigente); revocar no borra lo generado pero bloquea usos nuevos (los trabajos en cola se revalidan al empezar).
8. «Voz propia» = asset `voice-ref`; **no hay atajo «soy yo» para la cara**: una cara siempre pasa por Persona + consentimiento.
9. Toda voz TTS nueva (Piper, nube, Chatterbox) queda `voice-synthetic`; la clonada, `voice-cloned`. El MP4 exportado lleva `comment` con lo detectado aunque la etiqueta visible esté apagada (trazabilidad invisible, §6.4.5; sin ids ni nombres).
10. Proveedor TTS por defecto en la UI: Chatterbox si el paquete está y los workers están en modo GPU; si no, Piper.
11. **Paso 0** (abajo): el coordinador escribe los contratos compartidos antes de lanzar los 3 agentes.

## Regla común de edición concurrente
Tres agentes Opus en paralelo sobre el mismo árbol. Cada uno toca **solo sus rutas** (listadas por módulo). Archivos compartidos:
- `packages/shared/**`: lo escribe el **Paso 0**; después cada módulo solo agrega archivos propios o funciones en archivos propios (exports: una línea al final de `index.ts` tras releerlo, nunca reescribirlo).
- Python compartido (`packs.py`, `services.py`; `main.py` solo M1; `schemas.py` solo M2): bloques `# BEGIN sprint4:<M1|M2|M3> …` / `# END sprint4:<…>` al final; no se tocan otras líneas (excepción: M3 edita las líneas del pack `rvc-base`). Imports de módulos de otro agente **diferidos** (dentro de la función), como `packs.py` hace con `vision.gpl`.
- `scripts/e2e/run-e2e.mjs` (antes de `const required = results.filter(`), `scripts/e2e/ui-smoke.mjs` (antes de `await browser.close();`) y `scripts/e2e/workers-with-mocks.py` (antes de `settings = get_settings()`): cada módulo inserta **su** bloque `BEGIN/END sprint4:<M>`, tras releer el archivo.
- Manual, `ARQUITECTURA.md`, `fuentes.md`: borrador en `docs/trabajo/modulo-sprint4-<x>.md` («## Borrador manual §NN»); los pega la integración (como 3b). `setup.ps1`, `doctor.ps1`, `.env.example`, `.gitignore`, CI: solo M3.

### Paso 0 (coordinador, un commit `feat(shared): sprint 4 contracts` antes de lanzar)
Copiar los bloques de «Contratos compartidos» a `packages/shared/src` (nuevos `consent.ts`, `face.ts`; aditivos en `media.ts`, `timeline.ts`, `job.ts`, `agent.ts`, `voice.ts`, `voice-ai.ts`, `ai.ts`, `api.ts`, `index.ts`); arreglar los `switch` exhaustivos que rompan con un stub (`face_swap` en `services/agent/*` y `jobs/handlers/agent.ts` → `throw new OpError("Cambio de cara: pendiente")`; `voice-ref` y `chatterbox` donde `tsc` lo pida); en workers `packs.py` agregar a `Pack` `licence_gate: str | None = None` y `tool_status: Callable[[], dict] | None = None`, y a la fila de `pack_status` las claves `"licence_gate"` y `"tool"` (`pack.tool_status()` o `None`); `pnpm --filter @studio/shared export-schemas`; `pnpm typecheck && pnpm test` y `pytest -q` verdes.

## Reglas comunes
1. **Sin secretos**: ninguna key/token; las claves nuevas de `.env` son solo rutas y tiempos. Hugging Face solo repos públicos, **sin `HF_TOKEN`** (el lanzador lo quita del entorno y pone `HF_HUB_OFFLINE=1` en ejecución). Cada archivo de modelo va en el registro estático de `packs.py` con tamaño + hash verificado [V] o, si no se conoce (todo lo de Hugging Face: el sandbox no llega), **trust on first download** como Demucs/SAM 2: la primera descarga registra tamaño + sha256 en `models/manifest.json` y `doctor` muestra «verificación pendiente»; el sha256 de HF también llega por `X-Linked-Etag`. Tags de GitHub y SHAs fijados; revisión de HF fijada en cuanto se conozca (`HfApi().model_info(…, files_metadata=True)` en la PC del usuario), mientras tanto `main` + tamaño + prueba de carga.
2. **Aislamiento GPL/NC**: FaceFusion (código OpenRAIL-AS; pesos NC/ResearchRAIL/GPL) y Chatterbox (torch 2.6.0, numpy < 2) corren **solo como subprocesos** de `tools/facefusion/.venv` y `tools/chatterbox/.venv`, siempre a través del lanzador de M3 (`tools/launch.py`). El repo versiona solo nuestros requirements, locks y scripts puente; FaceFusion se baja a `tools/facefusion/app/` (git-ignored). Nunca se ejecuta el `install.py` de FaceFusion (usa el `pip` del PATH). Nunca conviven `onnxruntime` y `onnxruntime-gpu` en un mismo venv.
3. **UI en español rioplatense**; código, comentarios y logs en inglés; errores al usuario en español.
4. **Windows primero**: `pathlib`; intérprete `Scripts\python.exe`; rutas con espacios o tildes siempre como elementos del argv; `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`; junction (`_winapi.CreateJunction`) en Windows / symlink en Linux para carpetas de modelos; `cwd` fijo y `--temp-path`/`--jobs-path` explícitos (FaceFusion resuelve `.assets`, `.jobs`, `.caches` contra el cwd); rutas cortas (aviso de `LongPathsEnabled` en `doctor`).
5. **spawn con arrays**: `subprocess.Popen([...], shell=False)` / `spawn(cmd, args)`; nunca strings de comando. Cancelar = matar el árbol (`taskkill /T /F /PID <pid>` con argv en Windows; `os.killpg` en POSIX).
6. **Rutas**: todo lo que entra a los workers es relativo a `STORAGE_DIR` y se resuelve con `resolve_input()` / `settings.storage_path()` (rechazan `..` y absolutas); las herramientas reciben rutas absolutas ya resueltas. `storage/consent/**` **nunca** se sirve por `/files` (agregar `consent\/` a la regex `allowedPath` de `app.ts`) ni entra en reportes/zips; la Consola Claude lo tiene denegado (`Read(./storage/consent/**)`). Subidas: nombre generado por el servidor, verificación de tipo real (ffprobe / cabecera de imagen).
7. **Toda operación larga es un job** con progreso (`reportProgress`, SSE) y cancelación. Síncrono solo lo que tarda < 2 s (detectar caras en un fotograma, normalizar una muestra de voz).
8. **GPU**: todo pasa por `GpuBudget.acquire(name, mb, unload)` / `release(name)`; para subprocesos `unload` = terminar el proceso; Chatterbox y FaceFusion nunca conviven entre sí ni con Whisper/RVC (6 GB); sin VRAM → CPU con `warnings:["gpu_fallback_cpu"]`; la web avisa **antes** con `willRunOnCpu(status, feature)`.
9. **Deshacer**: cambio de cara reversible (`Clip.faceSwap.prev` + instantánea de `agent.apply`); TTS/clonación crean assets y clips nuevos. Revocar no es deshacer: queda en auditoría.
10. **Límites**: fotos de Persona ≤ 10, JPG/PNG/WebP ≤ 15 MB c/u, lado ≤ 8192 px; evidencia PNG/JPG/PDF ≤ 20 MB; muestras de voz (Persona o «Voz propia») 5–60 s, ≤ 25 MB (se guardan normalizadas, ≤ 30 s); texto Chatterbox ≤ 5000 caracteres (trozos ≤ 300); `face.swap` ≤ 600 s y ≤ 3840×2160 por trabajo (`CLIP_TOO_LONG`); ≤ 5 muestras por Persona.
11. **Auditoría**: tabla `consent_audit` (solo agregar, sin ruta de borrado): consentimientos, licencias, cada `face.preview`/`face.swap`, cada TTS clonado, baja de Persona.
12. **Solo humanos**: crear consentimientos y aceptar licencias exige `Origin` = la web de Studio y que el pedido **no** traiga `X-Studio-Client: mcp` (que `studio-mcp` manda siempre) → si no, `403 HUMAN_ONLY`. El MCP no tiene herramientas para eso. Defensa razonable, no seguridad fuerte (Studio no tiene autenticación, ARQUITECTURA §1).
13. **CI y sandbox sin descargas**: huggingface.co está bloqueado en el sandbox y CI nunca baja modelos ni crea venvs de herramientas: toda descarga de pack nueva es simulable (`httpx.MockTransport`, `runner` falso) y los mocks de e2e reportan los packs instalados (patrón `workers-with-mocks.py`).
14. Errores: api `ApiError {error:{code, message, details?}}` salvo `PACK_REQUIRED` (cuerpo plano de Sprint 1); workers `{detail, code}`.

## Contratos compartidos (Paso 0, `packages/shared/src`)
```ts
// ---- consent.ts (nuevo) -------------------------------------------------------------------------
import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common.js";
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const CONSENT_DIR = "consent"; // storage/consent/persons/<id>/{photos,voice,consents/<cid>}/…; archive/<id>/
export const CONSENT_TEXT_VERSION = "2026-10-06";
export const CONSENT_TEXT_ES = "Yo, {nombre}, mayor de edad, autorizo expresamente a quien usa este equipo a usar mi {alcance} " +
  "para generar contenido alterado con IA en sus videos (por ejemplo, poner mi cara sobre la de un doble de riesgo o " +
  "leer textos con mi voz). Puedo revocarlo cuando quiera; la revocación impide usos nuevos.";
export const ConsentScopeSchema = z.enum(["face", "voice", "both"]);          // «rostro» | «voz» | «rostro y voz»
export const ConsentMethodSchema = z.enum(["firma en pantalla", "documento adjunto"]);
export const ConsentSchema = z.object({
  id: IdSchema, personId: IdSchema,
  text_version: z.string(), text_sha256: Sha256Schema,      // del texto mostrado, ya con nombre y alcance
  accepted_at: TimestampSchema, method: ConsentMethodSchema, signer_name: z.string().trim().min(1).max(120),
  evidence_path: z.string(), evidence_sha256: Sha256Schema, // firma PNG del canvas, o PDF/JPG/PNG del documento firmado
  scope: ConsentScopeSchema, expires_at: TimestampSchema.optional(), revoked_at: TimestampSchema.optional(),
});
export const PersonPhotoSchema = z.object({ id: IdSchema, path: z.string(), sha256: Sha256Schema,
  width: z.number().int().positive(), height: z.number().int().positive(), faces: z.number().int().nonnegative().nullable() });
export const PersonVoiceSampleSchema = z.object({ id: IdSchema, path: z.string(), sha256: Sha256Schema,
  durationSec: z.number().min(5).max(60) });
export const PersonSchema = z.object({
  id: IdSchema, name: z.string().trim().min(1).max(120), notes: z.string().max(2000).optional(),
  photos: z.array(PersonPhotoSchema).max(10).default([]), voiceSamples: z.array(PersonVoiceSampleSchema).max(5).default([]),
  consents: z.array(ConsentSchema).default([]), createdAt: TimestampSchema, updatedAt: TimestampSchema,
});
export const ConsentStateSchema = z.enum(["vigente", "vencido", "revocado", "sin consentimiento"]);
export const PersonSummarySchema = z.object({ id: IdSchema, name: z.string(), photos: z.number().int(),
  voiceSamples: z.number().int(), face: ConsentStateSchema, voice: ConsentStateSchema, expires_at: TimestampSchema.optional() });
export const PersonCreateSchema = z.object({ name: z.string().trim().min(1).max(120), notes: z.string().max(2000).optional() }).strict();
export const PersonPatchSchema = PersonCreateSchema.partial();
/** Campos multipart de POST /api/persons/:id/consents (+ archivo `evidence`). */
export const ConsentCreateFieldsSchema = z.object({ scope: ConsentScopeSchema, method: ConsentMethodSchema,
  signer_name: z.string().trim().min(1).max(120), text_version: z.string(), expires_at: TimestampSchema.optional(),
  accept: z.literal("true") });
export const LicenceIdSchema = z.enum(["faceswap"]);
export const LICENCES = {
  faceswap: { name_es: "Cambio de cara (modelos no comerciales + OpenRAIL-AS)", text_version: "2026-10-06",
    packs: ["faceswap", "faceswap-extra"],
    urls: ["https://github.com/facefusion/facefusion", "https://github.com/deepinsight/insightface#license", "https://www.licenses.ai/"],
    text_es: "El cambio de cara usa FaceFusion (licencia OpenRAIL-AS, con restricciones de uso: prohíbe suplantar a alguien sin su " +
      "consentimiento, el contenido sexual no consentido y la desinformación) y modelos de terceros: ArcFace, inswapper y " +
      "kim_vocal_2 (InsightFace y otros: solo uso no comercial / investigación), hyperswap (ResearchRAIL) y xseg (GPL-3). " +
      "Acepto usarlos solo sin fines comerciales, con el consentimiento de las personas y sin monetizar el resultado." },
} as const;
export const LicenceAcceptanceSchema = z.object({ id: LicenceIdSchema, text_version: z.string(), text_sha256: Sha256Schema,
  accepted_at: TimestampSchema, revoked_at: TimestampSchema.optional() });
export const LicenceStatusSchema = z.object({ id: LicenceIdSchema, name_es: z.string(), text_es: z.string(),
  text_version: z.string(), urls: z.array(z.string()), packs: z.array(z.string()), accepted: z.boolean(),
  acceptance: LicenceAcceptanceSchema.optional() });
export const LicenceAcceptRequestSchema = z.object({ text_version: z.string(), accept: z.literal(true) }).strict();
/** Espejo de solo lectura para workers/models_cli/doctor: {accepted: {[id]: {text_version, accepted_at}}}. Lo escribe la api. */
export const LICENCE_MIRROR_PATH = "consent/licences.json";
export const AiProvenanceSchema = z.object({
  kind: z.enum(["face", "voice-synthetic", "voice-cloned"]),
  tool: z.string().max(120),                 // "facefusion 3.9.1 hyperswap_1a_256" | "chatterbox mtl-v3" | "piper <voz>"
  personId: IdSchema.optional(), consentId: IdSchema.optional(), self: z.boolean().optional(),
  licences: z.array(LicenceIdSchema).optional(), jobId: IdSchema.optional(), sourceAssetId: IdSchema.optional(),
  createdAt: TimestampSchema,
});
export const ConsentRequiredDetailsSchema = z.object({ personId: IdSchema, scope: z.enum(["face", "voice"]),
  reason: z.enum(["none", "expired", "revoked", "scope", "deleted"]) });
export const LicenceRequiredDetailsSchema = z.object({ licenceId: LicenceIdSchema, text_version: z.string() });
export const ToolIdSchema = z.enum(["facefusion", "chatterbox"]);
export const ToolStateSchema = z.enum(["ready", "stale", "missing", "broken", "python"]);
export const ToolMissingDetailsSchema = z.object({ tool: ToolIdSchema, state: ToolStateSchema, packId: z.string() });
// + types (z.infer) y activeConsent(p, need: "face"|"voice", now?) / consentState(...) (M1 los implementa acá).

// ---- face.ts (nuevo) ----------------------------------------------------------------------------
import { IdSchema, SecondsSchema } from "./common.js";
import { LicenceIdSchema } from "./consent.js";
export const FaceBoxSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  w: z.number().min(0).max(1), h: z.number().min(0).max(1) });                 // fracciones del cuadro
export const FaceDetectRequestSchema = z.object({ assetId: IdSchema, t: SecondsSchema }); // t en segundos del asset
export const FaceDetectResultSchema = z.object({ t: SecondsSchema, width: z.number().int(), height: z.number().int(),
  framePath: z.string(), faces: z.array(z.object({ index: z.number().int().nonnegative(), box: FaceBoxSchema, score: z.number() })) });
export const FaceSwapperModelSchema = z.enum(["hyperswap_1a_256", "ghost_1_256", "inswapper_128_fp16"]);
export const FACE_SWAPPER_INFO = {   // la UI muestra la licencia junto a cada opción
  hyperswap_1a_256: { name_es: "HyperSwap 1a (256 px, recomendado)", licence: "ResearchRAIL", pack: "faceswap" },
  ghost_1_256: { name_es: "Ghost 1 (256 px)", licence: "Apache-2.0", pack: "faceswap-extra" },
  inswapper_128_fp16: { name_es: "InSwapper (128 px, rápido)", licence: "No comercial (InsightFace)", pack: "faceswap-extra" },
} as const;
export const FaceSelectorSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("reference"), t: SecondsSchema, faceIndex: z.number().int().min(0),   // index: izquierda→derecha
    distance: z.number().min(0.05).max(1.5).default(0.3) }),                  // --reference-face-distance (default 3.9.1)
  z.object({ mode: z.literal("one") }),
]);
export const FaceSwapOptionsSchema = z.object({ model: FaceSwapperModelSchema.default("hyperswap_1a_256"),
  enhancer: z.boolean().default(true), enhancerBlend: z.number().int().min(0).max(100).default(80),
  strength: z.number().min(0.1).max(1).default(1) });                           // mezcla con el original (ffmpeg)
const FaceSwapBase = z.object({ personId: IdSchema, assetId: IdSchema, selector: FaceSelectorSchema.default({ mode: "one" }),
  options: FaceSwapOptionsSchema.default({ model: "hyperswap_1a_256", enhancer: true, enhancerBlend: 80, strength: 1 }) });
export const FacePreviewRequestSchema = FaceSwapBase.extend({ t: SecondsSchema });
export const FacePreviewResultSchema = z.object({ beforePath: z.string(), afterPath: z.string(),
  device: z.enum(["cuda", "cpu"]), ms: z.number(), warnings: z.array(z.string()).optional() });
export const FaceSwapRequestSchema = FaceSwapBase.extend({
  range: z.object({ start: SecondsSchema, end: SecondsSchema }).optional(),     // s del asset; con target = in/out del clip
  target: z.object({ projectId: IdSchema, clipId: IdSchema }).optional(),
  confirmed: z.literal(true),               // consentimiento + nadie en el video es menor de edad (decisión 6)
});
export const FaceSwapResultSchema = z.object({ assetId: IdSchema, path: z.string(), frames: z.number().int(), fps: z.number(),
  device: z.enum(["cuda", "cpu"]), model: z.string(), consentId: IdSchema, licences: z.array(LicenceIdSchema),
  clipId: IdSchema.optional(), warnings: z.array(z.string()).optional() });
export const FaceUndoRequestSchema = z.object({ projectId: IdSchema, clipId: IdSchema });
export const WORKER_FACE_ROUTES = { detect: "/face/detect", swap: "/face/swap", task: "/face/tasks/:id",
  cancel: "/face/tasks/:id/cancel" } as const;   // preview = /face/swap con preview_t

// ---- cambios aditivos ---------------------------------------------------------------------------
// media.ts:   MediaKindSchema += "voice-ref"  (muestra de «Voz propia», WAV 24 kHz mono)
//             MediaAssetSchema += aiAltered: z.boolean().optional(), aiProvenance: AiProvenanceSchema.optional()
// timeline.ts ClipSchema += faceSwap: z.object({ prev: z.object({ assetId: IdSchema, in: SecondsSchema, out: SecondsSchema,
//               matte: ClipMatteSchema.optional(), maskRef: ClipMaskSchema.optional() }),
//               personId: IdSchema, consentId: IdSchema, jobId: IdSchema }).optional()
// job.ts:     JobTypeSchema += "face.preview", "face.swap"   (carril workers)
// agent.ts:   FaceSwapOpSchema = z.object({ op: op("face_swap", "Cambiar la cara de un clip por la de una Persona registrada con consentimiento."),
//               clip: ClipRefSchema, person: z.union([z.object({ id: IdSchema }).strict(), z.object({ name: z.string().min(1) }).strict()]),
//               t: TimeSchema.optional(), face_index: z.number().int().min(0).optional(), model: FaceSwapperModelSchema.optional(),
//               enhancer: z.boolean().optional(), strength: z.number().min(0.1).max(1).optional(), ...common }).strict()
//             EditOpSchema += FaceSwapOpSchema;  ALWAYS_CONFIRM_OPS = ["delete_clip", "export", "face_swap"]
// voice.ts:   TtsProviderSchema = z.enum(["piper", "elevenlabs", "openai", "chatterbox"])
//             ChatterboxModelSchema = z.enum(["mtl-v3", "mtl-v2"])          // t3_mtl23ls_v3 (git) | _v2 (PyPI 0.1.7)
//             VoiceRefSchema = z.union([ z.object({ personId: IdSchema }).strict(), z.object({ assetId: IdSchema, self: z.literal(true) }).strict() ])
//             TtsRequestSchema += (todos .optional(), sin default: no cambia Piper) language: z.string().regex(/^[a-z]{2}$/),
//               model: ChatterboxModelSchema, voiceRef: VoiceRefSchema, exaggeration: z.number().min(0.25).max(2),
//               cfg: z.number().min(0).max(1), temperature: z.number().min(0.05).max(2), seed: z.number().int().min(0)
// voice-ai.ts TtsProviderStatusSchema += "falta paquete"
//             TtsProviderInfoSchema += packId?: string, installed?: boolean, supportsClone?: boolean,
//               models?: ChatterboxModel[], languages?: string[], gpu?: boolean, default?: boolean
//             AudioJobResultSchema += provider?: TtsProvider, device?: "cuda"|"cpu", aiVoice?: "synthetic"|"cloned",
//               watermark?: "perth", rtf?: number
// ai.ts:      PackSchema += licence_gate: z.string().nullish(), tool: z.object({ id: ToolIdSchema, state: ToolStateSchema }).nullish()
//             PerfResultSchema += (nullish) rvc_device, chatterbox_rtf, chatterbox_load_s, chatterbox_device, chatterbox_model,
//               facefusion_fps, facefusion_enh_fps, facefusion_startup_s, facefusion_device, facefusion_model
//             FEATURE_PACKS += faceswap: "faceswap", faceswapExtra: "faceswap-extra", chatterbox: "tts-chatterbox"
//             FEATURE_VRAM_MB += faceswap: 3500, chatterbox: 4500   // [S] hyperswap+gfpgan «varios GB»; Chatterbox 3,5–5 GB
// api.ts:     API_ROUTES += persons "/api/persons", person "/api/persons/:id", personPhotos ".../:id/photos",
//               personPhoto ".../:id/photos/:photoId", personVoiceSamples ".../:id/voice-samples", personVoiceSample ".../:sampleId",
//               personConsents ".../:id/consents", personConsentRevoke ".../consents/:consentId/revoke",
//               personConsentEvidence ".../consents/:consentId/evidence", aiLicences "/api/ai/licences",
//               aiLicenceAccept "/api/ai/licences/:id/accept", aiLicenceRevoke "/api/ai/licences/:id/revoke",
//               faceDetect "/api/face/detect", facePreview "/api/face/preview", faceSwap "/api/face/swap",
//               faceUndo "/api/face/undo", voiceSelfRefs "/api/voice/self-refs"
// index.ts:   export * from "./consent.js"; export * from "./face.js";
```

### Códigos de error nuevos (mensajes en español; `details` según los esquemas de arriba)
| HTTP | Código | Mensaje (plantilla) |
| --- | --- | --- |
| 409 | `PACK_REQUIRED` (existente, cuerpo plano) | `faceswap`, `faceswap-extra` o `tts-chatterbox` con su `name_es` y tamaño |
| 403 | `CONSENT_REQUIRED` | «{nombre} no tiene un consentimiento vigente para usar su {cara\|voz} ({motivo}). Registralo en Ajustes → Personas.» |
| 403 | `LICENCE_REQUIRED` | «Para usar el cambio de cara tenés que leer y aceptar su licencia (modelos no comerciales + OpenRAIL-AS) en pantalla: Ajustes → Paquetes de IA.» |
| 403 | `HUMAN_ONLY` | «Esto solo se hace desde la pantalla de Studio, no desde la consola ni el asistente.» |
| 409 | `TOOL_MISSING` | «El entorno aislado de {FaceFusion\|Chatterbox} no está listo ({estado}). Volvé a descargar el paquete en Ajustes → Paquetes de IA o corré scripts\windows\setup.ps1 -Update.» (`state:"python"`: «Falta Python 3.12: corré scripts\windows\setup.ps1 -Update».) |
| 502 | `TOOL_FAILED` | «{FaceFusion\|Chatterbox} terminó con error: {última línea útil del log}.» (`details.logTail`) |
| 409 | `TEXT_OUTDATED` | «El texto del consentimiento/licencia cambió: volvé a leerlo y aceptarlo.» |
| 409 | `VOICE_SAMPLE_MISSING` | «{nombre} no tiene una muestra de voz (5 a 60 s).» |
| 422 | `CONTENT_BLOCKED` | «El analizador de contenido de FaceFusion bloqueó este video o imagen: no se procesa.» |
| 422 | `NO_FACE` | «No se encontró una cara en {la foto\|el fotograma elegido}.» |
| 422 | `RVC_MODEL_INCOMPATIBLE` | «El modelo RVC «{id}» no se puede cargar de forma segura (formato incompatible).» |
| 400 | `CLIP_TOO_LONG` | «Se procesan tramos de hasta 10 min y 4K: dividí el clip.» |
| 400 | `VOICE_SAMPLE_INVALID` | «La muestra tiene que durar entre 5 y 60 s y tener voz.» |
| 404 | `PERSON_NOT_FOUND` | «No existe esa Persona.» |
| 409 | `CONFIRM_REQUIRED` (existente) | `face_swap` sin su índice en `confirmedIndexes` / `confirmed` ausente |

## M1. Personas + consentimiento + cambio de cara (agente «caras»)
Rutas: `packages/shared/src/{consent,face}.ts` (solo funciones: `activeConsent`, `consentState`, `renderConsentText`) + `packages/shared/test/consent.test.ts`; `apps/api/src/services/persons/**` (repo, archivos, gate), `apps/api/src/routes/{persons,face}.ts`, `apps/api/src/jobs/handlers/face.ts`, `apps/api/src/app.ts` (registro + `consent\/` en `allowedPath`), `apps/api/src/routes/ai.ts` (solo: descarga de packs con `licence_gate` sin aceptación → 403 `LICENCE_REQUIRED`), `apps/api/src/services/agent/**` + `jobs/handlers/agent.ts` (op `face_swap`; y en `tts`: `provider: op.voice?.startsWith("chatterbox:") ? "chatterbox" : "piper"`), `apps/api/src/reports/**` (excluir `consent/`), `apps/api/console/claude-console-settings.json`; `apps/workers/studio_workers/face/**` + `routers/face.py` + `main.py` (include_router) + bloques en `packs.py`/`services.py`; `tools/facefusion/{requirements-cuda.txt, requirements-cpu.txt, facefusion.lock.json}`; `apps/web/src/components/{face,consent}/**`, `stores/{persons,face}-store.ts`, `components/dashboard/{SettingsDialog,actions}.ts(x)`, `stores/settings-store.ts` (tab), `components/panels/InspectorPanel.tsx` (botón), menú contextual de clip en `components/timeline/**`, `lib/api*.ts` (errores nuevos); `packages/studio-mcp/src/{tools,api}.ts` + tests; `CLAUDE.md`; `apps/workers/studio_workers/agent/dataset/*` (+3 golden, +6 train con `face_swap`); `docs/trabajo/modulo-sprint4-caras.md`.

**SQLite** (`ensurePersonsSchema(db)` idempotente, como `style_presets`): `persons(id PK, name, data /*Person JSON*/, created_at, updated_at, deleted_at)`, `ai_licences(id PK, data /*LicenceAcceptance*/, updated_at)`, `consent_audit(id INTEGER PK AUTOINCREMENT, at, action, person_id, consent_id, job_id, asset_id, data)`. Cada aceptación/revocación de licencia reescribe `storage/consent/licences.json` (escritura atómica `.tmp` → rename).

**Gate** (lo usan M2 y M3; firma fija): `apps/api/src/services/persons/gate.ts`
```ts
export interface ConsentGate {
  assertConsent(personId: string, need: "face" | "voice"): { person: Person; consent: Consent }; // 404 PERSON_NOT_FOUND | 403 CONSENT_REQUIRED
  voiceSamplePath(personId: string): string;            // relativo a STORAGE_DIR (la más reciente); 409 VOICE_SAMPLE_MISSING
  assertLicence(id: LicenceId): LicenceAcceptance;      // 403 LICENCE_REQUIRED (también si text_version cambió)
  isLicenceAccepted(id: LicenceId): boolean;
  benchFaceSource(): { personId: string; consentId: string; photoPath: string } | null; // 1.ª Persona con cara vigente
  audit(e: { action: string; personId?: string; consentId?: string; jobId?: string; assetId?: string; data?: unknown }): void;
}
export function createConsentGate(db: SqlDatabase, storageDir: string): ConsentGate; // llama ensurePersonsSchema
export function assertHumanOrigin(req: FastifyRequest, config: AppConfig): void;     // 403 HUMAN_ONLY
```

**API** (JSON salvo multipart; todo 127.0.0.1)
| Método | Ruta | Request → Response |
| --- | --- | --- |
| GET / POST | `/api/persons` | `?scope=face\|voice` (solo vigentes) → `PersonSummary[]` / `PersonCreate` → 201 `Person` |
| GET / PATCH / DELETE | `/api/persons/:id` | → `Person` / `PersonPatch` → `Person` / `?confirm=1` → 204: borra fotos y muestras del disco, marca `deleted_at`, mueve consentimientos + evidencia a `consent/archive/<id>/`; sin `confirm` → 409 `CONFIRM_REQUIRED` |
| POST / DELETE / GET | `/api/persons/:id/photos[/:photoId]` | multipart `photo` → `Person` (cuenta caras con workers `/face/detect`, que acepta imagen o video; 0 caras → 422 `NO_FACE`; sin pack `reframe`/`faceswap` → `faces: null` + aviso) / → `Person` / → imagen (no por `/files`) |
| POST / DELETE / GET | `/api/persons/:id/voice-samples[/:sampleId]` | multipart `audio` → `Person` (ffmpeg a WAV 24 kHz mono, `silenceremove` en bordes, ≤ 30 s; 400 `VOICE_SAMPLE_INVALID`) / → `Person` / → audio |
| POST | `/api/persons/:id/consents` | multipart `ConsentCreateFields` + `evidence` (PNG firma ≤ 2 MB / PDF·JPG·PNG ≤ 20 MB) → 201 `Consent`; `assertHumanOrigin`; `text_version ≠ CONSENT_TEXT_VERSION` → 409 `TEXT_OUTDATED`; guarda `text_sha256` del texto renderizado |
| POST / GET | `/api/persons/:id/consents/:cid/revoke` · `…/evidence` | → `Consent` (con `revoked_at`) · → archivo de evidencia |
| GET | `/api/ai/licences` | → `LicenceStatus[]` |
| POST | `/api/ai/licences/:id/accept` · `/revoke` | `LicenceAcceptRequest` → `LicenceAcceptance` (`assertHumanOrigin`; versión vieja → 409 `TEXT_OUTDATED`) · → `LicenceAcceptance` |
| POST | `/api/face/detect` | `FaceDetectRequest` → `FaceDetectResult` (síncrono, YuNet en el venv principal); 409 `PACK_REQUIRED faceswap` |
| POST | `/api/face/preview` | `FacePreviewRequest` → 202 `{jobId}` (`face.preview`) |
| POST | `/api/face/swap` | `FaceSwapRequest` → 202 `{jobId}` (`face.swap`) |
| POST | `/api/face/undo` | `FaceUndoRequest` → `Project` (restaura `clip.faceSwap.prev`, quita `faceSwap`; el asset generado queda en Medios) |

Chequeo previo (preview y swap, en este orden, al encolar **y otra vez al empezar** el job): licencia `faceswap` → pack `faceswap` (y `faceswap-extra` si el modelo lo pide) → consentimiento `face` de `personId` → venv listo (`TOOL_MISSING`) → límites (`CLIP_TOO_LONG`). El job guarda `consentId` y `licences` en payload/resultado y escribe `consent_audit`.

**Jobs** (carril workers): `face.preview` `FacePreviewRequest` → `FacePreviewResult` (PNG antes/después en `renders/face/<jobId>/`, servidos por `/files`). `face.swap` `FaceSwapRequest` → `FaceSwapResult`: con `target`, `range` = `[clip.in, clip.out]`; asset nuevo `renders/face/<jobId>/faceswap.mp4` (`kind:"video"`, `aiAltered:true`, `aiProvenance{kind:"face", tool, personId, consentId, licences, jobId, sourceAssetId}`) + `media.probe` + `media.proxy`; el clip pasa a `assetId` nuevo, `in:0`, `out:range.end-range.start`, `faceSwap.prev` guarda lo anterior; `matte` y `maskRef` de tipo asset se quitan (aviso «volvé a recortar el fondo») y vuelven con Deshacer; `project.publish.flags.aiFace = true`. Cancelar → `POST /face/tasks/:id/cancel`.

**Workers** (snake_case, `studio_workers/face/schemas.py`):
```python
class FaceDetectRequest(BaseModel): path: str; t: float = Field(ge=0)
class DetectedFace(BaseModel): index: int; box: dict[str, float]; score: float      # box x,y,w,h en 0..1
class FaceDetectResult(BaseModel): t: float; width: int; height: int; frame_path: str; faces: list[DetectedFace]
class FaceSelector(BaseModel): mode: Literal["reference", "one"]; t: float | None = None; face_index: int | None = None; distance: float = 0.3
class FaceSwapWorkerRequest(BaseModel):
    source_paths: list[str] = Field(min_length=1, max_length=10)   # consent/persons/<id>/photos/*
    target_path: str; output_base: str                             # renders/face/<jobId>/
    range: tuple[float, float] | None = None; preview_t: float | None = None   # preview_t => un cuadro PNG
    selector: FaceSelector; model: Literal["hyperswap_1a_256", "ghost_1_256", "inswapper_128_fp16"] = "hyperswap_1a_256"
    enhancer: bool = True; enhancer_blend: int = Field(80, ge=0, le=100); strength: float = Field(1.0, ge=0.1, le=1.0)
    consent_id: str = Field(min_length=1); licence_ids: list[Literal["faceswap"]] = Field(min_length=1)
class FaceTaskResult(BaseModel):
    output_path: str; before_path: str | None = None; frames: int; fps: float; proc_fps: float
    device: Literal["cuda", "cpu"]; model: str; timings: dict[str, float]; warnings: list[str] = []; log_tail: list[str] = []
```
- `POST /face/detect` (síncrono, YuNet `cv2.FaceDetectorYN`, imagen o fotograma `t` de un video, caras ordenadas izquierda→derecha). `POST /face/swap` → `{task_id}`; `GET /face/tasks/{id}` → `{status, progress, message, result: FaceTaskResult, error, code}`; `POST /face/tasks/{id}/cancel`. Defensa en profundidad: `licence_ids` deben figurar en el espejo (`toolvenv.licence_accepted`, import diferido; si no, 403 `LICENCE_REQUIRED`); todas las rutas con `resolve_input`.
- Runner `face/runner.py`: argv/entorno/cwd con `toolvenv.command("facefusion", "facefusion.py", args)` (M3, import diferido). Para video, primero recorta el tramo con ffmpeg (`-ss/-to` con reencode preciso, `.mp4`); para la vista previa, extrae el fotograma a PNG (`-o` debe tener la extensión del target). Argumentos de `headless-run` **verificados en 3.9.1** (`fuentes-sprint4.md` §1.4; fijarlos en un test de snapshot del argv): `--source-paths <fotos…> --target-path <t> --output-path <o> --processors face_swapper [face_enhancer] --face-swapper-model <m> --face-enhancer-model gfpgan_1.4 --face-enhancer-blend <b> --face-selector-mode reference|one --reference-frame-number <n> --reference-face-position <i> --reference-face-distance <d> --face-selector-order left-right --face-detector-model yolo_face --face-mask-types box occlusion --execution-providers cuda|cpu --execution-device-ids 0 --execution-thread-count 4 --video-memory-strategy moderate --output-video-encoder libx264 --output-video-quality 80 --output-audio-encoder aac --temp-path <storage/tmp/ff/<jobId>> --jobs-path <storage/tmp/ff/<jobId>/jobs> --download-providers github --log-level info`. `PATH` del hijo incluye las carpetas de `ffmpeg`/`ffprobe` de Studio (FaceFusion las exige; `curl.exe` viene con Windows 10/11).
- Resultado: `headless-run` sale 0 u 1 sin distinguir el motivo → el runner **captura stdout/stderr** (últimas 40 líneas en `log_tail`): si hay mensaje del analizador de contenido (texto exacto a fijar en un test con la salida real de 3.9.1 [U]) o exit 1 sin salida y sin errores de modelo/descarga → 422 `CONTENT_BLOCKED`; otro fallo → 502 `TOOL_FAILED`. FaceFusion valida su `content_analyser` por CRC32 (`common_pre_check`): Studio **nunca** lo edita ni pasa flags para eso (no existen). El analizador revisa solo el **destino**; las fotos de origen son de una Persona con consentimiento (filtro aparte: Descubierto). Falta un modelo o su `.hash` → `PACK_REQUIRED` **antes** de lanzar (si estuvieran, FaceFusion no descarga nada). `strength < 1` → ffmpeg `blend` del resultado sobre el original (fuera de la cara los píxeles son iguales). Salida H.264 CRF 16 + audio original. Progreso: % que imprime FaceFusion; si no se puede leer, estimado con `facefusion_fps`.
- GPU: `budget.release()` + `acquire("facefusion", 3500, kill)`; en CUDA se pasa solo `cuda` (FaceFusion no cae solo a CPU: sin DLLs sale con 1 → `TOOL_FAILED` con la pista de `doctor`); sin VRAM → `cpu` + `gpu_fallback_cpu` (la web avisa antes «~15–60 min por minuto»).
- Packs (bloque M1 en `packs.py`), ambos con `licence_gate="faceswap"`, `post_install_env` = `toolvenv.ensure("facefusion")`, `extra_status` = `toolvenv.status_rows`, `tool_status` = `toolvenv.status_summary`: **`faceswap`** «Cambio de cara (FaceFusion 3.9.1)», group `faceswap`, license «OpenRAIL-AS (FaceFusion) + modelos no comerciales, ResearchRAIL, GPL-3, Apache, MIT, CC-BY-4.0 — aislado en tools\facefusion», ≈ 1806 MB de modelos [V] + venv ≈ 2,2 GB (onnxruntime-gpu 207 MB + nvidia cu12 ≈ 1,65 GB + resto [V/S]): `NUMPY` + `OPENCV_HEADLESS` (venv principal, para `/face/detect`), YuNet (mismo `FileItem`/dest que `reframe`) y de `https://github.com/facefusion/facefusion-assets/releases/download/<models-X.Y.Z>/` cada `.onnx` + su `.hash` (CRC32) a `models/facefusion/`, con tamaño y CRC32 de `fuentes-sprint4.md` §1.5 (sha256 por primera descarga): `hyperswap_1a_256` (3.3.0), `nsfw_1/2/3` (3.3.0), `fairface`, `yoloface_8n`, `fan_68_5`, `2dfan4`, `bisenet_resnet_34`, `arcface_w600k_r50`, `kim_vocal_2` (3.0.0), `xseg_1` (3.1.0), `gfpgan_1.4` (3.0.0); verificación posterior: `crc32(onnx) == .hash`. **`faceswap-extra`** «Modelos extra de cambio de cara»: `ghost_1_256` + `crossface_ghost` + `inswapper_128_fp16` (≈ 815 MB [V]); se pide al elegir uno de esos modelos (409 `PACK_REQUIRED`).
- `tools/facefusion/facefusion.lock.json`: `{version:"3.9.1", commit:"72470819a0373be3388b3929c8f8f311f418fc3c", source_url:"https://github.com/facefusion/facefusion/archive/72470819a0373be3388b3929c8f8f311f418fc3c.zip", source_sha256:null /* primera descarga */, python:"3.12"}`. `requirements-cuda.txt` = `requirements.txt` de 3.9.1 **sin** las líneas `onnxruntime*` (`gradio==5.50.0`, `gradio-rangeslider==0.0.8`, `numpy==2.4.6`, `onnx==1.23.1`, `opencv-python-headless==5.0.0.93`, `tqdm==4.70.1`, `scipy==1.18.1`) + `onnxruntime-gpu[cuda,cudnn]==1.24.4`; `requirements-cpu.txt` = el `requirements.txt` de 3.9.1 tal cual (`onnxruntime==1.30.0`).

**Web**: Ajustes → pestaña **«Personas»** (`SettingsTab` += `"persons"`; paleta «Personas y consentimientos»): lista con estado por alcance (vigente / vencido / revocado / sin consentimiento), crear, fotos (arrastrar y soltar, contador de caras), muestras de voz (subir o grabar 10 s), **«Registrar consentimiento»**: texto versionado con nombre y alcance, pestañas «Firma en pantalla» (canvas: firma la persona; nombre de quien firma) / «Documento adjunto», alcance, vencimiento opcional, casilla «Leí este texto con la persona y lo acepta»; «Revocar»; «Borrar persona» con confirmación. **`LicenceDialog`** global (evento `window` `studio:licence:open {licenceId}` y 403 `LICENCE_REQUIRED`): texto completo, licencia de cada modelo, enlaces, casilla «Entiendo que son de uso no comercial y con restricciones» + «Aceptar»; fecha de aceptación y «Revocar». Asistente **«Cambiar cara»** (`components/face/FaceSwapWizard.tsx`; entradas: menú contextual del clip de video «Cambiar cara…», botón en Propiedades, paleta; **sin atajo**): 1. Persona (solo con cara vigente; enlace «Registrar persona») → 2. Cara en el video (fotograma en el cursor con cajas de `/face/detect`, clic para elegir, deslizador para otro momento) → 3. Opciones (modelo **con su licencia** de `FACE_SWAPPER_INFO`, mejorador + mezcla, intensidad) + **vista previa de 1 fotograma** antes/después → 4. Aplicar: casilla obligatoria «La persona dio su consentimiento y nadie en el video es menor de edad», progreso y estimación (`facefusion_fps`). Propiedades del clip: insignia «IA: cara (Persona)» y «Deshacer cambio de cara». `CONSENT_REQUIRED` → aviso con botón «Abrir Personas»; `CONTENT_BLOCKED`/`TOOL_FAILED` → mensaje + «Reportar error» con el `jobId`.

**MCP / Asistente**: `studio_list_persons {}` (solo lectura: `PersonSummary[]`, sin rutas) y `studio_face_swap {projectId?, clipId, personId, t?, faceIndex?, model?, enhancer?, strength?, confirmed: true, wait?}` → `POST /api/face/swap` con `target` → espera → `{assetId, clipId}`; el esquema exige `confirmed: z.literal(true)`; la descripción obliga a preguntar «¿Cambio la cara de «clip» por la de «persona»? ¿Confirmás que nadie en el video es menor de edad?». `face.swap` **no** entra en `RUNNABLE_JOBS`. `studio-mcp` manda `X-Studio-Client: mcp` en todo pedido. `CLAUDE.md`: filas de las 2 herramientas, op `face_swap` en el resumen de EditPlan y regla «Nunca registres consentimientos ni aceptes licencias: no hay herramienta y la API lo rechaza; pedile al usuario que lo haga en Ajustes». EditPlan `face_swap`: el resolver mapea `person.name` → id (ambiguo o sin consentimiento vigente → `unresolved` con pregunta «Registrá el consentimiento de X en Ajustes → Personas»), `t`/`face_index` → `selector`; `risks`: «Cambio de cara con IA: queda marcado como contenido alterado»; `agent.apply` lo corre como sub-job `face.swap` con `confirmed:true` solo si su índice está en `confirmedIndexes` (si no, 409 `CONFIRM_REQUIRED`).

**Tests**: shared `consent.test.ts` (`activeConsent`: `both` cubre ambos, vencido, revocado, historial; `face_swap` en `ALWAYS_CONFIRM_OPS`; union `person`). api `persons.test.ts` (CRUD, límites, `HUMAN_ONLY` sin `Origin` o con `X-Studio-Client: mcp`, `TEXT_OUTDATED`, `GET /files/consent/...` → 404, baja), `licences.test.ts` (aceptar/revocar/espejo, descarga de pack con gate → 403), `face-swap.test.ts` (orden del chequeo previo, revocación con el job en cola → `CONSENT_REQUIRED`, licencia revocada → `LICENCE_REQUIRED` al empezar, asset `aiAltered` + `clip.faceSwap` + `/api/face/undo`, auditoría), agente (`face_swap` resuelto, 409 sin confirmar), reporte de error sin `consent/`. workers `test_face_runner.py` (snapshot del argv como lista, sin shell, `cwd`/`--temp-path`, salida NSFW → `CONTENT_BLOCKED`, otro exit 1 → `TOOL_FAILED` con `log_tail`, modelo o `.hash` faltante → `PACK_REQUIRED`, verificación CRC32, tramo + `strength`), `test_face_router.py` (espejo, `consent_id` requerido, `..` en `source_paths` → 400). studio-mcp: `studio_face_swap` sin `confirmed` rechazado; header `X-Studio-Client`. Mock e2e (`STUDIO_MOCK_FACE=0` lo apaga): packs `faceswap`/`faceswap-extra` instalados, `FACEFUSION_PYTHON` = intérprete actual y `FACEFUSION_APP_DIR=scripts/e2e/fake_facefusion/` (`facefusion.py` falso: copia el destino con `drawbox` en la cara, imprime %, y si el nombre de la fuente contiene `nsfw` imprime el mensaje del analizador y sale con 1). E2E: «sprint4: persons CRUD + consentimiento firmado + HUMAN_ONLY», «sprint4: face.swap 403 LICENCE_REQUIRED / CONSENT_REQUIRED / revocado», «sprint4: face.swap mock → asset aiAltered + clip.faceSwap + undo», «sprint4: NSFW mock → CONTENT_BLOCKED», «sprint4: EditPlan face_swap sin confirmedIndexes → 409», «sprint4: studio_face_swap por stdio sin confirmed → rechazado». UI smoke: «Sprint 4: Ajustes → Personas: crear, firmar en pantalla, consentimiento vigente», «Sprint 4: Cambiar cara (mock): vista previa, aplicar, insignia IA, deshacer».

Manual: **§24 Personas y consentimiento** (registrar con firma o documento, revocar, dónde se guarda, nunca sale de la PC), **§25 Cambiar cara** (asistente, licencia y modelos, NSFW fijo, tiempos, deshacer, aviso de redes). **Solo en tu PC**: fps reales a 1080p con y sin GFPGAN (meta [S] 15–25 / 6–12), VRAM real de hyperswap + gfpgan, que `CUDAExecutionProvider` cargue en `tools\facefusion`, mensaje real del rechazo NSFW, calidad en primeros planos.

## M2. Voz: Chatterbox TTS + clonación (agente «voz»)
Rutas: `packages/shared/src/voice-clone.ts` (nuevo: `parseChatterboxVoice`, `CHATTERBOX_DEFAULTS`, `validateChatterboxRequest`) + test; `apps/api/src/routes/voice-ai.ts`, `apps/api/src/voice-ai/**` (`handlers.ts`: TTS chatterbox + RVC pasa `device` y hereda `aiAltered/aiProvenance` del origen; `media-bridge.ts`: `registerAudioAsset` acepta `kind`, `aiAltered`, `aiProvenance`); `apps/workers/studio_workers/tts/{chatterbox.py, providers.py}` + `routers/tts.py` + `schemas.py` (solo clases TTS) + bloques en `packs.py`/`services.py`; `tools/chatterbox/{requirements.txt, chatterbox.lock.json, studio_tts_server.py}`; `apps/web/src/components/panels/VoicePanel.tsx` + `stores/voice-*.ts`; `docs/trabajo/modulo-sprint4-voz.md`.

**Voces** (`voice` de `TtsRequest`, también desde el op `tts` del Asistente): `chatterbox:multilingual` (voz de `conds.pt`), `chatterbox:self` («Voz propia» más reciente), `chatterbox:person:<personId>`. `parseChatterboxVoice(voice) → {voiceRef?}`; los campos explícitos `voiceRef`/`model` ganan. Defaults: `language "es"` (`language_id="es"`; 23 idiomas, `SUPPORTED_LANGUAGES`), `model` = el instalado (`mtl-v3`; `mtl-v2` en respaldo), `exaggeration 0.5`, `cfg 0.5` (con referencia en el mismo idioma deja pasar el acento del hablante: lo que buscamos para el rioplatense; 0,3 si la referencia habla rápido; 0 solo si el idioma de la referencia difiere), `temperature 0.8`; texto ≤ 5000.

**API**
| Método | Ruta | Request → Response |
| --- | --- | --- |
| GET | `/api/voice/tts/providers` | → `TtsProviderInfo[]` + fila `{id:"chatterbox", name:"Chatterbox (local, GPU)", enabled: pack instalado, status:"local"\|"falta paquete", packId:"tts-chatterbox", installed, supportsClone:true, models, languages, gpu:true, default}` (`default` según decisión 10) |
| GET | `/api/voice/tts/voices` | (proxy) + voz `{provider:"chatterbox", id:"chatterbox:multilingual", name:"Chatterbox multilingüe", language:"es", installed}` |
| POST | `/api/voice/tts` | `TtsRequest` con `provider:"chatterbox"` → 202 `{jobId}`; sin pack → 409 `PACK_REQUIRED tts-chatterbox` (la web ofrece «Descargar» o «Usar Piper»); `voiceRef.personId` → `gate.assertConsent(id,"voice")` (403) + `gate.voiceSamplePath` (409 `VOICE_SAMPLE_MISSING`); `voiceRef.assetId` → asset `kind:"voice-ref"` (si no, 400) |
| GET / POST | `/api/voice/self-refs` | → `MediaAsset[]` (kind `voice-ref`) / multipart `audio` + campo `attestSelf=true` (obligatorio) → 201 `MediaAsset` «Voz propia (fecha)»: WAV 24 kHz mono normalizado, 5–60 s (400 `VOICE_SAMPLE_INVALID`); se borra con `DELETE /api/media/:id` |

**Job `voice.tts`** (handler existente, ampliado): repite los chequeos al empezar; resultado `AudioJobResult` + `provider`, `device`, `aiVoice:"synthetic"|"cloned"`, `watermark:"perth"` (Chatterbox), `rtf`; el asset nuevo lleva `aiAltered:true` y `aiProvenance{kind:"voice-cloned"|"voice-synthetic", tool, personId?, consentId?, self?, jobId}` (Piper y nube también: `voice-synthetic`); clon de Persona → `gate.audit({action:"voice.clone"})`. El Asistente sigue en Piper salvo voz `chatterbox:*` (la línea en `agent.ts` la pone M1).

**Workers**: `TtsRequest` (CamelModel, aditivo) `language: str | None`, `model: Literal["mtl-v3","mtl-v2"] | None`, `voice_ref: VoiceRef | None` (`VoiceRef{path: str, consent: str}` = `"self"` o el consentId, para el log), `exaggeration`, `cfg`, `temperature`, `seed` (mismos rangos que zod); `TtsResult` += `device`, `warnings`, `watermark`, `rtf`, `model`; `TtsProviderId` += `"chatterbox"`; `TtsProviderInfo` += `pack_id`, `installed`, `supports_clone`, `models`, `languages`, `gpu`. `ChatterboxProvider` (en `build_providers`) → `ChatterboxClient` (único, en `services.py`): arranca perezoso con `toolvenv.command("chatterbox", "studio_tts_server.py", ["--models-dir", <models/chatterbox>, "--device", cuda|cpu, "--t3", v3|v2])` (+ `--mock` en e2e), espera `ready` (≤ 180 s la primera carga), `GpuBudget.acquire("chatterbox", 4500, unload=client.stop)` (antes descarga Whisper/RVC), se apaga tras `CHATTERBOX_IDLE_S` y libera el presupuesto; si el hijo muere, un reintento y después `TOOL_FAILED`; CPU → `gpu_fallback_cpu` + `chatterbox_cpu_slow`. Texto partido en trozos ≤ 300 caracteres por oración (Chatterbox genera ≤ ~40 s por llamada), 120 ms de silencio entre trozos, progreso por trozo; WAV 24 kHz mono → MP3 con el camino existente.

Protocolo del puente (JSON por línea; stdout solo eventos, logs a stderr; rutas absolutas ya resueltas por los workers):
```
stdin : {"id":"<job>","op":"synthesize","text":"…","language":"es","ref":"C:\\…\\ref.wav"|null,
         "exaggeration":0.5,"cfg":0.5,"temperature":0.8,"seed":0,"out":"C:\\…\\renders\\<job>.wav"} | {"op":"ping"} | {"op":"shutdown"}
stdout: {"event":"ready","device":"cuda","load_s":14.2,"model":"mtl-v3"}
        {"event":"progress","id":"…","chunk":2,"chunks":5}   {"event":"done","id":"…","out":"…","duration_s":12.4,"sample_rate":24000,"rtf":0.62}
        {"event":"error","id":"…","code":"MODEL_MISSING|REF_INVALID|CUDA_OOM|INTERNAL","message":"…"}
```
`studio_tts_server.py`: `ChatterboxMultilingualTTS.from_local(dir, device, t3_model="v3")` (en V2/PyPI 0.1.7 no existe `t3_model`: se llama sin él) y `generate(text, language_id, audio_prompt_path, exaggeration, cfg_weight, temperature)` [V firma en master]; corre con `HF_HUB_OFFLINE=1` y sin `HF_TOKEN` (lo pone el lanzador); **no desactiva** PerTh (la librería lo aplica siempre en `generate`; si `perth.PerthImplicitWatermarker` es `None` → `TOOL_MISSING broken`); `--mock` = tono de 220 Hz (330 Hz si hay `ref`) de 0,06 s por carácter, sin torch.

**Pack `tts-chatterbox`** (bloque M2): «Voz avanzada (Chatterbox: español y clonación)», group `voice`, license «MIT (Chatterbox y PerTh, Resemble AI); marca de agua PerTh siempre activa», ≈ 6–6,5 GB (venv con torch 2.6.0 cu124 ≈ 3 GB [S] + modelos ≈ 3,2 GB [S]); `post_install_env` = `toolvenv.ensure("chatterbox")`, `extra_status` = `toolvenv.status_rows`, `tool_status` = `toolvenv.status_summary`. Archivos de `https://huggingface.co/ResembleAI/chatterbox/resolve/<rev>/` a `models/chatterbox/` (trust on first download, regla 1): `ve.pt`, `t3_mtl23ls_v3.safetensors` (≈ 2,14 GB), `s3gen.pt` (≈ 1,06 GB), `grapheme_mtl_merged_expanded_v1.json`, `conds.pt`, `Cangjie5_TC.json`; si `ensure` cayó al respaldo V2, el mismo job baja `t3_mtl23ls_v2.safetensors` en lugar del V3 (la lista de archivos sigue el `variant` del sello). `tools/chatterbox/chatterbox.lock.json`: `{chatterbox_git:"https://github.com/resemble-ai/chatterbox.git", chatterbox_sha:"5de7a54aa4e5e2baadb0182dde554908b48b85c2", perth_git:"https://github.com/resemble-ai/Perth.git", perth_sha:"ff1c8ac55a976971245cdd53c18d6131ca00d993", fallback_pypi:"chatterbox-tts==0.1.7", python:"3.11", torch:"2.6.0", torch_cuda_index:"https://download.pytorch.org/whl/cu124"}`. `requirements.txt` (dependencias explícitas porque Chatterbox se instala `--no-deps`, sin gradio): `numpy>=1.24,<2`, `librosa==0.11.0`, `s3tokenizer`, `transformers==5.2.0`, `diffusers==0.29.0`, `conformer==0.3.2`, `safetensors==0.5.3`, `spacy-pkuseg`, `pykakasi==2.3.0`, `pyloudnorm`, `omegaconf`, `huggingface_hub`. En RTX 50xx torch 2.6 no tiene `sm_120` → CPU con aviso `gpu_arch_unsupported`.

**Web** (Voz y audio → «Texto a voz»): selector **Motor** (Piper / Chatterbox / ElevenLabs / OpenAI según `status`; Chatterbox sin pack → «Descargar paquete (X GB)»); para Chatterbox: **Idioma**, **Voz a clonar** (Ninguna · Voz propia · Persona… — de `GET /api/persons?scope=voice`; sin consentimiento de voz no aparecen), deslizadores «Expresividad» (exaggeration) y «Fidelidad al acento de la referencia» (cfg), estimación «≈ X s» con `chatterbox_rtf`, aviso de CPU (`willRunOnCpu(status,"chatterbox")`), nota «Lleva una marca de agua inaudible (PerTh)», versión del modelo (V3 / V2 respaldo). Sección **«Voz propia»**: «Grabar 10 s» (MediaRecorder; frase para leer: «Che, ¿viste que mañana llueve? Yo llevo el paraguas, vos traé el mate y nos vemos en la plaza a las cinco.») o «Subir archivo», casilla obligatoria «Soy yo: es mi propia voz», escuchar/borrar. Tras generar con clon: «Marcado como voz clonada (Revisión para redes)».

**Tests**: shared `voice-clone.test.ts` (parseo de voces, defaults, rangos). api `voice-chatterbox.test.ts` (proveedores con/sin pack, `PACK_REQUIRED`, 403 con Persona sin consentimiento de voz o revocado, `VOICE_SAMPLE_MISSING`, `self-refs` sin `attestSelf` → 400 y límites, `voice-synthetic` vs `voice-cloned`, RVC hereda provenance y devuelve `device`, op `tts` con `chatterbox:self` → proveedor chatterbox). workers `test_chatterbox_client.py` (protocolo con `--mock`, apagado por inactividad, `unload` del presupuesto mata el hijo, reinicio único y luego `TOOL_FAILED`, partición ≤ 300, aviso CPU), `test_tts_router.py` (rama chatterbox, `..` en `voice_ref.path` → 400), lista de archivos del pack según `variant` v3/v2 (sin red). Mock e2e `STUDIO_MOCK_CHATTERBOX` (pack instalado + `CHATTERBOX_PYTHON` = intérprete actual + `--mock`). E2E: «sprint4: tts chatterbox (mock) → asset voice-synthetic», «sprint4: Voz propia → voice-ref + clon → voice-cloned», «sprint4: voiceRef Persona sin consentimiento de voz → 403», «sprint4: sin pack tts-chatterbox → 409; op tts del Asistente sigue en Piper». UI smoke: «Sprint 4: Voces: motor Chatterbox (mock), Voz propia y clonación con Persona».

Manual: **§26 Voces: Chatterbox y clonación** (motores, por qué Piper sigue, cómo grabar la Voz propia para que suene rioplatense, consentimiento para terceros, PerTh, V3/V2, tiempos). **Solo en tu PC**: instalación real desde git (SHAs) o caída a V2, RTF y VRAM en la 4050 (meta RTF ≤ 1), primera carga, y **prueba de escucha A/B** (3 frases rioplatenses, cfg 0,3 / 0,5 / 0,7, exaggeration 0,5 / 0,7) para fijar el default que mejor conserva el acento.

## M3. Runtime de herramientas + RVC en CUDA + instalador + rendimiento + redes (agente «herramientas»)
Rutas: `apps/workers/studio_workers/{toolvenv.py (nuevo), models_cli.py, perf.py, rvc_engine.py, routers/rvc.py, routers/packs.py}` + líneas del pack `rvc-base` en `packs.py`/`models_manifest.py`; `tools/launch.py` (nuevo); `scripts/windows/{setup.ps1, doctor.ps1}`, `.env.example`, `.gitignore`, `.github/workflows/ci.yml`; `packages/shared/src/ai-content.ts` (nuevo) + test; `apps/api/src/services/ai-provenance.ts` (nuevo) + herencia en `jobs/handlers/{voice-effect,ai,audio-stems,vision}.ts`, `jobs/handlers/ai.ts` (`perf.run` pasa `face_source_path` de `gate.benchFaceSource()` y `licences`), `apps/api/src/services/ffmpeg/**` (metadato); `apps/web/src/components/dashboard/AiPacksTab.tsx`, `components/panels/{SocialReview,MediaPanel}.tsx`, `lib/publish.ts`; `docs/trabajo/modulo-sprint4-herramientas.md`.

**Runtime Python 3.12** (`setup.ps1`, paso nuevo tras «Python 3.11», mismo mecanismo): `Find-Python312` (`py -3.12`, registro, PATH) → si falta, `Install-WingetPackage 'Python.Python.3.12' @('--scope','user','--version','3.12.10')` (última 3.12 con instalador binario [U]; si esa versión no está, sin `--version`) → «Python 3.12 (herramientas)» ok/omitido; con `-SkipWinget` solo verifica. Solo lo usa `tools/facefusion/.venv`. Los workers lo encuentran con `FACEFUSION_BASE_PYTHON` (si está en `.env`), `py -3.12` o `python3.12`; si no → `TOOL_MISSING state:"python"`.

**Lanzador genérico `tools/launch.py`** (lo ejecuta el python del venv de cada herramienta): `launch.py --tool facefusion|chatterbox [--chdir <dir>] [--preload-ort] -- <script> <args…>` → fija `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `OMP_NUM_THREADS=1` (facefusion), quita `HF_TOKEN`, pone `HF_HUB_OFFLINE=1` y `HF_HOME=<models/<tool>/.hf>`; con `--preload-ort`: `os.add_dll_directory` + `PATH` para cada `site-packages\nvidia\*\bin` (curand/nvrtc) y `onnxruntime.preload_dlls()` (cuBLAS, cuFFT, cudart, cuDNN 9) antes de importar nada de la herramienta; `os.chdir`, `sys.path.insert(0, cwd)`, `sys.argv = [script, *args]`, `runpy.run_path(script, run_name="__main__")`. Errores de arranque → una línea JSON `{"event":"error","code":"LAUNCH_FAILED","message":…}` y exit 2.

**`toolvenv.py`** (firma fija; M1/M2 la importan diferida):
```python
ToolId = Literal["facefusion", "chatterbox"]
@dataclass(frozen=True)
class ToolSpec:
    id: ToolId; pack_id: str; python: Literal["3.11", "3.12"]   # 3.11 = intérprete base de los workers
    lock: Path                                   # tools/<id>/<id>.lock.json
    requirements: dict[str, Path]                # {"cuda": …, "cpu": …}
    check: list[str]                             # python -c a correr vía launch.py (imports; ORT con sesión CUDA real)
    python_env: str; app_dir_env: str | None     # FACEFUSION_PYTHON / FACEFUSION_APP_DIR, CHATTERBOX_PYTHON (tests, avanzado)
TOOLS: dict[ToolId, ToolSpec]
def venv_dir(tool: ToolId) -> Path: ...          # tools/<id>/.venv
def status(tool: ToolId) -> dict[str, Any]: ...  # {state, python, dir, version, variant?, providers?}
def ensure(tool: ToolId, *, use_cuda: bool, on_line=None, runner=None, force=False) -> str: ...  # "omitido" | "ejecutado"
def command(tool: ToolId, script: str, args: list[str]) -> tuple[list[str], dict[str, str], Path]: ...  # argv, env, cwd (vía launch.py)
def status_rows(tool: ToolId) -> list[dict[str, Any]]: ...  # Pack.extra_status
def status_summary(tool: ToolId) -> dict[str, str]: ...     # {id, state} → Pack.tool_status / PackSchema.tool
def licence_accepted(licence_id: str) -> bool: ...          # lee storage/consent/licences.json (face router, packs, models_cli)
```
`ensure("facefusion")`: venv con Python 3.12 → `pip install -U pip` → baja el zip del lock (sha256 verificado o registrado la primera vez) y lo extrae a `tools/facefusion/app/` → `pip uninstall` de todo `onnxruntime*` → `pip install -r requirements-cuda.txt|cpu.txt` (siempre `<venv python> -m pip`, nunca `install.py`) → junction `app/.assets/models` → `models/facefusion` → `check` vía `launch.py --preload-ort`: `InferenceSession(nsfw_2.onnx, providers=["CUDAExecutionProvider"]).get_providers()[0] == "CUDAExecutionProvider"` (si el modelo aún no está, solo `get_available_providers()`; si CUDA no carga: aviso `onnx_cuda_unavailable` + guía de `doctor`). `ensure("chatterbox")`: venv 3.11 → `pip install -U pip wheel "setuptools<82"` → `torch==2.6.0 torchaudio==2.6.0` (con CUDA, `--index-url` cu124) → Perth `@ git+…@<perth_sha>` → `-r requirements.txt` → `--no-deps chatterbox-tts @ git+…@<chatterbox_sha>` (`variant v3`); si falla Git/GitHub → `pip install chatterbox-tts==0.1.7 "setuptools<82"` (`variant v2`, aviso `chatterbox_v2_fallback`) → `check` (`import chatterbox.mtl_tts, perth; assert perth.PerthImplicitWatermarker`). Sello `tools/<id>/.venv/.studio-tool-install`: `<sha256(req+lock)[:16]> <cuda|cpu>`, `variant <v3|v2>`, `source <sha>`. Estados: `missing`, `stale` (cambió requirements/lock o perfil CPU↔CUDA: se recrea el venv), `broken` (falla `check`), `python`. `models_cli --tool-venv facefusion|chatterbox status|ensure [--json] [--report <file>]`.

**Instalador** (decisión 1): paso «Herramientas aisladas (tools\facefusion, tools\chatterbox)» tras el 5b: por cada herramienta, si su venv existe o hay `-Full` (facefusion: además licencia aceptada en el espejo) → `models_cli --tool-venv <id> ensure --report` (omitido si el sello coincide); si no → «se instala al descargar el paquete desde Ajustes». `-Full` agrega `tts-chatterbox` a la secuencia de packs y `faceswap` solo con licencia aceptada (si no: «requiere aceptar la licencia en Studio»). `models_cli --packs all` y `POST /packs/{id}/download` (workers) omiten/rechazan (403 `LICENCE_REQUIRED`) los packs con `licence_gate` no aceptado. Actualizar `.SYNOPSIS` (tamaño de `-Full`: ≈ 4,1 GB + ≈ 6,5 GB Chatterbox [+ ≈ 4 GB cambio de cara con licencia]). `doctor.ps1`: «Python 3.12 (herramientas)», «FaceFusion (tools\facefusion)» (estado, versión, proveedor CUDA real o CPU), «Chatterbox (tools\chatterbox)» (estado, variant V3/V2, torch + cuda), «Licencia cambio de cara» (aceptada / no, del espejo), «RVC» (torch CUDA sí/no, origen del hubert), `LongPathsEnabled`, espacio libre. `.gitignore`: `tools/facefusion/app/`, `tools/*/.venv/`. `.env.example`: `FACEFUSION_BASE_PYTHON=`, `FACEFUSION_PYTHON=`, `FACEFUSION_APP_DIR=`, `CHATTERBOX_PYTHON=`, `CHATTERBOX_IDLE_S=120`, `RVC_IDLE_S=300` (vacíos = automático).

**RVC en CUDA** (`infer-rvc-python==1.3.1` en el venv principal, compatible con torch 2.7.1+cu128; no tiene `device` ni `fp16`: con `only_cpu=False` y CUDA usa `cuda:0` y fp16 solo): (1) asegurar el build CUDA de torch: `USE_CUDA=true` con `torch.cuda.is_available()` falso → CPU + aviso `torch_cpu_build` («Reinstalá con setup.ps1 -WithCuda»); (2) `GpuBudget.acquire("rvc", RVC_VRAM_MB, unload)` antes de inferir y liberación tras `RVC_IDLE_S` sin uso (política §10.2); `/rvc/convert` ya devuelve `device` (M2 lo pasa al resultado de la api); (3) `torch.load` con el default `weights_only=True` de torch ≥ 2.6: `UnpicklingError` → 422 `RVC_MODEL_INCOMPATIBLE` (no se desactiva `weights_only`: son pickles del usuario); (4) **origen del hubert**: hoy `rvc_engine.py` baja `hubert_base/{config.json, preprocessor_config.json, pytorch_model.bin}` de `lj1995/VoiceConversionWebUI`, carpeta no confirmada; la librería usa `r3gm/hubert_base` (formato transformers) → probar la URL actual y, si no existe, migrar `rvc-base` a `r3gm/hubert_base` (+ `rmvpe.pt`, 181 189 687 B, mismo archivo); `doctor` muestra cuál quedó; (5) benchmark. Meta: 1 min de audio < 15 s en GPU (§8.2 [S] 3–10 s).

**Test de rendimiento** (`perf.py`; `POST /perf/run` acepta `{face_source_path?, licences?}` que manda la api): `rvc_device`; Chatterbox (pack + venv): frase fija de 150 caracteres sin clon → `chatterbox_rtf`, `chatterbox_load_s`, `chatterbox_device`, `chatterbox_model`; FaceFusion (pack + licencia + `face_source_path`): video de 3 s a 1080p armado con esa foto en bucle, swap con la misma cara → `facefusion_fps` (sin mejorador), `facefusion_enh_fps` (GFPGAN), `facefusion_startup_s`, `facefusion_device`, `facefusion_model`. Si falta algo → `null` + `skipped[comp]` en español («licencia no aceptada», «registrá una Persona con consentimiento para medir», «paquete X no instalado»). **Nunca** corre un modelo del cambio de cara sin la aceptación.

**Revisión para redes** (`ai-content.ts`):
```ts
export interface AiContentHit { clipId: string; trackId: string; assetId: string; personId?: string; label_es: string }
export interface AiContentReport { face: AiContentHit[]; voiceCloned: AiContentHit[]; voiceSynthetic: AiContentHit[] }
/** Clips que llegan al export (pista de video no oculta, de audio no silenciada) cuyo asset tiene aiProvenance. */
export function detectAiContent(project: Pick<Project, "tracks">, assets: ReadonlyMap<string, Pick<MediaAsset, "id" | "name" | "aiAltered" | "aiProvenance">>): AiContentReport;
export function aiContentComment(r: AiContentReport): string | undefined; // "Editado con Studio; cara sintética: sí; voz clonada: sí"
```
`SocialReview.tsx` + `lib/publish.ts`: ítems detectados «Cara alterada con IA» (clips + Persona) y «Voz sintética/clonada» (cuáles); `aiFace` y `aiVoice` (clonada) se marcan solos y quedan bloqueados mientras haya detección; voz solo sintética → marcada pero editable; al marcar «Voy a subirlo a redes» la etiqueta se propone encendida (`nextPublish`, D4); en uso interno queda apagada. Export (`services/ffmpeg`): `-metadata comment=<aiContentComment>` con detección (decisión 9), en pasada única y por bloques (va en el concat final: no cambia el hash de bloques). Herencia (`inheritAiProvenance(source, extra)`): `voice.effect`, `audio.denoise`, `audio.stems`, `vision.matte` copian `aiAltered/aiProvenance` (con `sourceAssetId`). Medios: insignias «IA: cara» / «IA: voz».

**Web Ajustes → Paquetes de IA**: insignia «No comercial: requiere aceptar licencia» en packs con `licence_gate` (botón «Leer y aceptar» → `studio:licence:open`), estado del entorno aislado (listo / desactualizado / falta / roto / falta Python 3.12) y variant de Chatterbox; Test de rendimiento: «RVC: X s por minuto (GPU|CPU)», «Chatterbox: RTF X (≈ Y s por cada 10 s de voz)», «Cambio de cara: X fps (≈ Z min por minuto a 1080p; con mejorador W fps)».

**CI**: ubuntu + windows y smoke **sin bajar modelos ni crear venvs de herramientas** (regla 13): tests con `runner` falso (venv/pip/zip/winget simulados) y `httpx.MockTransport`; el smoke de Windows verifica que «Herramientas aisladas» queda omitido y no existen `tools\*\.venv` (Python 3.12 puede instalarse: es un prerrequisito chico). **Tests**: `test_toolvenv.py` (crear / omitir por sello / `stale` por requirements, lock o perfil / nunca `install.py` / desinstala `onnxruntime*` antes / índice cu124 solo con CUDA / caída a V2 sin Git / sha del zip distinto → error / junction / `python` sin 3.12 / overrides `*_PYTHON`), `test_launch.py` (entorno sin `HF_TOKEN`, `HF_HUB_OFFLINE=1`, `--preload-ort` con `onnxruntime` simulado, `runpy` del script con argv), `test_cli_packs.py` (`--packs all` omite `faceswap` sin aceptación y lo incluye con el espejo), `test_perf.py` (campos nuevos y motivos), `test_rvc_cuda.py` (torch CPU con `USE_CUDA` → `torch_cpu_build`; `UnpicklingError` → `RVC_MODEL_INCOMPATIBLE`; liberación por inactividad; URLs del hubert), shared `ai-content.test.ts`, api export con `ffprobe` del `comment`, web `publish.test.ts` (flags detectados bloqueados, etiqueta solo con redes). E2E: «sprint4: licencia de cambio de cara de punta a punta (pack 403 → aceptar con Origin → descarga mock → revocar → face.swap 403)», «sprint4: perf.json con campos nuevos y motivos», «sprint4: export con metadato comment de IA», «sprint4: RVC informa device (cpu en CI)». UI smoke: «Sprint 4: Revisión para redes detecta cara y voz IA; etiqueta al marcar redes», «Sprint 4: Paquetes de IA: faceswap pide aceptar la licencia».

Manual: **§27 Rendimiento e instalación de herramientas** (paquetes nuevos y tamaños, Python 3.12, venvs aislados y por qué, `-Full`/`-Update`, `doctor`, Test de rendimiento, RVC en GPU). **Solo en tu PC**: `setup -Update` omitiendo todo salvo lo nuevo, instalación real de Python 3.12 por winget, tamaños y tiempos de los dos venvs, que las DLL nvidia-cu12 sirvan a onnxruntime-gpu, RVC s/min en CUDA y origen real del hubert.

## Criterios del sprint
Criterio 5 del plan: un cambio de cara solo corre con consentimiento registrado y vigente (e2e: 403 sin él, revocado y revocado con el job en cola); la etiqueta es opcional (apagada en uso interno, propuesta al marcar redes); nada del cambio de cara (código ni modelos no comerciales) está en disco ni activo sin la aceptación en pantalla (e2e + `models_cli --packs all` + doctor); NSFW sin forma de apagarlo (Studio no pasa flags ni toca el módulo; rechazo → `CONTENT_BLOCKED`). Voz: Chatterbox multilingüe en español clona desde 10 s de Voz propia o de una Persona con consentimiento; sin pack, Piper sigue. Instalador: criterio 1 (`setup -Update` omite lo ya instalado salvo Python 3.12 la primera vez; CI verde ubuntu + windows + smoke sin descargas). En la 4050 (Test de rendimiento): swap 1080p ≥ 15 fps sin mejorador [S], Chatterbox RTF ≤ 1, RVC 1 min < 15 s.

## Descubierto (fuera de alcance)
- Packs de un solo idioma `ResembleAI/Chatterbox-Multilingual-es-mx-latam` y `-es-es` (existen en HF, pero el código público no los carga; no hay es-AR): evaluar cuando el código los soporte.
- Filtro NSFW propio de las fotos de origen (FaceFusion analiza solo el destino).
- `--face-swapper-weight` de FaceFusion (semántica a medir) como alternativa a la mezcla `strength`; proveedor DirectML para GPUs no NVIDIA.

## Cambios en integración

(2026-10-06; detalle, resultados y procedimiento en `docs/trabajo/integracion-sprint4.md`)

- **Junctions en Windows (bug real)**: `toolvenv._is_dir_link` usaba `os.path.isjunction`, que
  recién existe en Python 3.12; los workers corren 3.11.9, así que una junction
  `tools/facefusion/app/.assets/models` se veía como carpeta común y el segundo `link_dir` (un
  `ensure` repetido: `-Update` con receta cambiada, `-Force`, entorno `stale`) fallaba con
  `WinError 183`. Ahora también se detecta por `lstat` (reparse point + `IO_REPARSE_TAG_MOUNT_POINT`).
  Test nuevo `test_junction_detected_without_isjunction` (corre en Linux con `lstat` simulado) + el
  existente `test_symlink_relinked_when_target_changes` en windows-latest.
- **CI windows-latest (pruebas)**: `test_find_base_python_order` usa intérpretes falsos que existen
  (en Windows `C:/Py312/python.exe` es absoluta y el buscador la salteaba con razón);
  `test_tool_bridge_fallback_and_m3_delegation` separa `PATH` con `os.pathsep`; `persons.test.ts`
  acepta 403 o 404 para `/files/CONSENT/...` (en un sistema de archivos sin mayúsculas
  `@fastify/static` rechaza el alias con 403 antes de `allowedPath`; lo que importa, que no se
  sirve, se mantiene); `agent.test.ts` codifica el clip de prueba una sola vez por archivo (un
  `ffmpeg` síncrono por test bloqueaba el event loop) y el test de `PACK_REQUIRED` (5 pedidos en
  serie) tiene 30 s en lugar de 5.
- **Procedencia en RVC (M2 ↔ M3)**: `voice.rvc` usa `inheritAiProvenance(source, {jobId})` de
  `services/ai-provenance.ts` (se quitó `inheritVoiceProvenance`): el asset derivado guarda el
  `jobId` del RVC como el resto de las herencias (antes quedaba el del TTS de origen).
- **Reportes sin el registro de Personas**: `reportar-error.ps1` ya no copia `studio.db` entera
  como último recurso (tiene `persons`, `ai_licences` y `consent_audit`) y oculta las rutas
  `consent/persons|archive/…` con la misma regla que `reports/builder.ts`. `REPORTAR-ERRORES.md`
  (Privacidad) lo dice.
- **studio-mcp**: el smoke exige ≥ 18 herramientas (antes ≥ 16; + `studio_list_persons`,
  `studio_face_swap`).
- **Tamaños**: Chatterbox ≈ 6,2 GB en todos lados (lo que calcula el pack y muestra la UI);
  `setup.ps1`, `doctor.ps1` e `INSTALACION-WINDOWS.md` decían 6,5. `-Force` documentado también
  para los entornos aislados.
- **E2E** (+2 pasos «sprint4 integración»): cara (M1) + voz clonada (M2) → `voice.effect` y RVC
  heredan `voice-cloned` (M3) → `comment` del export «cara sintética: sí; voz clonada: sí» y, tras
  deshacer el cambio de cara, «cara sintética: no»; `perf.run` (M3) mide FaceFusion por el
  `FaceEngine` de los workers (M1) con la Persona que elige `benchFaceSource()` (una «0 E2E Banco»
  limpia: por orden alfabético la primera era «E2E Contenido», la de la foto NSFW, y el bench
  terminaba en `CONTENT_BLOCKED` sin medir nunca).
- **Docs**: manual §24–§27 (+ §4.1 pestañas de Ajustes, §9 enlace, §11 variables nuevas, §17.1
  paquetes, §17.3, §17.7 detección y `comment`, §23.2–23.3), `index.html` a mano y PDF regenerado
  (76 páginas); `ARQUITECTURA.md` (componentes, flujos de voz y cara, rutas s4, códigos, workers,
  jobs, almacenamiento, tablas, §5.4 herramientas aisladas + consentimiento + procedencia,
  decisiones, secretos); `fuentes.md` (FaceFusion OpenRAIL-AS + licencia de cada modelo,
  Chatterbox MIT + PerTh, onnxruntime, ruedas NVIDIA cu12 con su EULA, torch 2.6, Python 3.12,
  hubert/rmvpe).
