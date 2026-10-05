"""Deterministic Spanish router (agent/router.py): complete EditPlans without the LLM."""

import pytest

from studio_workers.agent.router import normalize, route, rule_names
from studio_workers.agent.schema import validate_plan

ONE_CLIP = """PROYECTO "Viaje" · lienzo 1920x1080 (16:9) · 30 fps · duración 12.5s · cursor 3s
PISTAS (clips por orden de inicio; tiempos en segundos de la línea de tiempo):
- V1 video "Video 1": 1 clip
  1. id=c1 "selfie-tips.mp4" 0-12.5s (12.5s)
- A1 audio "Música": 0 clips
ESCENAS: sin detectar
ARCHIVOS: video "selfie-tips.mp4" id=a1 12.5s
TRANSCRIPCIÓN: no hay"""

TWO_CLIPS = """PROYECTO "Viaje" · lienzo 1920x1080 (16:9) · 30 fps · duración 40s · cursor 3s
PISTAS (clips por orden de inicio; tiempos en segundos de la línea de tiempo):
- V1 video "Video 1": 2 clips
  1. id=c1 "playa.mp4" 0-12.5s (12.5s)
  2. id=c2 "cena.mp4" 12.5-40s (27.5s)
ESCENAS: sin detectar"""

JSON_ONE_CLIP = (
    '{"canvas":{"w":1920,"h":1080},"tracks":[{"kind":"video","clips":'
    '[{"id":"clip_1","name":"entrevista.mp4","start":0,"end":30}]}]}'
)


def ops(command: str, summary: str = ONE_CLIP) -> list[dict]:
    plan = route(command, summary)
    assert plan is not None, f"no route for {command!r}"
    assert validate_plan(plan) == [], validate_plan(plan)
    return plan["ops"]


POSITIVE = [
    # export (presets)
    ("Exportá para Reels", [{"op": "export", "preset": "reels-tiktok", "confirm": True}]),
    ("exporta para tiktok", [{"op": "export", "preset": "reels-tiktok", "confirm": True}]),
    ("exportar para TikTok", [{"op": "export", "preset": "reels-tiktok", "confirm": True}]),
    (
        "exportá el video para reels y tiktok",
        [{"op": "export", "preset": "reels-tiktok", "confirm": True}],
    ),
    ("Exportá para Instagram Reels", [{"op": "export", "preset": "reels-tiktok", "confirm": True}]),
    (
        "exportá para youtube shorts",
        [{"op": "export", "preset": "youtube-shorts", "confirm": True}],
    ),
    ("exportalo pa shorts", [{"op": "export", "preset": "youtube-shorts", "confirm": True}]),
    ("Exportá para YouTube", [{"op": "export", "preset": "youtube-1080p", "confirm": True}]),
    ("exportá en 4k", [{"op": "export", "preset": "youtube-4k", "confirm": True}]),
    ("exportá para youtube en 4k", [{"op": "export", "preset": "youtube-4k", "confirm": True}]),
    ("exportá como gif", [{"op": "export", "preset": "gif-480", "confirm": True}]),
    ("exportá con transparencia", [{"op": "export", "preset": "webm-alpha", "confirm": True}]),
    ("renderizá para reels", [{"op": "export", "preset": "reels-tiktok", "confirm": True}]),
    # silences / fillers
    ("Cortá los silencios", [{"op": "cut_silences"}]),
    ("cortar los silencios", [{"op": "cut_silences"}]),
    ("eliminá las pausas del video", [{"op": "cut_silences"}]),
    ("sacá los silencios y las muletillas", [{"op": "cut_silences", "fillers": True}]),
    ("sacá las muletillas", [{"op": "cut_silences", "fillers": True}]),
    ("quitá las muletillas del video", [{"op": "cut_silences", "fillers": True}]),
    # transcription / captions
    ("Transcribí", [{"op": "transcribe"}]),
    ("transcribí el video", [{"op": "transcribe"}]),
    ("transcribilo", [{"op": "transcribe"}]),
    ("pasalo a texto", [{"op": "transcribe"}]),
    ("poné subtítulos", [{"op": "add_captions"}]),
    ("subtítulos animados", [{"op": "add_captions", "animated": True}]),
    (
        "agregá subtítulos palabra por palabra",
        [{"op": "add_captions", "animated": True}],
    ),
    (
        "poné subtítulos estilo karaoke",
        [{"op": "add_captions", "animated": True, "style": "karaoke"}],
    ),
    (
        "Poné subtítulos simples, sin animación",
        [{"op": "add_captions", "animated": False}],
    ),
    # reframe / canvas
    ("Reencuadrá a vertical", [{"op": "reframe", "target": "9:16"}]),
    ("reencuadrá a 9:16", [{"op": "reframe", "target": "9:16"}]),
    ("pasalo a 9 x 16", [{"op": "reframe", "target": "9:16"}]),
    ("reencuadrá a 4:5", [{"op": "reframe", "target": "4:5"}]),
    (
        "reencuadrá a cuadrado siguiendo la cara",
        [{"op": "reframe", "target": "1:1", "subject": "face"}],
    ),
    ("poné el lienzo vertical", [{"op": "set_canvas", "preset": "9:16"}]),
    ("lienzo vertical", [{"op": "set_canvas", "preset": "9:16"}]),
    ("cambiá el lienzo a 16:9", [{"op": "set_canvas", "preset": "16:9"}]),
    ("pone el lienso cuadrado", [{"op": "set_canvas", "preset": "1:1"}]),
    # scenes
    ("detectá escenas", [{"op": "detect_scenes"}]),
    ("detectá las escenas y cortá", [{"op": "detect_scenes", "split": True}]),
    ("dividí por escenas", [{"op": "detect_scenes", "split": True}]),
    ("Dividí el video en cada cambio de plano", [{"op": "detect_scenes", "split": True}]),
    # audio / background (one clip in the project -> {name})
    ("limpiá el audio", [{"op": "denoise", "clip": {"name": "selfie-tips"}}]),
    ("sacá el ruido de fondo", [{"op": "denoise", "clip": {"name": "selfie-tips"}}]),
    (
        "quitá el fondo",
        [
            {
                "op": "remove_background",
                "clip": {"name": "selfie-tips"},
                "background": {"type": "color"},
            }
        ],
    ),
    (
        "desenfocá el fondo",
        [
            {
                "op": "remove_background",
                "clip": {"name": "selfie-tips"},
                "background": {"type": "blur"},
            }
        ],
    ),
    # publish / AI label
    ("etiqueta IA", [{"op": "set_publish", "for_social": True, "ai_label": True}]),
    ("poné la etiqueta de IA", [{"op": "set_publish", "for_social": True, "ai_label": True}]),
    ("sacá la etiqueta IA", [{"op": "set_publish", "for_social": True, "ai_label": False}]),
    # politeness and chains
    ("por favor transcribí el video", [{"op": "transcribe"}]),
    ("che, cortá los silencios porfa", [{"op": "cut_silences"}]),
    (
        "cortá los silencios y exportá para reels",
        [{"op": "cut_silences"}, {"op": "export", "preset": "reels-tiktok", "confirm": True}],
    ),
    (
        "cortá los silencios, transcribí y después exportá para shorts",
        [
            {"op": "cut_silences"},
            {"op": "transcribe"},
            {"op": "export", "preset": "youtube-shorts", "confirm": True},
        ],
    ),
]


@pytest.mark.parametrize(("command", "expected"), POSITIVE, ids=[c for c, _ in POSITIVE])
def test_routes_simple_commands(command: str, expected: list[dict]) -> None:
    assert ops(command) == expected


NEGATIVE = [
    "exportá",  # no preset: the LLM (or a question) decides
    "exportá para facebook",
    "no cortes los silencios",
    "¿cómo exporto para reels?",
    "cortá los silencios del segundo clip",
    "cortá el clip en el segundo 5",
    "agregá un título en el segundo 3",
    "subtítulos amarillos grandes arriba",
    "quitá el fondo y poné una playa",
    "exportá para reels y poné un título que diga hola",
    "borrá el clip",
    "reencuadrá",
    "bajá la música",
    "poné música de fondo",
    "acelerá el clip 2x",
    "hacé que el texto siga la cara",
    "cortame los silencios q hay plis, y las muletillas tmb",
    "exportá para reels sin los silencios",
    "el audio está sucio",
    "",
]


@pytest.mark.parametrize("command", NEGATIVE)
def test_ambiguous_or_complex_commands_go_to_the_llm(command: str) -> None:
    assert route(command, ONE_CLIP) is None


def test_clip_commands_ask_when_several_candidates() -> None:
    plan = route("limpiá el audio", TWO_CLIPS)
    assert plan is not None and plan["ops"] == []
    assert plan["questions"] == ["¿A qué clip limpio el audio: playa.mp4 o cena.mp4?"]
    assert validate_plan(plan) == []


def test_clip_commands_need_a_readable_summary() -> None:
    # without clips the deterministic route cannot pick one: the LLM asks instead
    assert route("quitá el fondo", "") is None
    assert route("quitá el fondo", "texto libre sin pistas") is None


def test_json_summaries_are_read_too() -> None:
    assert ops("limpiá el audio", JSON_ONE_CLIP) == [
        {"op": "denoise", "clip": {"name": "entrevista"}}
    ]


def test_normalize_strips_accents_politeness_and_punctuation() -> None:
    assert normalize("¡Por favor, Exportá para Reels!") == "exporta para reels"
    assert normalize("pasalo a 9 / 16") == "pasalo a 9:16"
    assert normalize("Transcribí, gracias") == "transcribi"


def test_summary_es_and_rules_listed() -> None:
    plan = route("cortá los silencios y exportá para reels")
    assert plan is not None
    assert plan["summary_es"] == "Cortar los silencios. Exportar para Reels / TikTok."
    assert {"export", "cut_silences", "transcribe", "captions", "reframe"} <= set(rule_names())


def test_export_always_confirms() -> None:
    for command in ("exportá para reels", "exportá para youtube", "exportá en 4k"):
        assert ops(command)[0]["confirm"] is True
