# Análisis: "Hyperframes" como editor complementario de Studio

Fecha: 2026-10-05. Investigación hecha leyendo el repo clonado (`heygen-com/hyperframes`, HEAD 2026-10-05), npm y la web. No se tocó código de Studio.

## 1. Qué es "HyperFrames"

Hay un candidato dominante y varios homónimos irrelevantes. El que casi seguro mencionó el dueño es **HyperFrames de HeyGen**: "Write HTML. Render video. Built for agents." Es un framework que describe videos como HTML con atributos `data-*` (inicio, duración, track), los reproduce en Chrome headless (seek determinista cuadro a cuadro con `HeadlessExperimental.beginFrame`) y codifica con FFmpeg. Nació el 2026-03-10, inspirado explícitamente en Remotion. Incluye además un **Studio** (editor en navegador con timeline, preview, inspector y editor de código).

## 2. Tabla resumen de candidatos

| Candidato | URL | Qué es | Stack / licencia | Estado | Rol para nosotros |
| --- | --- | --- | --- | --- | --- |
| **HyperFrames (HeyGen)** | github.com/heygen-com/hyperframes | Framework HTML→MP4 + Studio editor + CLI + catálogo de bloques + skills de agentes | TypeScript, Node 22+, FFmpeg, Chrome. Apache-2.0 | Muy activo: 57.1k estrellas, 5.1k forks, 168 issues abiertos, commit del mismo día, npm 0.8.133 (pre-1.0, ~7 meses de vida) | Referencia de ideas (ver §4) y competidor parcial de Remotion; librería embebible solo en partes |
| `@hyperframes/studio` (paquete del anterior) | npmjs.com/package/@hyperframes/studio | UI React 19 + zustand + **dockview**: timeline, keyframes, inspector, preview | ~162k líneas TS en `packages/studio/src` | Mismo repo. La propia doc dice: "building blocks, not a drop-in embedded editor" | Cantera de patrones; no embebible tal cual |
| `@hyperframes/player` | npm | Web component de reproducción de composiciones | Depende de `@hyperframes/core` | Activo | Idea de reproductor iframe con puente de seek |
| hyperframes/hyperframes (org GitHub) | github.com/hyperframes/hyperframes | Solo README que apunta al de HeyGen | 4 estrellas, 2 commits | Inerte | Ignorar |
| `hyperframe` (PyPI, 0xideas) | pypi.org/project/hyperframe | Acceso a matrices de alta dimensión (nada de video) | Python, MIT | Abandonado (0.0.1) | Ignorar (homónimo) |
| Derivados de la comunidad (kinocut, brag, hyperframes-student-kit, html-anything, etc.) | github.com/KyaniteLabs/kinocut, etc. | Skills/servidores MCP/plantillas que usan HyperFrames | Python/JS/HTML | Activos | Solo inspiración de flujos con agente; no son editores |
| Remotion (ya usado) | remotion.dev | Equivalente en React | React; licencia source-available | Ya integrado | Contexto: HyperFrames lo compara como rival |

No existe un "HyperFrames" Python ni un editor web con ese nombre fuera de HeyGen.

## 3. Capacidades de HyperFrames relevantes para Studio

- **Timeline UI**: `packages/studio/src/components/nle/TimelinePane.tsx`, `player/components/*` (clips, waveform, playhead, miniaturas, transiciones, menús contextuales), edición de grupos y enlaces. Estado en zustand (`player/store`).
- **Keyframes**: `components/editor/KeyframeDiamond.tsx`, `KeyframeEaseList.tsx`, `EaseCurveSection.tsx`, `MotionPathOverlay.tsx`, hooks `useGsapKeyframeOps`, `useKeyframeKeyboard`. Todo acoplado a GSAP (parsea y reescribe el script GSAP de la composición vía AST).
- **Preview multicapa**: la composición vive en un iframe; las capas son elementos DOM con `data-track-index` y z-order (`player/lib/layerOrdering.ts`, `playbackSeek.ts`, `runtimeProtocol.ts`). Overlay de selección con handles, guías, zoom (`DomEditOverlay`, `nle/PreviewPane.tsx`).
- **Efectos**: 18 efectos de medio (blur, bloom, glitch, halftone, ASCII...), 16 looks y 4 rutas LUT (`core/src/colorGrading*.ts`, `colorLuts.ts`), transiciones WebGL (`packages/shader-transitions`), cadena de efectos de audio (`core/src/audioFx*.ts`, `audioAutomation.ts`), catálogo de 150+ bloques en `registry/blocks`.
- **Render**: `engine` (Puppeteer + FFmpeg, determinista), `producer` (captura + codificación + mezcla de audio), Lambda/Cloud Run. Sin GPU documentada para el render (captura por CPU); WebM transparente es costoso.
- **IA**: pensado para agentes (CLI no interactivo, skills, MCP/WebMCP). No trae IA propia (Whisper, TTS, visión); eso lo orquesta el agente.

## 4. Encaje con la arquitectura de Studio

Lo que choca:

1. **Modelo de datos distinto.** Nosotros: `Project → Track[] → Clip[]` JSON en `packages/shared`, exportado con FFmpeg `filter_complex`. Ellos: HTML + GSAP como fuente de verdad; el editor edita el texto fuente. No se puede enchufar su Studio a nuestro modelo sin reescribir uno de los dos.
2. **No es embebible.** `EditorShell`, `Timeline`, `NLEPreview` exigen sus contextos, su API (`studio-server`) y su runtime en el iframe.
3. **Motor de render paralelo.** Ya tenemos FFmpeg + Remotion; añadir Chrome+beginFrame sería una tercera vía. Remotion cumple lo mismo y ya está.
4. **Pre-1.0 y velocidad alta** (versión 0.8.x con cambios diarios): acoplarse implica seguir su ritmo. Licencia Apache-2.0 permite copiar con atribución (compatible con "instalable en cualquier máquina"). Verificar aparte la licencia de GSAP si se usara.
5. **Alcance OUT del PLAN-BASE v2**: no nube ni "generación por IA"; su fuerte (Lambda, agentes cloud) no aporta.

Lo que sí coincide: ya usamos dockview y React 19 igual que su Studio, lo que hace sus patrones directamente legibles y portables.

## 5. Veredicto

**Portar conceptos específicos; no adoptar ni embeber.** HyperFrames no es un editor complementario enchufable: es un competidor de Remotion con un editor propio atado a su formato HTML/GSAP. Pero resuelve justo lo que nos falta, y con licencia Apache-2.0 sirve de referencia directa.

| Falta en Studio | Qué mirar en HyperFrames | Cómo portarlo |
| --- | --- | --- |
| Preview multicapa en navegador | `player/lib/layerOrdering.ts`, `playbackSeek.ts`, `runtimeProtocol.ts`, `nle/PreviewPane.tsx`, `core/src/runtime/clock.ts`, `clipWindow.ts` | Un reloj maestro + un elemento por clip (video/img/canvas) con z-order por track, mostrado solo dentro de su ventana; seek por tiempo, no por reloj real |
| Keyframes | `components/editor/KeyframeDiamond.tsx`, `EaseCurveSection.tsx`, `player/store/keyframeSlice.ts`, `utils/gsapKeyframeEases.ts` | Modelo propio `Keyframe{t, prop, value, ease}` en `packages/shared`; reusar la UI de rombos y curva de ease; evaluar con interpolación propia, no GSAP |
| Pila de efectos | `core/src/colorGrading*.ts`, `colorLuts.ts`, `registry/blocks`, `packages/shader-transitions` | Efectos como lista ordenada por clip con doble implementación: shader/CSS en preview y filtro FFmpeg en export |
| Handles de selección en canvas | `components/editor/DomEditOverlay.tsx`, `DomEditRotateHandle.tsx`, `PreviewGuides.tsx` | Overlay de mover/escalar/rotar sobre el preview |
| Audio | `core/src/audioFx*.ts`, `audioAutomation.ts` | Referencia para curvas de volumen y presets |

## Recomendación

1. No adoptar HyperFrames ni su Studio como editor: formato HTML/GSAP incompatible con `Project/Track/Clip` y no es embebible (lo dice su doc).
2. Portar ideas, con atribución Apache-2.0, en este orden: (a) preview multicapa con reloj maestro, (b) modelo y UI de keyframes, (c) pila de efectos con doble implementación preview/FFmpeg.
3. Meterlo en el Sprint 2 (keyframes ya previstos para tracking) y abrir un spike corto de preview multicapa antes.
4. Ignorar su render (Chrome+beginFrame), Lambda y skills de agentes: Remotion + FFmpeg ya lo cubren.
5. Opcional: usar sus bloques de `registry/` como inspiración de plantillas de motion para Remotion.
6. Reevaluar en 6 meses si llega a 1.0 y publica un editor realmente embebible.
