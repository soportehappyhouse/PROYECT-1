"""Bug report drafting: local LLM when available, deterministic Spanish template otherwise.

POST /agent/bugreport {title?, steps_text, breadcrumbs, errors, env} -> {markdown_es, source}.
The model only fills a small JSON (title, steps, expected, actual, notes) through structured
outputs; the markdown (fixed headings the web parses) is always rendered here, and the errors,
last actions and environment are copied verbatim (never paraphrased by the model).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from .ollama_client import OllamaClient, OllamaError, model_in

MAX_BREADCRUMBS = 15
MAX_ERRORS = 8
H_STEPS = "## Pasos para reproducir"
H_EXPECTED = "## Qué esperaba"
H_ACTUAL = "## Qué pasó"
TODO_EXPECTED = "(completá qué esperabas que pasara)"
TODO_ACTUAL = "(completá qué pasó en realidad)"

DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Título breve del problema"},
        "steps": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
        "expected": {"type": "string"},
        "actual": {"type": "string"},
        "notes": {"type": "string"},
    },
    "required": ["title", "steps", "expected", "actual"],
    "additionalProperties": False,
}

SYSTEM_ES = (
    "Redactás reportes de errores de Studio (editor de video local) en español rioplatense, "
    "claros y breves. Usá SOLO la información que te dan: no inventes pasos, errores ni datos. "
    "steps: pasos numerables, uno por acción del usuario. expected: qué esperaba el usuario. "
    "actual: qué pasó (incluí el mensaje de error si hay). Si un dato no está, dejalo vacío. "
    "Respondé solo el JSON."
)


def _short(value: Any, limit: int = 200) -> str:
    if isinstance(value, str):
        text = value
    elif isinstance(value, dict):
        when = value.get("t") or value.get("time") or value.get("ts") or value.get("at")
        what = (
            value.get("message")
            or value.get("msg")
            or value.get("action")
            or value.get("text")
            or value.get("event")
        )
        kind = value.get("type") or value.get("kind") or value.get("category") or value.get("code")
        if what:
            text = " ".join(str(p) for p in (when, kind, what) if p)
        else:
            text = json.dumps(value, ensure_ascii=False, default=str)
    else:
        text = json.dumps(value, ensure_ascii=False, default=str)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _steps_from_text(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        line = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", line).strip()
        if line:
            out.append(line)
    if len(out) == 1 and ". " in out[0]:  # one paragraph: split in sentences
        out = [s.strip() for s in re.split(r"(?<=[.!?])\s+", out[0]) if s.strip()]
    return out[:12]


def render_markdown(
    req: dict[str, Any], draft: dict[str, Any] | None = None, *, model: str | None = None
) -> str:
    steps_text = str(req.get("steps_text") or "")
    errors = list(req.get("errors") or [])[-MAX_ERRORS:]
    crumbs = list(req.get("breadcrumbs") or [])[-MAX_BREADCRUMBS:]
    env = req.get("env") or {}
    draft = draft or {}
    title = (
        str(req.get("title") or "").strip()
        or str(draft.get("title") or "").strip()
        or (f"Error: {_short(errors[-1], 100)}" if errors else "")
        or (_steps_from_text(steps_text)[:1] or ["Error en Studio"])[0][:120]
    )
    steps = [s for s in (draft.get("steps") or []) if str(s).strip()] or _steps_from_text(
        steps_text
    )
    expected = str(draft.get("expected") or "").strip() or TODO_EXPECTED
    actual = str(draft.get("actual") or "").strip()
    if not actual:
        actual = f"Apareció el error: {_short(errors[-1])}" if errors else TODO_ACTUAL
    lines = [f"# {title}", "", H_STEPS]
    lines += [f"{i}. {s}" for i, s in enumerate(steps, 1)] or ["1. (completá los pasos)"]
    lines += ["", H_EXPECTED, expected, "", H_ACTUAL, actual]
    notes = str(draft.get("notes") or "").strip()
    if notes:
        lines += ["", "## Notas", notes]
    if errors:
        lines += ["", "## Errores registrados", *[f"- `{_short(e, 300)}`" for e in errors]]
    if crumbs:
        lines += ["", "## Últimas acciones", *[f"- {_short(c)}" for c in crumbs]]
    if env:
        lines += ["", "## Entorno", *[f"- {k}: {_short(v, 120)}" for k, v in env.items()]]
    footer = (
        f"_Redactado localmente con {model} (sin enviar datos a internet)._"
        if model
        else "_Plantilla automática (sin modelo local)._"
    )
    lines += ["", footer]
    return "\n".join(lines) + "\n"


def _user_prompt(req: dict[str, Any]) -> str:
    parts = [
        f"Título que puso el usuario: {req.get('title') or '(ninguno)'}",
        f"Lo que contó el usuario:\n{str(req.get('steps_text') or '(nada)')[:4000]}",
    ]
    errors = list(req.get("errors") or [])[-MAX_ERRORS:]
    if errors:
        parts.append("Errores registrados:\n" + "\n".join(f"- {_short(e, 300)}" for e in errors))
    crumbs = list(req.get("breadcrumbs") or [])[-MAX_BREADCRUMBS:]
    if crumbs:
        parts.append("Últimas acciones:\n" + "\n".join(f"- {_short(c)}" for c in crumbs))
    return "\n\n".join(parts)


async def draft_report(
    req: dict[str, Any],
    client: OllamaClient | None,
    model: str,
    *,
    temperature: float = 0.2,
    keep_alive: str | int = "5m",
    num_ctx: int = 8192,
    before_llm: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """{markdown_es, source: "llm" | "template", model?, warning?}."""
    if client is not None:
        try:
            installed = await client.installed_models()
            if model_in(model, installed):
                if before_llm is not None:
                    before_llm()
                result = await client.chat(
                    model,
                    [
                        {"role": "system", "content": SYSTEM_ES},
                        {"role": "user", "content": _user_prompt(req)},
                    ],
                    format=DRAFT_SCHEMA,
                    temperature=temperature,
                    num_ctx=num_ctx,
                    keep_alive=keep_alive,
                    think=False,
                )
                draft = json.loads(result.content)
                if isinstance(draft, dict):
                    return {
                        "markdown_es": render_markdown(req, draft, model=model),
                        "source": "llm",
                        "model": model,
                    }
            warning = f"model_missing:{model}"
        except (OllamaError, ValueError) as exc:
            warning = f"llm_failed: {exc}"[:300]
    else:
        warning = "no_client"
    return {"markdown_es": render_markdown(req), "source": "template", "warning": warning}
