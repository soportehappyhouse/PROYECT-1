"""StylePreset deduced by a local vision LLM (pack ``vision-llm``: Ollama ``qwen2.5vl:3b``).

The model gets the contact sheet (PNG, base64 ``images``) plus a compact JSON of the analysis and
answers with Ollama structured outputs (``format`` = ``stylepreset.schema.json``, exported from
packages/shared/src/style.ts). The answer is validated with the same schema; up to 3 attempts
feeding the errors back. Missing Ollama/model -> 409 PACK_REQUIRED whose text also offers the
Claude console (no download needed there).
"""

from __future__ import annotations

import base64
import copy
import json
import os
from collections.abc import Callable
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from ..agent.ollama_client import (
    OllamaClient,
    OllamaError,
    OllamaModelMissingError,
    OllamaRemoteRefusedError,
    model_in,
    strip_thinking,
)
from ..packs import PackRequiredError, style_vision_model

SCHEMA_PATH = Path(__file__).with_name("stylepreset.schema.json")
VISION_PACK_ID = "vision-llm"
VISION_VRAM_MB = 4000
MAX_ATTEMPTS = 3
CONSOLE_HINT_ES = (
    "o usá la Consola Claude («Deducir con Consola Claude» en Perfil de estilo): no necesita "
    "descargar nada"
)

SYSTEM_PROMPT_PATH = Path(__file__).with_name("system_es.md")


@lru_cache
def system_prompt() -> str:
    return SYSTEM_PROMPT_PATH.read_text("utf-8").strip()


@lru_cache
def load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text("utf-8"))


def ollama_format() -> dict[str, Any]:
    schema = copy.deepcopy(load_schema())
    for key in ("$schema", "$id", "title"):
        schema.pop(key, None)
    return schema


@lru_cache
def _validator() -> Draft202012Validator:
    schema = load_schema()
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate_preset(preset: Any) -> list[str]:
    """Error lines ("cut_rhythm.min_silence_ms: 50 is less than the minimum of 100")."""
    errors = []
    for err in sorted(_validator().iter_errors(preset), key=lambda e: list(e.absolute_path)):
        where = ".".join(str(p) for p in err.absolute_path) or "(raíz)"
        errors.append(f"{where}: {err.message}")
    return errors[:12]


def compact_analysis(analysis: dict[str, Any]) -> dict[str, Any]:
    """What the model needs from the analysis (no paths, ≤ ~2 KB)."""
    motion = analysis.get("motion") or {}
    events = motion.get("zoom_events") or []
    kinds: dict[str, int] = {}
    for e in events:
        kinds[e.get("kind", "?")] = kinds.get(e.get("kind", "?"), 0) + 1
    texts = []
    for item in analysis.get("text_on_screen") or []:
        if item.get("text") and len(texts) < 20:
            texts.append(
                {"t": item.get("t"), "text": str(item["text"])[:80], "bbox": item.get("bbox")}
            )
    out: dict[str, Any] = {
        "duration_s": analysis.get("duration_s"),
        "canvas": analysis.get("canvas"),
        "shot_stats": {
            k: v for k, v in (analysis.get("shot_stats") or {}).items() if k != "histogram"
        },
        "motion": {
            "pan": motion.get("pan_estimate"),
            "zoom_events": kinds,
            "first_zoom_events": events[:8],
        },
        "audio": {
            k: v
            for k, v in (analysis.get("audio") or {}).items()
            if k in ("loudness_lufs", "speech_ratio", "music_detected", "silence_ratio")
        },
        "contact_sheet_times": (analysis.get("contact_sheet") or {}).get("times"),
    }
    if texts:
        out["text_on_screen"] = texts
    if analysis.get("transcript_excerpt"):
        out["transcript_excerpt"] = str(analysis["transcript_excerpt"])[:600]
    return out


def pack_detail(model: str, *, ollama_up: bool, url: str) -> str:
    if not ollama_up:
        return (
            f"Ollama no está corriendo en {url}: abrilo desde el menú Inicio (queda en la bandeja "
            f"del sistema) y descargá el modelo de visión «{model}» en Ajustes → Paquetes "
            f"(«Modelo de visión local», ~3,2 GB) o con `ollama pull {model}`; "
            f"{CONSOLE_HINT_ES}."
        )
    return (
        f"Falta el modelo de visión local «{model}» (paquete vision-llm, ~3,2 GB). Descargalo en "
        f"Ajustes → Paquetes o en una terminal: `ollama pull {model}`; {CONSOLE_HINT_ES}."
    )


async def infer_preset(
    client: OllamaClient,
    analysis: dict[str, Any],
    contact_sheet: Path,
    *,
    model: str | None = None,
    temperature: float = 0.2,
    keep_alive: str | int | None = "60s",
    num_ctx: int | None = None,
    before_llm: Callable[[], list[str]] | None = None,
) -> dict[str, Any]:
    """{preset, model, latency_ms, attempts, warnings}; PackRequiredError(vision-llm) when Ollama
    or the model is missing; OllamaError when no valid preset after MAX_ATTEMPTS."""
    model = model or style_vision_model()
    num_ctx = num_ctx or int(os.environ.get("STYLE_NUM_CTX", "8192") or 8192)
    try:
        installed = await client.installed_models(timeout=3.0)
    except OllamaRemoteRefusedError:
        raise
    except OllamaError as exc:
        raise PackRequiredError(
            VISION_PACK_ID, pack_detail(model, ollama_up=False, url=client.base_url)
        ) from exc
    if not model_in(model, installed):
        raise PackRequiredError(
            VISION_PACK_ID, pack_detail(model, ollama_up=True, url=client.base_url)
        )
    warnings: list[str] = []
    if before_llm is not None:
        warnings.extend(before_llm())
    image = base64.b64encode(contact_sheet.read_bytes()).decode("ascii")
    user = (
        "Hoja de contactos adjunta. Análisis automático del video de referencia:\n"
        + json.dumps(compact_analysis(analysis), ensure_ascii=False, separators=(",", ":"))
        + "\nDevolvé el perfil de estilo en JSON."
    )
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt()},
        {"role": "user", "content": user, "images": [image]},
    ]
    latency = 0
    last_errors: list[str] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            res = await client.chat(
                model,
                messages,  # type: ignore[arg-type]  # Ollama accepts `images` on a message
                format=ollama_format(),
                temperature=temperature,
                num_ctx=num_ctx,
                keep_alive=keep_alive,
            )
        except OllamaModelMissingError as exc:
            raise PackRequiredError(
                VISION_PACK_ID, pack_detail(model, ollama_up=True, url=client.base_url)
            ) from exc
        latency += res.latency_ms
        text = strip_thinking(res.content)
        try:
            preset = json.loads(text)
        except ValueError:
            last_errors = ["la respuesta no es JSON"]
            preset = None
        else:
            last_errors = validate_preset(preset)
        if not last_errors:
            return {
                "preset": preset,
                "model": res.model,
                "latency_ms": latency,
                "attempts": attempt,
                "warnings": warnings,
            }
        warnings.append(f"attempt_{attempt}_invalid")
        messages.append({"role": "assistant", "content": text[:4000]})
        messages.append(
            {
                "role": "user",
                "content": "El JSON no cumple el esquema: "
                + "; ".join(last_errors)
                + ". Corregilo y devolvé solo el JSON.",
            }
        )
    raise OllamaError(
        f"El modelo {model} no devolvió un perfil de estilo válido tras {MAX_ATTEMPTS} intentos "
        f"({'; '.join(last_errors[:3])}). Probá de nuevo o usá la Consola Claude."
    )
