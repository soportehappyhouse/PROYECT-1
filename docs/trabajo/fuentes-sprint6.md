# Fuentes Sprint 6 — Guion por palabras, sistema de diseño, sugerencias al importar

Fecha de investigación: 2026-10-18. Destino: Windows 10/11, i5, 32 GB RAM, RTX 4050 6 GB, todo local. Stack real leído en el repo: `faster-whisper` con `word_timestamps=True` y `vad_filter` (`min_silence_duration_ms=500`) en `apps/workers/studio_workers/stt/engine.py`; `silencedetect` con `-35 dB / 500 ms` en `analyze.py`; subtítulos quemados con ASS propio (`apps/api/src/services/ffmpeg/ass.ts`, PlayRes = lienzo); Remotion 4.0.532 + zod 4.5.4 con 10 fuentes cargadas de Google Fonts en runtime (`packages/remotion/src/fonts.ts`); `TaskQueue` de workers (`tasks.py`).

**Leyenda.** **[V]** leído en la fuente primaria (URL o archivo indicado) · **[S]** extracto de buscador de una página que no pude abrir · **[U]** conocimiento propio o propuesta, sin verificar acá.
**Limitación del sandbox:** solo `raw.githubusercontent.com` (y `curl` a GitHub raw) respondió; `remotion.dev`, `ffmpeg.org`, `w3.org`, `bbc.co.uk`, `netflix.com`, `descript.com`, `adobe.com` y blogs dieron error de DNS/política. Todo lo de BBC, Netflix, WCAG, Descript, Premiere y zonas seguras es [S]. Las cifras de zonas seguras **no son oficiales** de ninguna app y las fuentes se contradicen: se tratan como valores de partida para calibrar con capturas reales.

## 0. Hallazgos críticos (leer primero)

1. **Whisper no transcribe bien las muletillas.** La comunidad lo reporta (la técnica del `initial_prompt` con «eh, em» solo funciona «a veces») y la solución seria es un modelo ajustado (CrisperWhisper, **CC-BY-NC-4.0**, no comercial) [S] https://huggingface.co/spaces/openai/whisper/discussions/30 . Descript detecta muletillas solo en inglés, alemán, francés, portugués e italiano, **no en español** [S] https://help.descript.com/hc/en-us/articles/10164806394509-Remove-filler-words . Conclusión: para «eh/em/mm» hay que **detectarlas por audio** (hueco sonoro entre palabras), no esperar que aparezcan en el texto (§1.3).
2. **El `TaskQueue` de workers es FIFO puro** (`queue.Queue`, un hilo): no tiene prioridad. Para que las sugerencias al importar no demoren una transcripción pedida por el usuario hace falta una cola con prioridad o una segunda cola «background» (§3.3).
3. **Las fuentes de Remotion se bajan de Google Fonts en cada render** (`fonts.ts`, timeout 15 s, cae a Segoe UI sin red). El ASS de FFmpeg usa las fuentes del sistema. Resultado: vista previa, motion y subtítulos quemados pueden verse con tipografías distintas. Arreglo: empaquetar las TTF/WOFF2 OFL una vez y usarlas en los tres lados (§2.4).
4. **Los tiempos por palabra de Whisper son aproximados** (atención cruzada + DTW de CTranslate2, filtro de mediana de 7, redondeo a 10 ms) [V] https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/faster_whisper/transcribe.py . Cortar justo en `word.end` recorta consonantes finales. Hay que cortar en el **medio del hueco** y afinar con la energía del audio (§1.5).
5. **Las zonas seguras cambian de fuente en fuente** (TikTok arriba 240–288 px, abajo 660–672 px; Reels arriba 150–269 px, abajo 270–672 px) [S]. No se puede prometer «cumple Reels»; sí un perfil conservador que cubra a todas.

---

## 1. Bloque 1 — Guion editable por palabras

### 1.1 Cómo lo hacen las referencias

| Referencia | Qué hace (evidencia) | Qué tomar para Studio |
|---|---|---|
| **Descript** | «Remove filler words»: cada muletilla detectada se puede borrar, borrar dejando un hueco, ignorar o quitar solo del texto. Opción **Avoid harsh cuts**: omite las muletillas que no se pueden sacar sin pisar la palabra vecina o dejar un hueco raro. «Shorten word gaps»: el usuario define qué es una pausa (p. ej. 750 ms) y a cuánto se acorta (p. ej. 200 ms), de a una o todas [S] https://help.descript.com/hc/en-us/articles/10164807277453-Shorten-word-gaps . Usuarios reportan que acortar pausas a veces se come la cola de una palabra [S] https://feedback.descript.com/feature-requests/p/smoother-transitions-when-removing-filler-words-from-script | Tres acciones por muletilla (quitar / dejar hueco / ignorar), «evitar cortes bruscos» como regla propia (§1.5), pausas con umbral y destino configurables, margen de seguridad para no comer colas. |
| **Premiere (Text-Based Editing)** | Borrar texto aplica ripple automático; filtro «pausas» y «muletillas» resalta todas; **Extract** (cierra el hueco) o **Lift** (deja el hueco); el umbral de pausa/muletilla se cambia en vivo [S] https://community.adobe.com/t5/premiere-pro-beta-discussions/now-in-beta-filler-words-and-other-text-based-editing-updates-in-premiere-pro/m-p/14192560 | Resaltado con filtros y «Borrar todo» con confirmación; umbral editable con recuento en vivo («23 pausas > 0,6 s»). |
| **DaVinci Resolve 20** | Transcripción local, borrar texto recorta la línea de tiempo; IntelliScript arma un corte desde un guion (Studio de pago) [S] https://blitzcutai.com/blog/davinci-resolve-text-based-editing . Errores de reconocimiento pasan al timeline [S] foro Blackmagic | Corregir texto sin tocar tiempos (§1.6) para no propagar errores a los subtítulos. IntelliScript: fuera de alcance. |
| **CapCut** | Subtítulos automáticos con estilos; AutoCut para recorte/alineado [V*] https://www.capcut.com/help/auto-cut-in-capcut (visto en `referencias-fluidez-autonomia.md`) | Nada nuevo para guion; sí la idea de tarjeta de acción (§3.4). |
| **auto-editor** (dominio público) | Cortes por umbral de audio con margen por defecto 0,2 s [V] según `referencias-fluidez-autonomia.md` | Margen de ~0,1–0,2 s alrededor del habla al cortar silencios. |

Interacción mínima a adoptar: panel «Guion» con palabras clicables; selección + `Supr` = borrar con ripple; `Ctrl+Z` revierte el corte completo (una sola entrada de historial por gesto); palabras borradas se muestran tachadas hasta confirmar o se ocultan según preferencia; clic en una palabra mueve el cabezal.

### 1.2 Timestamps por palabra con faster-whisper

Parámetros relevantes [V] (código fuente de `transcribe.py`, MIT [V] LICENSE de SYSTRAN/faster-whisper):

| Parámetro | Default | Nota |
|---|---|---|
| `word_timestamps` | `False` (Studio lo pone en `True`) | Tiempos por atención cruzada + DTW en CTranslate2; Python aplica filtro de mediana 7; redondeo a 2 decimales; `probability` por palabra = media de sus tokens |
| `hallucination_silence_threshold` | `None` | Con `word_timestamps`, si detecta palabra anómala (prob. baja, < 0,133 s o > 2 s) salta el silencio previo. **Recomendado probar con 2.0** para evitar texto fantasma en silencios largos. En `BatchedInferencePipeline` se fuerza a `None` |
| `vad_filter` / `vad_parameters` | `False` / `None`; Silero VAD, por defecto solo saca silencios > 2 s [V README] | Studio usa 500 ms. El VAD recorta el audio y después **remapea** los tiempos al original (`restore_speech_timestamps`) |
| `condition_on_previous_text` | `True` | Puede encadenar alucinaciones; evaluar `False` en audios con mucho silencio [U] |
| `prepend_punctuations` / `append_punctuations` | `"'“¿([{-` / `"'.。,，!！?？:：”)]}、` | La puntuación se funde en la palabra adyacente: para el guion guardar `text` con puntuación y un `norm` sin puntuación para diff y detección |

Heurísticas internas que afectan el corte [V]: palabras al final de oración se limitan a ~2× la mediana de duración (tope 0,7 s de mediana); si la primera palabra viene tras una pausa larga (> 4× mediana) se le adelanta el inicio; el segmento se ajusta a las palabras si difiere más de 0,5 s. Es decir: **las palabras tras una pausa larga empiezan más temprano de lo real** y las de fin de oración pueden quedar con `end` corto.

Fiabilidad: no encontré un benchmark publicado de error de tiempos por palabra de faster-whisper (la búsqueda solo devolvió documentación de parámetros) — **[U] medir en Studio** con 5 clips propios en rioplatense: error de borde contra un marcado manual, objetivo ≤ 80 ms en el 90 % de las palabras.

**Alineación forzada (plan B):** WhisperX (BSD-2) usa wav2vec2 + VAD [V*] https://github.com/m-bain/whisperX (visto en referencias). Cuesta un modelo wav2vec2 de español (cientos de MB) y VRAM extra → **descartar en Sprint 6**, reabrir solo si la medición de arriba falla.

**Afinado barato propio (adoptar):** para cada borde de corte, buscar en ±60 ms el mínimo de energía RMS (ventanas de 5 ms sobre el WAV mono 16 kHz que ya se extrae) y mover el corte ahí. Solo numpy, sin dependencias nuevas [U].

**Cómo agrupar palabras (para subtítulos y para el guion):**
- Para el panel Guion: oración = corte por `.?!…` o por pausa ≥ 700 ms; párrafo = pausa ≥ 1,5 s o cambio de escena.
- Para subtítulos: `createTikTokStyleCaptions` de `@remotion/captions` ya agrupa en «páginas» con `combineTokensWithinMilliseconds` y, desde 4.0.514, `breakOnSilenceAfterMilliseconds` para cortar en pausas; devuelve `text`, `startMs`, `durationMs` y `tokens[{text,fromMs,toMs}]`; hay que anteponer un espacio a cada palabra y usar `white-space: pre` [V] https://raw.githubusercontent.com/remotion-dev/remotion/main/packages/docs/docs/captions/create-tiktok-style-captions.mdx . Se agrega encima la regla dura de §2.3 (máx. 2 líneas, caracteres por línea) en una función propia `paginate(words, rules)`: acumular palabras hasta que se exceda caracteres/línea × líneas, o duración > 3 s, o pausa ≥ 300 ms, o puntuación fuerte; luego balancear las dos líneas (cortar cerca de la mitad, preferir cortar antes de conjunción/preposición, nunca separar artículo de sustantivo).

### 1.3 Detección de muletillas en español rioplatense

Dos fuentes de evidencia combinadas: **léxica** (texto) y **acústica** (hueco sonoro). Lista y reglas propuestas [U], a validar con grabaciones reales y editar desde Ajustes:

| Categoría | Ejemplos | Regla | Estado inicial en el panel |
|---|---|---|---|
| **Vocalizaciones** | «eh», «ehh», «em», «mm», «ah» | Léxico (si Whisper las escribe) **o** hueco acústico: entre dos palabras, ≥ 250 ms con RMS > piso de ruido + 10 dB y sin palabra asignada (voz sin texto) | Preseleccionada |
| **Conectores vacíos** | «o sea», «digamos», «este…» (con pausa), «bueno…» al inicio de frase | Siempre candidatas; «este» solo si hay pausa ≥ 120 ms antes o después, o está al inicio de oración seguida de coma/pausa (si no, es demostrativo) | Preseleccionada «o sea»/«digamos»; «este» solo con pausa |
| **Apoyos de cierre** | «¿no?», «¿viste?», «¿entendés?», «¿sí?» | Al final de cláusula, seguidas de pausa o fin de oración; «viste» NO si va precedida de «lo/la/me/te/ya» | Marcada, **no** preseleccionada |
| **Comodines** | «tipo», «nada», «literal», «básicamente», «mirá», «dale» | «tipo» filler si no la antecede «un/el/de/qué/ese/otro» ni la sigue «de»; «nada» filler al inicio de oración («nada, que…») y no tras «no/casi/para» | Marcada, **no** preseleccionada |
| **Repeticiones** | «que que», «yo yo creo», «en el en el» | n-grama de 1–3 palabras repetido seguido (comparando `norm`); se propone borrar la **primera** ocurrencia y conservar la completa | Preseleccionada |
| **Arranques falsos** | frase cortada y reiniciada | Palabra con probabilidad < 0,4 seguida de pausa y de repetición de la misma raíz; solo marcar, nunca preseleccionar | Marcada |

Tres niveles visibles: *seguro* (vocalizaciones, repeticiones exactas), *probable* (conectores), *dudoso* (comodines). Botón «Quitar seguras» y «Revisar dudosas una por una». El 10 de muletillas en < 1 min del criterio de éxito se cumple con «Quitar seguras» + revisar 3–4 dudosas. Guardar `filler_kind` y `confidence` para poder reportar «quité 14 de 17».

**Pausas.** Studio hoy usa `silencedetect` a −35 dB / 500 ms [V código]. Para el guion usar los huecos entre palabras (más precisos que el nivel): *pausa natural* 150–400 ms (no tocar), *pausa larga* > 600 ms (resaltar), acción «acortar a 250 ms» (patrón de Descript: 750 → 200 [S]); el valor de destino y el umbral son ajustes con recuento en vivo (patrón Premiere [S]).

### 1.4 Algoritmo `fit_duration` («dejalo en 45 s»)

Entrada: `target_s`, tolerancia (default ±0,5 s), `allow_speedup` (default `false`). Salida: lista de ops `trim`/`delete_clip`/`set_speed` con `reason_es` y el resultado esperado («62,4 s → 45,2 s»). Reglas:

1. **Piso:** si `duración_actual ≤ target`, no hace nada y avisa. Si aun quitando todo lo candidato no llega, devuelve lo logrado y una `question` («Llego a 52 s sin tocar contenido; ¿acelero 1,1× o quito oraciones?»), nunca recorta contenido por su cuenta.
2. **Nunca cortar a mitad de palabra:** todos los puntos de corte salen de huecos entre palabras (§1.5); si dos palabras están pegadas (hueco < 30 ms) ese punto no es cortable.
3. **Orden de quita**, cada nivel solo se aplica si el anterior no alcanzó:
   1. *Pausas largas* (> 600 ms) acortadas a 250 ms, de la más larga a la más corta.
   2. *Muletillas seguras* y repeticiones exactas.
   3. *Muletillas probables* y dudosas con confianza ≥ 0,6.
   4. *Oraciones de menor valor*: puntaje heurístico 0–1 por oración = 0,35·densidad informativa (palabras de contenido ≫ conectores) + 0,25·posición (primera y última oración protegidas) + 0,2·energía de voz (LUFS corto de la oración) + 0,2·presencia de cara. Se quitan de menor a mayor puntaje, solo oraciones completas, saltando las que dejarían un hueco de contexto (pronombre sin antecedente: oración siguiente que empieza con «eso», «esto», «ahí», «por eso»). Opcional: re-ranquear con el LLM local (Qwen3 8B vía Ollama, secuenciado con Whisper por VRAM, como ya prevé el Sprint 7 `find_highlights`) [U]. Siempre pedir confirmación porque borra contenido (regla 3 de CLAUDE.md).
   5. *Aceleración* ≤ 1,1× (opt-in).
4. **Parada:** ordenar candidatos por (nivel, costo semántico, ahorro) y sumar ahorros hasta `restante ≤ target + tolerancia`; si se pasó, deshacer el último candidato y reevaluar con uno más chico (evita sobrecortar).
5. **Explicabilidad:** la vista previa del plan lista por nivel «−6,1 s en 9 pausas, −2,4 s en 8 muletillas, −8,0 s en 2 oraciones» (ya existe vista previa con diferencias en el roadmap) y permite destildar cada grupo.

Es un problema tipo mochila con prioridades; no hace falta optimizador: voraz por niveles alcanza [U]. Complejidad O(n log n).

### 1.5 Borrar palabras → cortes ripple con margen y crossfade

Mapeo (sobre `words` ya ordenadas, con `start`, `end`):

1. Fusionar palabras borradas contiguas en un rango `[i..j]`; vecinos conservados: `prev = words[i-1]`, `next = words[j+1]`.
2. `gap_in = words[i].start − prev.end`, `gap_out = next.start − words[j].end`. Margen de cola: `pad_prev = min(60 ms, gap_in/2)`, `pad_next = min(60 ms, gap_out/2)` (las palabras tras pausa larga empiezan antes de lo real, §1.2, de ahí `pad_next` generoso).
3. `cut_start = prev.end + pad_prev`, `cut_end = next.start − pad_next`. Afinar ambos con el mínimo de energía en ±60 ms (§1.2). Si `cut_end − cut_start < 40 ms`, no cortar (ahorro irrelevante, riesgo de clic).
4. Aplicar como `split` + `delete` + ripple en todas las pistas **sincronizadas** (video + audio del mismo clip; pistas de música no, salvo ripple global elegido). Ya existe `applyCutsLocally` en `project-store.ts`; el gesto completo debe ser una sola entrada de deshacer y registrarse como EditPlan (`trim`/`delete_clip`) para el historial del Asistente.
5. **Crossfade de audio 10–20 ms en cada empalme.** En FFmpeg `acrossfade` admite duración hasta 60 s, curva por defecto `tri` (lineal) y `curve1/curve2` [V] https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavfilter/af_afade.c ; pero un `acrossfade` **solapa** y acorta el total, así que con huecos de 40 ms conviene `afade=out` + `afade=in` de 12 ms con curva `qsin`/`hsin` en cada lado del empalme (sin solape, la duración no cambia) [U]. Regla: `fade = min(15 ms, gap_restante/2)`. En video el empalme es seco (corte duro); para evitar el salto de imagen en cara hablando, ofrecer «zoom de empalme» 105 % alternado (técnica común) como opción, no por defecto.
6. «Evitar cortes bruscos» (equivalente a Avoid harsh cuts [S]): omitir y marcar con ⚠ las muletillas cuyo hueco por lado es < 30 ms o cuya probabilidad es < 0,4 (el corte comería una vecina).
7. Los subtítulos (`words`) se **recalculan restando** el tiempo borrado (desplazamiento acumulado), no se vuelven a transcribir.

### 1.6 Corregir texto conservando tiempos (diff palabra a palabra)

Separar dos acciones: **corregir** (cambia texto, no toca el audio) y **borrar** (corta). Algoritmo de corrección:

1. Normalizar ambos lados a lista de tokens: NFC, minúsculas, sin puntuación, **conservando tildes y ñ** en `text` pero comparando con una clave `norm` sin tildes (para que «esta/está» alineen y la corrección sea el cambio).
2. `difflib.SequenceMatcher(None, old_norm, new_norm, autojunk=False).get_opcodes()` (biblioteca estándar de Python, licencia PSF; para la web, la misma lógica con el paquete `diff` BSD-3 o 40 líneas propias de LCS) [U].
3. Por cada opcode: `equal` → copiar `start/end/probability`; `replace` (n viejas → m nuevas) → repartir el intervalo `[old[0].start, old[-1].end]` entre las m nuevas **proporcional a su cantidad de letras** (mínimo 80 ms cada una); `insert` → tomar el hueco entre vecinas, hasta 60 % de su duración (si no alcanza, cero-duración pegada a la vecina y aviso); `delete` (en una corrección) → se quita del texto pero **el tiempo queda como hueco** (no corta), el usuario decide con «Borrar».
4. Marcar `corrected: true` en las palabras tocadas (tiempos estimados, no medidos) y mostrar sus bordes con trazo punteado; no usar esos bordes como punto de corte sin afinado acústico.
5. Con reemplazo 1:1 es trivial (conserva `words` completo): es el arreglo corto de la auditoría (hallazgo 12).

---

## 2. Bloque 2 — Sistema de diseño y «brand kit»

### 2.1 Estructura de tokens

Formato recomendado: **W3C Design Tokens (DTCG) 2025.10** como JSON (`$value`, `$type`, `$description`); es la versión estable y la leen Figma, Tokens Studio y Style Dictionary v5 [S] https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/ , https://www.zeroheight.com ; repo del grupo [V] https://github.com/design-tokens/community-group . Nota: en 2025.10 `dimension` pasa a objeto `{value, unit}`; Style Dictionary 5.3+ acepta ambas formas [S]. Style Dictionary es Apache-2.0 [V] https://raw.githubusercontent.com/amzn/style-dictionary/main/LICENSE .

**Decisión:** no agregar Style Dictionary (Node build-time, dependencia de más). Los tokens viven en `packages/shared` como **esquema zod** (ya es el patrón de Studio: contratos zod) con una vista exportable a DTCG para interoperar. Proponer (en español, con claves en inglés como el resto del código):

```jsonc
{
  "brand": { "name": "Mi canal", "logo": "assetId|null" },
  "color": {
    "text":      { "$type": "color", "$value": "#FFFFFF" },
    "textOutline": { "$type": "color", "$value": "#000000" },
    "accent":    { "$type": "color", "$value": "#FFD400" },
    "plate":     { "$type": "color", "$value": "#000000B3" },   // caja detrás del texto
    "palette":   ["#FFFFFF", "#000000", "#FFD400", "#FF3B6B"]
  },
  "font": {
    "title":   { "family": "Montserrat", "weight": 800 },
    "caption": { "family": "Inter", "weight": 800 },
    "body":    { "family": "Inter", "weight": 500 },
    "display": { "family": "Anton", "weight": 400 }
  },
  "caption": {
    "size_pct_short_side": 6.0, "max_lines": 2, "max_chars_line": { "9:16": 30, "1:1": 34, "16:9": 42 },
    "outline_pct_size": 8, "shadow_px": 0, "box": false, "min_duration_s": 0.83, "max_duration_s": 7,
    "position": "bottom", "animated": true
  },
  "title": { "min_duration_s": 1.5, "s_per_word": 0.35 },
  "safeZone": { "profile": "reels-tiktok-shorts" },   // ver §2.2, en % del lienzo
  "motion": { "default_transition": "fade", "transition_s": 0.3 }
}
```

Reglas «duras» (las que la validación bloquea o corrige sola) separadas de «guías» (avisan): duras = 2 líneas, tamaño mínimo, contorno/caja si el contraste es bajo, dentro de zona segura, duración mínima. Un `StylePreset` (Sprint 3b) pasa a referenciar tokens por nombre en vez de copiar valores.

**Canva Brand Kit** como modelo de producto: logos, colores, fuentes y estilos de texto por defecto aplicados a plantillas [S, conocimiento general; no abierto acá — **[U]**]. Decisión del usuario: un solo kit (el canal), así que no hace falta selector de kits ni herencia por proyecto.

### 2.2 Zonas seguras (9:16, 1:1, 16:9)

Todas las cifras son [S] (herramientas y guías de terceros; no encontré el archivo oficial de TikTok ni la especificación de Meta). Ejemplos de lo que se lee (1080×1920, arriba / abajo / izq / der):

| App | Medida reportada | Fuente |
|---|---|---|
| TikTok | 240 / 660 / 120 / 120 (+ columna de botones ~180 px de ancho desde ~840 px de alto) | [S] https://www.socialync.io/tools/safe-zones |
| Instagram Reels | 269 / 672 / 65 / 65, o 150 / 270 / 40 / 40 según otra herramienta | [S] https://moda.app/resources/sizes/instagram-reel ; https://adaptlypost.com/en/free-tools/safe-zone-checker |
| YouTube Shorts | 288 / 672 / 48 / 192 | [S] según `referencias-fluidez-autonomia.md` |
| Regla general | evitar el 10 % superior e inferior; el tercio inferior de Reels lo ocupan descripción, audio y botones | [S] https://houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories-reels/ |

**Recomendación:** guardar las zonas **en % del lienzo** (como ya hace `SafeAreaPercent` en `packages/shared/src/frame.ts`) y ofrecer un perfil único conservador «Reels/TikTok/Shorts» = el máximo de cada lado: **arriba 15 % (≈ 288 px), abajo 35 % (≈ 672 px), izquierda 11 % (≈ 120 px), derecha 18 % (≈ 192 px)**. Es muy restrictivo (queda ~71 % × 50 % de la pantalla), por eso: subtítulos y títulos obligatoriamente adentro; logos y detalles no críticos, solo fuera del 5 % exterior. Perfiles por app como opción avanzada. Calibrar con capturas reales del propio teléfono del usuario (una pasada, 3 apps) y guardar la corrección en el kit.
- **1:1 (1080×1080):** sin UI superpuesta relevante en feed; 5 % de margen por lado (title-safe) y inferior 8 % [U]. Aviso: el feed de perfil de Instagram recorta a 3:4 / 4:5, el contenido central debe tolerar un recorte vertical [U].
- **16:9 (1920×1080):** title-safe 90 % del cuadro (5 % por lado) y 8–10 % inferior para subtítulos [U; convención de broadcast (EBU R95 / SMPTE), sin verificar acá].
- Aclarar en la interfaz que es una guía y no una certificación (el roadmap ya lo declara «fuera de alcance garantizado»).

### 2.3 Reglas de subtítulos y texto en pantalla

| Regla | Valor propuesto | Evidencia |
|---|---|---|
| Líneas | máx. **2** | BBC recomienda 2 (3 solo si no tapa imagen importante) [S] https://clevercast.com/bbc-subtitling-guidelines |
| Caracteres por línea | **42** (16:9) · **34** (1:1) · **30** (9:16); mínimo útil 32 | Netflix español (España y Latinoamérica): 42 caracteres por línea [S] https://backlothelp.netflix.com/hc/en-us/articles/217349997 ; BBC 37 en difusión y ~68 % del ancho en online [S]. En 9:16 el ancho es 1080 con letra grande: 30 es la propuesta [U] |
| Velocidad de lectura | ≤ 17 cps adultos (≈ 20 cps como tope duro); BBC 160–180 ppm (≈ 0,33–0,375 s/palabra) | cps 17: solo blog de terceros, **no confirmado** en la guía de Netflix [S]; BBC [S] |
| Duración mínima por evento | 5/6 s (0,83 s); máxima 7 s | Netflix, guía de materiales suplementarios [S] https://backlothelp.netflix.com/hc/en-us/articles/115000239632 . Para páginas de 1–3 palabras estilo karaoke se acepta ≥ 0,3 s por palabra y página ≥ 0,5 s [U] |
| Texto en pantalla (títulos) | `max(1,5 s, 0,35 s × palabras + 0,7 s)`; lower third ≥ 3 s | Derivado de 0,3 s/palabra de BBC [S] y reglas de práctica [U] |
| Contraste | WCAG 2.2 SC 1.4.3: ≥ **4,5:1** texto normal, ≥ **3:1** texto grande (≥ 18 pt = 24 px, o 14 pt = 18,66 px en negrita) [S] https://w3c.github.io/wcag/understanding/contrast-minimum.html | Sobre video el fondo cambia por fotograma: exigir **7:1 entre texto y contorno/caja** (se controla en tokens) y medir el fondo real en la «Revisión» del Sprint 7 [U] |
| Tamaño mínimo | **≥ 4,5 % del lado corto** del lienzo (1080 px → 49 px) y recomendado 6 % (65 px). Se mide contra el lado corto para que 16:9 y 9:16 den lo mismo | Referencia de proporción: un valor de 5 % de la altura es usual (imgix usa 0,05 como fracción de altura) [S] https://docs.imgix.com/apis/video/subtitles/video-caption-size ; altura de línea CEA-608 ≈ 5,33 % [S]. El mínimo exacto es propuesta [U]: validar mirando capturas en el teléfono |
| Contorno / sombra | contorno 6–10 % del tamaño de fuente + sombra 0–2 px, o caja con alfa ≥ 0,6 | Aegisub: `Outline` y `Shadow` están en píxeles del script si `ScaledBorderAndShadow` está activo [S] https://docs.aegisub.org/3.0/Styles/ |

Reglas de segmentación (en la función `paginate`, §1.2): no separar artículo+sustantivo ni preposición+término; las dos líneas deben quedar balanceadas (la superior ≤ la inferior en pantalla vertical por estética); un hablante nuevo = página nueva.

### 2.4 Aplicar los tokens: Remotion y ASS

**Remotion (props tipados).** El repo ya usa zod 4 y Remotion 4.0.532. Plan: un `DesignTokensSchema` en `packages/shared`, y cada plantilla recibe `tokens` (o los valores ya resueltos) en sus props con zod; el catálogo de plantillas declara qué tokens usa. La edición en Propiedades (hallazgo 13 de la auditoría) se genera desde el esquema zod (campos con etiqueta en español: `.describe("Color del texto")` o metadatos propios) en lugar de un formulario por plantilla [U].
- **Fuentes empaquetadas:** hoy `fonts.ts` baja WOFF2 de Google Fonts en runtime. Descargar una vez las TTF/WOFF2 y guardarlas en `packages/remotion/public/fonts/` (o `storage/fonts/` con descarga en el instalador), cargarlas con `@remotion/fonts` `loadFont({family, url: staticFile(...)})` [U; paquete oficial de Remotion, licencia a verificar] o con `FontFace` nativo, y pasar **la misma carpeta** a FFmpeg (`subtitles=...:fontsdir=...`) para que libass las use [U]. Cierra el hallazgo 3 y funciona sin internet.
- **Licencia de Remotion:** gratis para individuos, empresas con hasta 3 empleados, sin fines de lucro y evaluación; empresas con más de 3 empleados necesitan licencia; prohíbe revender o sublicenciar derivados; los términos cambian en Remotion 5.0 [V] https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md . Para un uso personal está bien; **si Studio se distribuye a terceros hay que revisarlo**.

**ASS por FFmpeg (libass).** libass es ISC [V] https://raw.githubusercontent.com/libass/libass/master/COPYING , «mayormente compatible con VSFilter», versión 0.17.5 (2026-06-24) [V README]. Studio ya genera un ASS completo con PlayRes = lienzo, alineación numpad y márgenes por evento (`ass.ts`), que es el camino correcto. A agregar desde los tokens:
- `Fontname` = familia del token y `fontsdir` apuntando a la carpeta empaquetada (si no, libass cae a la fuente del sistema).
- `Fontsize` en píxeles del lienzo = `size_pct_short_side × min(W,H)`.
- `ScaledBorderAndShadow: yes` y `Outline = 0.08 × Fontsize`, `Shadow = 0–2`; `BorderStyle 1` (contorno) o `3` (caja opaca) según el token `box` [S/U].
- `MarginV` (desde abajo para alineaciones 1–3, desde arriba para 7–9, sin efecto en 4–6) [S] Aegisub Styles; `MarginL/R` desde la zona segura en px del lienzo.
- `WrapStyle`: Studio ya parte las líneas por su cuenta (`paginate`), así que usar `WrapStyle 2` (sin ajuste automático) para que libass nunca agregue una tercera línea [U].
- El karaoke/animado: tags `\k`/`\kf` o un evento por palabra; mantener lo actual y validar que el resultado de ASS y el de Remotion coincidan en tamaño y posición con una prueba de captura comparada (un fotograma por plantilla).

### 2.5 Vista previa sin render completo

| Opción | Cómo funciona | Pros | Contras |
|---|---|---|---|
| **Remotion `<Player>` en la web** | Se monta la misma composición React con `inputProps`, sin renderizar [V] https://raw.githubusercontent.com/remotion-dev/remotion/main/packages/docs/docs/player/api.mdx : props `component`, `inputProps`, `durationInFrames`, `compositionWidth/Height`, `fps`, `controls` (default `false`); `acknowledgeRemotionLicense` silencia el aviso de licencia en consola | Instantáneo; cambiar un color o un texto se ve al tipear; misma fuente de verdad que el render | Corre en el navegador de la web (CPU del i5 compartida con el timeline); debe usar fuentes empaquetadas para coincidir |
| **`renderStill`** | Un fotograma a PNG/JPEG/WebP con `composition`, `serveUrl` (bundle), `output`, `frame`, `inputProps`, `imageFormat` [V] https://raw.githubusercontent.com/remotion-dev/remotion/main/packages/docs/docs/renderer/render-still.mdx ; `renderFrames` con `frames` para varios | Fidelidad exacta del render (misma ruta que el export); sirve a `studio_preview_frame` y a la «Revisión» | Arranca Chromium; requiere `bundle()` una vez y `selectComposition` por llamada; latencia de segundos [U medir] |

**Recomendación:** Player para el formulario de plantilla en Propiedades (edición con feedback en vivo) y `renderStill` para (a) «ver cómo quedará» con el fotograma real del video fusionado, (b) miniaturas del catálogo (cachear por hash de props) y (c) la Revisión/Consola. Un único componente Remotion alimenta los dos, así no hay dos implementaciones.

### 2.6 Fuentes libres (OFL) ya empaquetables

Verifiqué la licencia en el repositorio `google/fonts` (campo `license` de cada `METADATA.pb`) [V] https://github.com/google/fonts — las 10 que Studio usa hoy son **OFL**: Inter, Montserrat, Poppins, Anton (con subsets latin/latin-ext, que cubren ñ, tildes, ¿ y ¡) y Roboto, Oswald, Bebas Neue, Playfair Display, Archivo Black, Bangers. La OFL permite uso comercial, incrustar y distribuir con la app; no permite vender la fuente suelta ni distribuir una versión modificada con el mismo «Reserved Font Name» [S] https://en.wikipedia.org/wiki/SIL_Open_Font_License . Incluir el `OFL.txt` de cada familia en `licenses/`. Recomendados por rol: **Inter** (cuerpo/subtítulos sobrios, variable con ejes `opsz` 14–32 y `wght` 100–900 [V]), **Montserrat** (títulos), **Anton / Bebas Neue** (display de impacto), **Poppins** (alternativa redondeada). Peso aproximado ≤ 1,5 MB por familia con 2–3 pesos [U]. No agregar fuentes de pago ni de licencia dudosa.

---

## 3. Bloque 3 — Sugerencias proactivas al importar

### 3.1 Análisis baratos y umbrales

| Análisis | Herramienta (licencia) | Umbral razonable | Costo estimado |
|---|---|---|---|
| **Silencios** | FFmpeg `silencedetect` (LGPL/GPL según build). Defaults del filtro: `noise=0.001` (≈ −60 dB), `d=2 s`, `mono=0`; log con `silence_start/end/duration` [V] https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavfilter/af_silencedetect.c | Studio usa −35 dB / 500 ms. Mejorar con piso **relativo**: medir el piso de ruido (percentil 10 del RMS por ventanas de 50 ms) y usar `piso + 8..10 dB`, acotado a [−50, −30] dB; ofrecer la sugerencia si el total quitable ≥ 8 % de la duración **o** ≥ 5 s con ≥ 3 silencios | Solo audio; decodifica a ~100× tiempo real en CPU [U] |
| **Nivel de voz / sonoridad** | FFmpeg `ebur128`: defaults `target=-23`, `peak=none`, con `peak=true` imprime `I` (LUFS integrado), `LRA` y true peak al final [V] https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/libavfilter/f_ebur128.c | Sugerir «subir voz / normalizar» si `I` < −24 LUFS (objetivo de redes −14 LUFS / −1 dBTP, ya en el export); «audio saturado» si true peak > −1 dBTP; «voz irregular» si LRA > 12 LU [U] | Se puede encadenar con `silencedetect` en **una sola pasada**: `-af silencedetect=...,ebur128=peak=true -f null -` [U probar] |
| **Escenas** | PySceneDetect, **BSD-3-Clause** [V] https://raw.githubusercontent.com/Breakthrough/PySceneDetect/main/LICENSE ; `ContentDetector` `threshold=27.0`, `min_scene_len=15` fotogramas; `AdaptiveDetector` `adaptive_threshold=3.0`, `min_content_val=15.0` [S] https://www.scenedetect.com/docs/head/api/detectors.html | `ContentDetector` 27 por defecto; sugerir solo si hay ≥ 3 escenas y la mediana < 12 s; para videos largos analizar con `downscale` automático o a 1 fps [U] | Video decodificado: es lo más caro del lote; correrlo último y con tope de duración (p. ej. primeros 10 min) |
| **Caras** | YuNet (OpenCV Zoo, **MIT**) ya presente en `apps/workers/studio_workers/face/` [S] https://huggingface.co/opencv/face_detection_yunet | Muestrear **1 fotograma por segundo** (no todos); métricas: fracción con cara, nº de caras, descentrado horizontal. Sugerir «reencuadrar siguiendo la cara» si el video es 16:9, el destino es 9:16 y hay cara en ≥ 60 % de las muestras | Muy barato en CPU a 1 fps [U] |
| **Orientación / formato** | `ffprobe` | 16:9 con destino 9:16 (decisión 3 del PLAN-BASE) → sugerir lienzo + reencuadre; video con rotación o VFR → aviso | Instantáneo |
| **Transcripción** | faster-whisper (MIT) | **No automática por defecto**: sugerencia «Transcribir (≈ N min)» con la ETA del test de rendimiento; automática solo si el clip dura ≤ 10 min, el worker está libre y hay VRAM (el gestor de VRAM solo mantiene un modelo residente) | Alta (GPU); es lo que habilita el guion y los subtítulos |

### 3.2 Qué correr y en qué orden

1. `ffprobe` (siempre, ya existe): duración, tamaño, audio.
2. Una pasada de FFmpeg con `silencedetect` + `ebur128` (CPU, rápida, resultado ya útil).
3. Caras a 1 fps (CPU).
4. Escenas (CPU, la más lenta).
5. Transcripción solo según §3.1.

Cada resultado se guarda en la base con clave `(assetId, kind, versión de parámetros)` y se invalida si el archivo cambia (mtime/tamaño) para no repetir al reabrir el proyecto.

### 3.3 No bloquear la importación

- La importación termina con `ffprobe` + miniatura; los análisis arrancan **después**, como trabajos «de fondo» con prioridad baja, visibles en el panel Trabajos, cancelables (Studio ya tiene progreso y cancelación en `TaskQueue`, que cancela en cola y en ejecución con `cancel_event` y `on_cancel`).
- Falta prioridad: `TaskQueue` usa `queue.Queue` FIFO con un solo hilo [V código]. Cambio mínimo: `queue.PriorityQueue` con tupla `(prioridad, contador, task, fn)` y `priority` en `submit()` (0 = pedido por el usuario, 5 = fondo); un trabajo de fondo en ejecución **no** se interrumpe, pero tiene que revisar `cancel_event` entre ventanas/fotogramas para que un pedido del usuario no espere más de ~1 s [U].
- Procesos hijos de FFmpeg con prioridad baja en Windows (`creationflags=BELOW_NORMAL_PRIORITY_CLASS` en `subprocess.Popen`) y `-threads 2` para no pelear con el timeline [U].
- Exclusión mutua con GPU: los análisis sugeridos son CPU; si hay un trabajo de GPU activo, no se lanza la transcripción automática.
- Tope de trabajo por import: límite de 3 videos en paralelo en cola; videos > 30 min solo silencios + loudness hasta que el usuario pida más.
- Un solo aviso agregado («Analizando 3 medios…») en lugar de un toast por análisis (regla del Sprint 5: con workers apagados, un solo aviso).

### 3.4 Cómo presentarlas

Referencias: CapCut «auto cut», Premiere «Enhance Speech» (un botón con vista previa) y DaVinci (detección de silencios por transcripción) comparten el patrón *detectar → mostrar evidencia → aplicar con un clic* [S/V* de `referencias-fluidez-autonomia.md`].
- Un panel «Sugerencias» (o barra bajo el asset) con **una tarjeta por sugerencia**, máximo 4 visibles ordenadas por impacto: título claro («14 silencios largos = 38 s de 3:05»), evidencia mínima (miniatura o mini-forma de onda con los tramos), botones **Aplicar**, **Ver cambios** (abre la vista previa del plan con «3:05 → 2:27») e **Ignorar**; «No sugerir más» por tipo.
- Cada tarjeta es un `EditPlan` ya validado (`cut_silences`, `denoise`, `set_volume`/normalizar, `detect_scenes`, `reframe`, `transcribe`/`add_captions`) → se aplica con el flujo normal, queda en el historial del Asistente y se puede **Deshacer todo**. Las que borran contenido piden confirmación según CLAUDE.md.
- No aplicar nada solo. Estado persistente: pendiente / aplicada / ignorada, para no reaparecer.
- Texto en español rioplatense, sin jerga: «La voz está baja (−31 LUFS). ¿La subo a un nivel normal para redes?».
- Ahorra decisiones: si hay dos sugerencias que se pisan (silencios y muletillas), combinarlas en una («Limpiar pausas y muletillas»).

---

## 4. Recomendación por bloque

| Bloque | Adoptar | Descartar / postergar | Por qué |
|---|---|---|---|
| 1. Guion | Panel Guion sobre `words` existentes; borrar = ripple con corte en el medio del hueco + afinado por energía ±60 ms + fades de 10–15 ms; muletillas con reglas léxicas **y** detección acústica por tres niveles; `fit_duration` voraz por niveles con confirmación; corrección por diff (`SequenceMatcher`) que conserva tiempos | WhisperX / wav2vec2 (peso y VRAM; reabrir si la medición de tiempos falla); CrisperWhisper (CC-BY-NC); IntelliScript/guion→corte; `acrossfade` con solape para empalmes cortos | Cumple «10 muletillas en < 1 min» sin dependencias nuevas ni GPU extra; los tiempos de Whisper son aproximados y se compensan con margen y energía |
| 2. Sistema de diseño | Tokens como esquema zod en `packages/shared` con export DTCG 2025.10; reglas duras de subtítulos (2 líneas, 30/34/42 caracteres, ≥ 4,5 % lado corto, contorno 8 %, duración ≥ 0,83 s); perfil de zona segura conservador en %; fuentes OFL empaquetadas y compartidas por Remotion, vista previa y libass; Player para edición en vivo + `renderStill` para fotograma exacto | Style Dictionary (dependencia extra sin necesidad); selector de varios kits (decisión: un kit); promesa de «cumple Reels»; cargar fuentes de Google Fonts en runtime | Una sola fuente de verdad evita que subtítulos y motion se vean distintos; las cifras de zonas seguras no son oficiales, hay que calibrarlas |
| 3. Sugerencias | Una pasada FFmpeg `silencedetect`+`ebur128`, caras a 1 fps con YuNet, escenas al final; cola con prioridad baja y cancelable; tarjetas con `EditPlan` validado y «Aplicar» | Transcripción automática ilimitada; analizar todo fotograma a fotograma; aplicar sin preguntar; un toast por análisis | Es todo CPU y barato, deja la GPU libre y respeta la regla «nunca editar sin que el usuario apruebe» |

## 5. Riesgos

1. **Tiempos por palabra con error** (±50–150 ms, más tras pausas largas): cortes que comen consonantes. Mitigar con margen, afinado por energía y «evitar cortes bruscos»; medir con 5 clips reales antes de cerrar el sprint.
2. **Muletillas ausentes del texto de Whisper:** la detección acústica puede dar falsos positivos (respiraciones, alargues de vocal intencionales). Mantener «dudosas» sin preseleccionar y mostrar audio al pasar el mouse.
3. **Ambigüedad léxica** («este», «tipo», «nada», «viste», «bueno»): las reglas del §1.3 son heurísticas propias sin validar; podrían borrar palabras con sentido. Por eso nunca se preseleccionan sin pausa y todo borrado es deshacible en un paso.
4. **Zonas seguras y tamaños mínimos no oficiales:** se basan en herramientas de terceros que se contradicen. Calibrar con capturas del teléfono del usuario y documentarlo como guía.
5. **Divergencia entre vista previa, Remotion y libass** (fuentes, interlineado, contorno): mitigar empaquetando fuentes, `fontsdir`, y una prueba de captura comparada por plantilla.
6. **Licencia de Remotion** si Studio se redistribuye (más de 3 empleados en la empresa que lo use requiere licencia comercial) [V]; sin problema para uso personal. Fuentes: incluir OFL.txt; no mezclar fuentes de licencia no verificada.
7. **Análisis de fondo compitiendo con el usuario:** FIFO actual retrasaría trabajos pedidos; sin prioridad y sin cancelación cooperativa una importación de varios videos volvería lenta la edición en el i5. Implementar prioridad antes de activar las sugerencias.
8. **Sobrecorte semántico en `fit_duration`:** quitar oraciones puede romper el sentido (pronombres sin antecedente). Mantener protección de primera/última oración, vista previa con diferencias, confirmación explícita y opción de no pasar de «pausas + muletillas».
