"""Deterministic Spanish router: simple, unambiguous commands -> EditPlan without the LLM.

Contract (docs/trabajo/sprint3-contratos.md): what is deterministic never goes through the LLM.
A rule matches the WHOLE command (after normalisation: lower case, no accents, no punctuation,
politeness words removed), so anything extra ("…del segundo clip", "…en amarillo", "no …") falls
through to the LLM. Commands joined with "y", "," or "y después" are split and routed clause by
clause; the plan is deterministic only when every clause matches a rule.

Rules (voseo, tú and infinitive forms are all accepted):

==========================  =================================================================
command (examples)          plan
==========================  =================================================================
exportá para reels|tiktok   export {preset: reels-tiktok}  (shorts -> youtube-shorts,
                            youtube -> youtube-1080p, youtube 4k -> youtube-4k, gif, webm alfa)
cortá los silencios         cut_silences {}   ("…y las muletillas" -> fillers: true)
sacá las muletillas         cut_silences {fillers: true}
transcribí / pasalo a texto transcribe {}
poné subtítulos [animados]  add_captions {language: es[, animated: true][, style]}
reencuadrá a vertical|9:16  reframe {target: 9:16} (cuadrado -> 1:1, 4:5; "siguiendo la cara")
poné el lienzo vertical     set_canvas {preset: 9:16} (horizontal 16:9, cuadrado 1:1)
detectá escenas             detect_scenes {}  ("…y cortá" / "dividí por escenas" -> split)
limpiá el audio / el ruido  denoise {clip}    (only when the project has ONE candidate clip)
quitá el fondo              remove_background {clip, background: color} (desenfocá -> blur)
poné la etiqueta IA         set_publish {for_social: true, ai_label: true} (sacá -> false)
bajá / subí la música       set_volume {clip, volume_db: -12 | +6 | "a -6 dB"} (silenciá -> -60)
mové el texto al segundo 5  move_clip {clip, t} (texto / cartel / música; inicio, cursor, 1:20)
==========================  =================================================================
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import summary as summ

Op = dict[str, Any]
Plan = dict[str, Any]

# ----------------------------------------------------------------------------- normalisation

_POLITE = [
    r"por favor",
    r"porfa(?:vor)?",
    r"please",
    r"che",
    r"dale",
    r"ahora",
    r"ya",
    r"bueno",
    r"ok",
    r"listo",
    r"a ver",
    r"me (?:podes|podrias|puedes|podria|harias) ",
    r"(?:podes|podrias|puedes) ",
    r"quiero que (?=\w)",
    r"necesito (?=\w)",
    r"quiero (?=\w)",
]
_LEAD = re.compile(rf"^(?:(?:{'|'.join(_POLITE)})\s*)+")
_TRAIL = re.compile(r"(?:\s+(?:por favor|porfa(?:vor)?|please|gracias|che|dale))+$")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("“", '"').replace("”", '"')
    text = re.sub(r"[¡!¿?\"'«»`.]+", " ", text)
    text = re.sub(r"(\d)\s*[:x/]\s*(\d)", r"\1:\2", text)  # 9 x 16, 9/16 -> 9:16
    text = re.sub(r"\s+", " ", text).strip(" ,;")
    for _ in range(3):
        text = _LEAD.sub("", text).strip()
        text = _TRAIL.sub("", text).strip(" ,;")
    return text


# Imperative (voseo / tú), infinitive and "+lo/+le" enclitics, accent-free.
def _v(*stems: str) -> str:
    """'export' -> exporta|exportar|exportalo|exportarlo|exporte… (stem of an -ar verb)."""
    return "(?:" + "|".join(rf"{s}(?:a|ar|e)(?:lo|le|la|los|las|me|melo)?" for s in stems) + ")"


def _vi(*stems: str) -> str:
    """-ir / -er verbs: 'transcrib' -> transcribi|transcribir|transcribe|transcribilo…"""
    return "(?:" + "|".join(rf"{s}(?:i|ir|e)(?:lo|le|la|los|las|me|melo)?" for s in stems) + ")"


VIDEO_OBJ = (
    r"(?: (?:el|este|todo el|del|de este|de todo el) (?:video|proyecto|clip)"
    r"(?: terminado| final| completo)?)?"
)
REMOVE = _v("cort", "sac", "quit", "elimin", "borr", "recort", "limpi")
ADD = (
    rf"(?:{_v('agreg', 'gener', 'activ', 'mand', 'sum', 'arm')}|{_vi('pon', 'hac', 'met')}"
    r"|pon(?:le|me)?|hace(?:me|le)?|crea(?:r|le)?)"
)

PRESETS = [
    (r"(?:youtube|yt) (?:en )?4k|4k", "youtube-4k", "YouTube 4K"),
    (r"(?:youtube |yt )?shorts?", "youtube-shorts", "YouTube Shorts"),
    (
        r"(?:instagram |ig )?reels?(?: de (?:instagram|ig))?(?: (?:y|o|e) tik ?toks?)?"
        r"|tik ?toks?(?: (?:y|o|e) (?:instagram |ig )?reels?)?|instagram",
        "reels-tiktok",
        "Reels / TikTok",
    ),
    (r"(?:youtube|yt)(?: (?:en )?(?:1080p?|full ?hd|hd|horizontal))?", "youtube-1080p", "YouTube"),
    (r"(?:un )?gif(?: animado)?", "gif-480", "GIF"),
    (
        r"webm(?: (?:con )?(?:alfa|alpha|transparencia))?|transparencia|fondo transparente",
        "webm-alpha",
        "WebM con transparencia",
    ),
]

CANVAS = {
    "vertical": "9:16",
    "9:16": "9:16",
    "horizontal": "16:9",
    "16:9": "16:9",
    "apaisado": "16:9",
    "cuadrado": "1:1",
    "1:1": "1:1",
}
REFRAME = {"vertical": "9:16", "9:16": "9:16", "cuadrado": "1:1", "1:1": "1:1", "4:5": "4:5"}
CAPTION_STYLES = ("clasico", "reels", "karaoke", "minimal", "titular")


# ----------------------------------------------------------------------------------- rules


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]
    build: Callable[[re.Match[str], str], tuple[list[Op], list[str]] | None]
    summary_es: Callable[[re.Match[str]], str]


def _rx(p: str) -> re.Pattern[str]:
    return re.compile(rf"^(?:{p})$")


def _export(m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    target = m.group("target")
    for pat, preset, _label in PRESETS:
        if re.fullmatch(pat, target):
            return [{"op": "export", "preset": preset, "confirm": True}], []
    raise AssertionError(target)  # pragma: no cover - pattern built from PRESETS


def _export_label(m: re.Match[str]) -> str:
    for pat, _preset, label in PRESETS:
        if re.fullmatch(pat, m.group("target")):
            return f"Exportar para {label}."
    return "Exportar."  # pragma: no cover


_PRESET_ALT = "|".join(f"(?:{p})" for p, _, _ in PRESETS)
EXPORT_RX = (
    rf"{_v('export', 'renderiz')}{VIDEO_OBJ} "
    rf"(?:para|pa|a|en|como|con|con el preset(?: de)?|en formato|formato)"
    rf"(?: (?:subir a|publicar en|el|un|una|formato|preset|de))*"
    rf" (?P<target>{_PRESET_ALT})"
)


SILENCE_WORDS = (
    r"(?:los |las |todos los |todas las )?(?:silencios|pausas|espacios muertos|tiempos muertos)"
)
FILLER_WORDS = r"(?:las |todas las )?muletillas(?: \(?(?:eh|este|o sea)[ ,eh este o sea]*\)?)?"
SILENCES_RX = (
    rf"{REMOVE}{VIDEO_OBJ} {SILENCE_WORDS}(?P<fill> (?:y|e) {FILLER_WORDS})?{VIDEO_OBJ}"
    rf"|{REMOVE}{VIDEO_OBJ} (?P<fill2>{FILLER_WORDS}) (?:y|e) {SILENCE_WORDS}{VIDEO_OBJ}"
)


def _silences_any(m: re.Match[str], s: str) -> tuple[list[Op], list[str]]:
    op: Op = {"op": "cut_silences"}
    if m.group("fill") or m.group("fill2"):
        op["fillers"] = True
    return [op], []


def _fillers(_m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    return [{"op": "cut_silences", "fillers": True}], []


FILLERS_RX = rf"{REMOVE}{VIDEO_OBJ} {FILLER_WORDS}{VIDEO_OBJ}"


def _transcribe(_m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    return [{"op": "transcribe"}], []


TRANSCRIBE_RX = (
    rf"(?:{_vi('transcrib')}|{_v('pas')} a texto|{ADD} (?:la )?transcripcion"
    rf"|transcripcion){VIDEO_OBJ}(?: (?:a|en) (?:texto|espanol))?"
)


def _captions(m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    op: Op = {"op": "add_captions"}
    style = m.group("style")
    if m.group("anim") or style in ("reels", "karaoke"):
        op["animated"] = True
    elif m.group("plain"):
        op["animated"] = False
    if style:
        op["style"] = style
    return [op], []


def _captions_label(m: re.Match[str]) -> str:
    if m.group("anim") or m.group("style") in ("reels", "karaoke"):
        return "Agregar subtítulos animados."
    return "Agregar subtítulos."


CAPTIONS_RX = (
    rf"(?:(?:{ADD}|{_v('subtitul')}) ?)?(?:los |unos |(?:los )?)?(?:subtitulos?|captions)?"
    rf"(?:(?P<anim> animados| palabra (?:a|por) palabra| dinamicos)"
    rf"|(?P<plain> simples(?: sin animacion)?| sin animacion))?"
    rf"(?: (?:con )?(?:el )?estilo (?P<style>{'|'.join(CAPTION_STYLES)}))?"
    rf"(?: en espanol)?{VIDEO_OBJ}"
)
_CAPTIONS_GUARD = re.compile(r"subtitul|captions")


REFRAME_RX = (
    rf"(?:{_v('reencuadr', 'encuadr')}|{_v('pas', 'adapt', 'transform')}|{_vi('convert')})"
    rf"{VIDEO_OBJ} (?:a|en|para|al) (?:formato |modo )?(?P<t>vertical|9:16|cuadrado|1:1|4:5)"
    rf"(?P<face> siguiendo (?:la cara|a la persona|al sujeto|al que habla))?"
    rf"|{_v('reencuadr')}{VIDEO_OBJ} (?:en )?(?P<t2>vertical|9:16)"
)


def _reframe_any(m: re.Match[str], s: str) -> tuple[list[Op], list[str]]:
    target = m.group("t") or m.group("t2")
    op: Op = {"op": "reframe", "target": REFRAME[target]}
    if m.group("face"):
        op["subject"] = "face"
    return [op], []


def _canvas(m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    return [{"op": "set_canvas", "preset": CANVAS[m.group("p") or m.group("p2")]}], []


_CANVAS_ALT = "|".join(re.escape(k) for k in CANVAS)
CANVAS_RX = (
    rf"(?:{ADD}|{_v('cambi', 'pas', 'configur', 'dej', 'ajust')}) (?:el )?(?:lien[sz]o|canvas)"
    rf"(?: (?:a|en|como|del proyecto))?(?: (?:formato|modo))? (?P<p>{_CANVAS_ALT})"
    rf"|(?:el )?(?:lien[sz]o|canvas) (?:en )?(?P<p2>{_CANVAS_ALT})"
)


def _scenes(m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    op: Op = {"op": "detect_scenes"}
    if m.group("split") or m.group("split2"):
        op["split"] = True
    return [op], []


SCENE_WORDS = (
    r"(?:las |los |cada )?(?:escenas?|cambios? de (?:escena|plano)|cortes? de (?:escena|camara)"
    r"|planos?)"
)
SPLIT_V = _vi("divid", "part") + "|" + _v("cort", "separ")
SCENES_RX = (
    rf"(?:{_v('detect', 'marc', 'busc', 'analiz', 'encontr')}){VIDEO_OBJ} {SCENE_WORDS}{VIDEO_OBJ}"
    rf"(?P<split> (?:y|e) (?:{SPLIT_V})(?:lo|la|los|las)?(?: (?:en|por) (?:cada )?"
    rf"(?:una|escena|cambio|corte))?)?"
    rf"|(?P<split2>{SPLIT_V}){VIDEO_OBJ} (?:por|en|segun) {SCENE_WORDS}"
)


def _denoise(_m: re.Match[str], s: str) -> tuple[list[Op], list[str]] | None:
    clip = _single_clip(s, ("video", "audio"))
    if clip is None:
        return None
    if isinstance(clip, list):
        return [], [_which_clip_q("limpio el audio", clip)]
    return [{"op": "denoise", "clip": clip}], []


DENOISE_RX = (
    rf"{_v('limpi', 'mejor')}{VIDEO_OBJ} (?:el |la )?(?:audio|sonido|voz)(?: del video)?"
    rf"|(?:{_v('sac', 'quit', 'elimin', 'baj', 'borr')}|{_vi('reduc')}) (?:el )?ruido"
    rf"(?: de fondo)?(?: del (?:audio|video|sonido)| de la voz)?"
)


def _background(m: re.Match[str], s: str) -> tuple[list[Op], list[str]] | None:
    clip = _single_clip(s, ("video",))
    if clip is None:
        return None
    if isinstance(clip, list):
        return [], [_which_clip_q("le quito el fondo", clip)]
    kind = "blur" if (m.group("blur") or m.group("blur2")) else "color"
    return [{"op": "remove_background", "clip": clip, "background": {"type": kind}}], []


BG_RX = (
    rf"{_v('sac', 'quit', 'elimin', 'borr', 'recort')}{VIDEO_OBJ} (?:el )?fondo"
    rf"(?: (?:del video|de la persona|al video))?"
    rf"(?P<blur> y {ADD} (?:un )?fondo (?:desenfocado|borroso)| y {_v('desenfoc')}lo)?"
    rf"|(?P<blur2>{_v('desenfoc')}) (?:el )?fondo(?: del video)?"
)


def _ai_label(m: re.Match[str], _s: str) -> tuple[list[Op], list[str]]:
    on = not m.group("off")
    return [{"op": "set_publish", "for_social": True, "ai_label": on}], []


AI_LABEL_RX = (
    rf"(?:(?P<off>{_v('sac', 'quit', 'elimin', 'borr', 'desactiv')})|{ADD}|{_v('marc')})?"
    rf"(?: (?:la|una))? ?etiqueta (?:de )?(?:ia|inteligencia artificial)"
    rf"|{_v('marc', 'etiquet')}{VIDEO_OBJ} como (?:contenido )?(?:hecho|generado|alterado) "
    rf"(?:con|por) (?:ia|inteligencia artificial)"
)


MUSIC = r"(?:la )?(?:musica|cancion)(?: de fondo)?"
DB = r"(?P<{}>[-+]?\d{{1,2}}) ?(?:db|decibeles?)"
VOLUME_RX = (
    rf"(?P<down>{_v('baj')})(?: (?:el )?(?:volumen|sonido))?(?: (?:a|de))? {MUSIC}"
    rf"(?: (?:a|en|unos) {DB.format('db')}| (?:al )?(?:fondo|minimo)| un poco)?"
    rf"|(?P<up>{_vi('sub')})(?: (?:el )?(?:volumen|sonido))?(?: (?:a|de))? {MUSIC}"
    rf"(?: (?:a|en|unos) {DB.format('db2')}| un poco)?"
    rf"|(?P<mute>{_v('silenci', 'mute', 'mut')}) {MUSIC}"
    rf"|(?:{_v('sac', 'quit')})(?:le)? (?:el )?(?:sonido|volumen) a {MUSIC}"
)


def _volume(m: re.Match[str], s: str) -> tuple[list[Op], list[str]] | None:
    clip = _single_clip(s, ("audio",))
    if clip is None:
        return None
    if isinstance(clip, list):
        return [], [_which_clip_q("le cambio el volumen", clip)]
    db_text = m.group("db") or m.group("db2")
    if m.group("mute") or not (m.group("down") or m.group("up")):
        db = -60.0
    elif db_text:
        db = abs(float(db_text)) * (1 if m.group("up") else -1)
    else:
        db = 6.0 if m.group("up") else -12.0
    db = max(-60.0, min(12.0, db))
    return [{"op": "set_volume", "clip": clip, "volume_db": int(db) if db.is_integer() else db}], []


def _volume_label(m: re.Match[str]) -> str:
    if m.group("mute") or not (m.group("down") or m.group("up")):
        return "Silenciar la música."
    return "Subir la música." if m.group("up") else "Bajar la música."


MOVE_OBJ = {"el texto": ("text",), "el cartel": ("text",), "la musica": ("audio",)}
MOVE_RX = (
    rf"{_v('mov', 'llev', 'corr', 'pas')}(?: (?P<obj>el texto|el cartel|la musica))"
    r" (?:al|a|hasta el|hasta|para el) ?(?:"
    r"(?P<start>inicio|principio|comienzo)"
    r"|(?P<cursor>cursor|donde esta el cursor|cabezal)"
    r"|(?:segundo )?(?P<mm>\d{1,2}):(?P<ss>\d{2})"
    r"|segundo (?P<sec>\d{1,4})|los (?P<sec2>\d{1,4}) segundos)"
)


def _move(m: re.Match[str], s: str) -> tuple[list[Op], list[str]] | None:
    clip = _single_clip(s, MOVE_OBJ[m.group("obj")])
    if clip is None:
        return None
    if isinstance(clip, list):
        return [], [_which_clip_q("muevo", clip)]
    t: Any
    if m.group("start"):
        t = "start"
    elif m.group("cursor"):
        t = "cursor"
    elif m.group("mm"):
        t = int(m.group("mm")) * 60 + int(m.group("ss"))
    else:
        t = int(m.group("sec") or m.group("sec2"))
    return [{"op": "move_clip", "clip": clip, "t": t}], []


def _label(text: str) -> Callable[[re.Match[str]], str]:
    return lambda _m: text


RULES: list[Rule] = [
    Rule("export", _rx(EXPORT_RX), _export, _export_label),
    Rule(
        "cut_silences",
        _rx(SILENCES_RX),
        _silences_any,
        lambda m: (
            "Cortar silencios y muletillas."
            if (m.group("fill") or m.group("fill2"))
            else "Cortar los silencios."
        ),
    ),
    Rule("fillers", _rx(FILLERS_RX), _fillers, _label("Cortar las muletillas.")),
    Rule("transcribe", _rx(TRANSCRIBE_RX), _transcribe, _label("Transcribir el video.")),
    Rule("captions", _rx(CAPTIONS_RX), _captions, _captions_label),
    Rule(
        "reframe",
        _rx(REFRAME_RX),
        _reframe_any,
        lambda m: f"Reencuadrar a {REFRAME[m.group('t') or m.group('t2')]}.",
    ),
    Rule(
        "set_canvas",
        _rx(CANVAS_RX),
        _canvas,
        lambda m: f"Lienzo {CANVAS[m.group('p') or m.group('p2')]}.",
    ),
    Rule(
        "detect_scenes",
        _rx(SCENES_RX),
        _scenes,
        lambda m: (
            "Detectar escenas y dividir."
            if (m.group("split") or m.group("split2"))
            else "Detectar escenas."
        ),
    ),
    Rule("denoise", _rx(DENOISE_RX), _denoise, _label("Limpiar el ruido del audio.")),
    Rule(
        "remove_background",
        _rx(BG_RX),
        _background,
        lambda m: (
            "Desenfocar el fondo." if (m.group("blur") or m.group("blur2")) else "Quitar el fondo."
        ),
    ),
    Rule("set_volume", _rx(VOLUME_RX), _volume, _volume_label),
    Rule("move_clip", _rx(MOVE_RX), _move, _label("Mover el clip.")),
    Rule(
        "ai_label",
        _rx(AI_LABEL_RX),
        _ai_label,
        lambda m: "Quitar la etiqueta de IA." if m.group("off") else "Poner la etiqueta de IA.",
    ),
]


# ------------------------------------------------------------------------- clip resolution


def _single_clip(summary: str, kinds: tuple[str, ...]) -> Op | list[str] | None:
    """{name} (or {track, index: 1}) when exactly one candidate clip; [names] when several;
    None when the summary could not be read."""
    found = summ.clips(summary)
    if found is None:
        return None
    for kind in kinds:
        cands = [c for c in found if c.track == kind]
        if len(cands) == 1:
            stem = re.sub(r"\.[a-z0-9]{2,4}$", "", cands[0].name, flags=re.I).strip()
            return {"name": stem} if stem else {"track": kind, "index": 1}
        if len(cands) > 1:
            return [c.name or c.id for c in cands]
    return None


def _which_clip_q(action: str, names: list[str]) -> str:
    shown = names[:5]
    listed = ", ".join(shown[:-1]) + f" o {shown[-1]}" if len(shown) > 1 else shown[0]
    return f"¿A qué clip {action}: {listed}?"


# ---------------------------------------------------------------------------------- routing

_SPLIT = re.compile(
    r"\s*(?:,|;)\s*(?:y\s+)?(?:(?:despues|luego)\s+)?"
    r"|\s+y\s+(?:(?:despues|luego)\s+)?"
    r"|\s+(?:despues|luego)\s+"
)


@dataclass
class Match:
    rule: str
    ops: list[Op]
    questions: list[str]
    summary_es: str


def match_clause(clause: str, summary: str = "") -> Match | None:
    clause = normalize(clause)
    if not clause:
        return None
    for rule in RULES:
        if rule.name == "captions" and not _CAPTIONS_GUARD.search(clause):
            continue
        m = rule.pattern.match(clause)
        if not m:
            continue
        built = rule.build(m, summary)
        if built is None:
            return None  # the rule needs data we do not have: let the LLM ask
        ops, questions = built
        text = rule.summary_es(m) if ops else "Falta elegir el clip."
        return Match(rule.name, ops, questions, text)
    return None


def _segment(parts: list[str], summary: str) -> list[Match] | None:
    """Split the clause list into consecutive groups that each match a rule (longest first)."""
    if not parts:
        return []
    for end in range(len(parts), 0, -1):
        joined = " y ".join(parts[:end])
        m = match_clause(joined, summary)
        if m is None:
            continue
        rest = _segment(parts[end:], summary)
        if rest is not None:
            return [m, *rest]
    return None


def route(command: str, project_summary: Any = "") -> Plan | None:
    """A complete EditPlan when every part of the command is a known simple command, else None."""
    summary = summ.as_text(project_summary)
    text = normalize(command)
    if not text or len(text) > 200:
        return None
    parts = [p for p in _SPLIT.split(text) if p and p.strip()]
    if len(parts) > 6:
        return None
    whole = match_clause(re.sub(r"\s*[,;]\s*", " ", text), summary)
    matches = [whole] if whole else _segment(parts, summary)
    if not matches:
        return None
    ops = [op for m in matches for op in m.ops]
    questions = [q for m in matches for q in m.questions]
    plan: Plan = {
        "version": 1,
        "summary_es": " ".join(m.summary_es for m in matches)[:500],
        "ops": ops,
    }
    if questions:
        plan["questions"] = questions
    return plan


def rule_names() -> list[str]:
    return [r.name for r in RULES]
