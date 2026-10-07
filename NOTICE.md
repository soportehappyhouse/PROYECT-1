# Avisos de terceros (NOTICE)

El código propio de Studio está bajo [`LICENSE`](LICENSE) (todos los derechos reservados). Studio
usa o descarga en la PC del usuario componentes de terceros que conservan **sus propias
licencias**. Lista resumida; la tabla completa (versiones, origen, cómo se aísla cada uno) está en
[`docs/trabajo/fuentes.md`](docs/trabajo/fuentes.md) (y `docs/trabajo/fuentes-*.md`).

## Código incluido en este repositorio

| Componente                   | Licencia         | Notas                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/workers/vision_gpl/**` | GPL-3.0-or-later | Derivado de RobustVideoMatting (recorte de fondo). Cada archivo lleva su cabecera SPDX; corre en un venv propio (`.venv-gpl`) y en un proceso aparte, nunca importado por el resto de Studio. Al redistribuirlo rigen las condiciones de la GPL. |

## Herramientas y modelos que se descargan en la PC del usuario (no se versionan)

| Componente                                                      | Licencia                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Remotion                                                        | Licencia de Remotion: gratuita para individuos y equipos pequeños; ver <https://www.remotion.dev/license>                                    |
| FaceFusion 3.9.1 (cambio de cara)                               | OpenRAIL-AS (restricciones de uso: sin suplantación sin consentimiento, sin contenido sexual no consentido)                                  |
| Modelos de FaceFusion: ArcFace (`arcface_w600k_r50`), inswapper | InsightFace: solo uso no comercial / investigación                                                                                           |
| hyperswap                                                       | ResearchRAIL                                                                                                                                 |
| simswap (`simswap_256`, `simswap_unofficial_512`)               | CC-BY-NC 4.0 (no comercial)                                                                                                                  |
| xseg                                                            | GPL-3.0                                                                                                                                      |
| Chatterbox (Resemble AI)                                        | MIT; toda salida lleva la marca de agua inaudible PerTh (MIT), que Studio no desactiva                                                       |
| Demucs (separar audio)                                          | MIT (código); los pesos tienen sus propias condiciones (ver el repositorio de Demucs)                                                        |
| SAM 2.1 (código y pesos)                                        | Apache-2.0                                                                                                                                   |
| faster-whisper                                                  | MIT                                                                                                                                          |
| Piper (voces)                                                   | MIT (código); cada voz tiene su licencia en su ficha                                                                                         |
| Modelos de Ollama: `hermes3`                                    | Llama 3.1 Community License («Built with Llama», Acceptable Use Policy)                                                                      |
| Modelos de Ollama: Qwen                                         | Licencia de cada modelo Qwen: Apache-2.0 para `qwen3:8b`; algunos tamaños (p. ej. Qwen2.5-VL 3B) usan la Qwen Research License: ver su ficha |
| CoTracker                                                       | CC-BY-NC (solo se menciona en la documentación; Studio no lo descarga)                                                                       |

El cambio de cara exige aceptar en pantalla una licencia que resume estas restricciones (uso no
comercial, con consentimiento de las personas). Ninguno de estos componentes se redistribuye con
el código de Studio: los baja el instalador o la app desde sus fuentes públicas.
