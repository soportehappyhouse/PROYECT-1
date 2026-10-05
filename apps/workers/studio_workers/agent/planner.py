"""Command -> EditPlan: deterministic router first, then the local LLM (Ollama) with the schema.

LLM path (docs/trabajo/sprint3-contratos.md):

1. messages = system prompt (``prompts/system_es.md``) + the fixed pairs of
   ``prompts/fewshot_es.jsonl`` (summary + command -> plan) + 3 similar pairs (command -> plan, by
   word overlap from ``train.jsonl``; ``golden.jsonl`` only when there is no train set; never the
   command being evaluated) + the compact project summary and the command;
2. ``/api/chat`` with ``format`` = the exported EditPlan JSON Schema (structured outputs),
   temperature 0.2, ``num_ctx`` 8192, ``keep_alive`` 5 min, ``think`` off;
3. validation with jsonschema; on errors the model gets them back (≤ 3 attempts in total);
4. ids the model wrote that are NOT in the summary are removed (never invented ids): a reference
   left without any other field turns its op into a question for the user.

Before the call the GPU budget unloads the resident Whisper/vision model when free VRAM is under
5.5 GB (``GpuBudget.make_room``); Ollama manages its own VRAM.
"""

from __future__ import annotations

import copy
import json
import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import summary as summ
from .ollama_client import (
    OllamaClient,
    OllamaError,
    OllamaModelMissingError,
    OllamaUnavailableError,
    model_in,
    strip_thinking,
)
from .router import route
from .schema import ALWAYS_CONFIRM_OPS, ollama_format, op_names, validate_plan

AGENT_DIR = Path(__file__).resolve().parent
DATASET_DIR = AGENT_DIR / "dataset"
PROMPT_PATH = AGENT_DIR / "prompts" / "system_es.md"
FEWSHOT_PATH = AGENT_DIR / "prompts" / "fewshot_es.jsonl"
MAX_ATTEMPTS = 3
FEW_SHOT = 3
DEFAULT_TEMPERATURE = 0.2
LLM_VRAM_MB = 5500  # free VRAM below this -> unload the resident Whisper/vision model first

FALLBACK_SYSTEM = (
    "Sos el asistente de edición de Studio, un editor de video local. Convertís el pedido del "
    "usuario en un EditPlan JSON y respondés SOLO el JSON. Nunca inventes ids, tiempos ni textos: "
    "si falta un dato, dejá ops vacío o con lo que está claro y preguntá en questions (voseo). "
    "delete_clip y export siempre con confirm:true."
)
RETRY_TEMPLATE = (
    "Tu respuesta no es un EditPlan válido. Errores:\n{errors}\n"
    "Corregila y respondé SOLO el JSON completo del EditPlan."
)
FALLBACK_QUESTION = (
    "No pude armar un plan para ese pedido. ¿Lo podés decir de otra forma o con más detalle?"
)

BeforeLlm = Callable[[], list[str]]


class PlannerUnavailableError(RuntimeError):
    """Ollama is down or the model is missing (the router -> PACK_REQUIRED agent-llm)."""

    def __init__(self, cause: OllamaError) -> None:
        self.cause = cause
        super().__init__(str(cause))


# ------------------------------------------------------------------------------- dataset


@dataclass(frozen=True)
class Example:
    command: str
    project_summary: str
    plan: dict[str, Any]
    tags: tuple[str, ...] = ()


def load_examples(
    name: str, directory: Path | None = None, *, path: Path | None = None
) -> list[Example]:
    """``dataset/<name>.jsonl`` rows ``{command, project_summary, plan}`` ([] when missing)."""
    path = path or (directory or DATASET_DIR) / f"{name}.jsonl"
    if not path.is_file():
        return []
    out: list[Example] = []
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or not isinstance(row.get("plan"), dict):
            continue
        tags = row.get("tags") or row.get("tag") or ()
        out.append(
            Example(
                command=str(row.get("command", "")),
                project_summary=summ.as_text(row.get("project_summary", "")),
                plan=row["plan"],
                tags=tuple(tags) if isinstance(tags, list) else (str(tags),),
            )
        )
    return out


@lru_cache
def few_shot_pool() -> tuple[Example, ...]:
    return tuple(load_examples("train") or load_examples("golden"))


@lru_cache
def fixed_examples() -> tuple[Example, ...]:
    """prompts/fewshot_es.jsonl: short curated pairs always pasted (with their summaries)."""
    return tuple(load_examples("fewshot_es", path=FEWSHOT_PATH))


def _words(text: str) -> set[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return {w for w in re.findall(r"[a-z0-9:]+", text) if len(w) > 2}


def pick_examples(
    command: str, pool: tuple[Example, ...] | list[Example], k: int = FEW_SHOT, exclude: str = ""
) -> list[Example]:
    want = _words(command)
    skip = exclude.strip().lower()
    scored = []
    for i, ex in enumerate(pool):
        if skip and ex.command.strip().lower() == skip:
            continue
        have = _words(ex.command)
        score = len(want & have) / (len(want | have) or 1)
        scored.append((score, -i, ex))
    scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
    return [ex for score, _i, ex in scored[:k] if score > 0]


# ------------------------------------------------------------------------------- prompt


@lru_cache
def system_prompt() -> str:
    try:
        text = PROMPT_PATH.read_text("utf-8").strip()
    except OSError:
        text = ""
    text = text or FALLBACK_SYSTEM
    missing = [n for n in op_names() if n not in text]
    if missing:  # the prompt must name every op the schema allows
        text += "\n\nOperaciones válidas (campo op): " + ", ".join(op_names()) + "."
    return text


def user_message(command: str, project_summary: str) -> str:
    body = summ.compact(project_summary) or "(proyecto vacío o sin resumen)"
    return f"Resumen del proyecto:\n{body}\n\nPedido: {command.strip()}"


def build_messages(
    command: str,
    project_summary: str,
    examples: list[Example],
    fixed: tuple[Example, ...] | list[Example] = (),
) -> list[dict[str, str]]:
    """system + fixed pairs (summary + command) + similar pairs (command only) + the request."""
    messages = [{"role": "system", "content": system_prompt()}]
    for ex in fixed:
        messages.append({"role": "user", "content": user_message(ex.command, ex.project_summary)})
        messages.append({"role": "assistant", "content": json.dumps(ex.plan, ensure_ascii=False)})
    for ex in examples:
        messages.append({"role": "user", "content": f"Pedido: {ex.command}"})
        messages.append({"role": "assistant", "content": json.dumps(ex.plan, ensure_ascii=False)})
    messages.append({"role": "user", "content": user_message(command, project_summary)})
    return messages


# ------------------------------------------------------------------------- id enforcement


def _check_ref(ref: dict[str, Any], summary: str, invented: list[str]) -> bool:
    """Remove an invented id; False when nothing is left to locate the clip/asset."""
    ident = ref.get("id")
    if isinstance(ident, str) and not summ.id_known(ident, summary):
        invented.append(ident)
        ref.pop("id")
    at = ref.get("at")
    if (
        isinstance(at, dict)
        and isinstance(at.get("after_clip"), dict)
        and not _check_ref(at["after_clip"], summary, invented)
    ):
        ref.pop("at")
    return bool(ref)


def _check_time(value: Any, summary: str, invented: list[str]) -> bool:
    if isinstance(value, dict) and isinstance(value.get("after_clip"), dict):
        return _check_ref(value["after_clip"], summary, invented)
    return True


def enforce_known_ids(
    plan: dict[str, Any], project_summary: str
) -> tuple[dict[str, Any], list[str]]:
    """Every ClipRef/AssetRef id must exist in the summary (see module doc)."""
    plan = copy.deepcopy(plan)
    warnings: list[str] = []
    kept: list[dict[str, Any]] = []
    questions: list[str] = list(plan.get("questions") or [])
    for op in plan.get("ops") or []:
        invented: list[str] = []
        lost = False
        for key in ("clip", "follow"):
            ref = op.get(key)
            if isinstance(ref, dict) and not _check_ref(ref, project_summary, invented):
                lost = True
        for key in ("t", "in", "out"):
            if key in op and not _check_time(op[key], project_summary, invented):
                lost = True
        asset = op.get("asset")
        if isinstance(asset, dict) and not _check_ref(asset, project_summary, invented):
            if op.get("query"):
                op.pop("asset")
            else:
                lost = True
        for ident in invented:
            warnings.append(f"invented_id:{ident}")
        if lost:
            name = invented[0] if invented else "?"
            questions.append(
                f"No encontré «{name}» en el proyecto. ¿A qué clip o archivo te referís "
                f"para «{op.get('op')}»?"
            )
            continue
        if op.get("op") in ALWAYS_CONFIRM_OPS:
            op["confirm"] = True
        kept.append(op)
    plan["ops"] = kept
    if questions:
        plan["questions"] = questions[:5]
    return plan, warnings


# ------------------------------------------------------------------------------- planner


@dataclass
class PlanOutcome:
    plan: dict[str, Any]
    route: str  # deterministic | llm
    model: str | None = None
    latency_ms: int = 0
    attempts: int = 0
    warnings: list[str] = field(default_factory=list)
    valid_json: bool = True
    schema_valid: bool = True
    errors: list[str] = field(default_factory=list)

    def response(self) -> dict[str, Any]:
        return {
            "plan": self.plan,
            "model": self.model,
            "latency_ms": self.latency_ms,
            "attempts": self.attempts,
            "warnings": self.warnings,
            "route": self.route,
        }


def fallback_plan() -> dict[str, Any]:
    return {
        "version": 1,
        "summary_es": "No pude armar un plan válido.",
        "ops": [],
        "questions": [FALLBACK_QUESTION],
    }


def parse_plan(content: str) -> tuple[dict[str, Any] | None, list[str]]:
    text = strip_thinking(content)
    try:
        data = json.loads(text)
    except ValueError as exc:
        return None, [f"(raíz): no es JSON válido ({exc.msg}, posición {exc.pos})"]
    if not isinstance(data, dict):
        return None, ["(raíz): se esperaba un objeto JSON"]
    return data, validate_plan(data)


class Planner:
    def __init__(
        self,
        client: OllamaClient,
        *,
        model: str,
        temperature: float = DEFAULT_TEMPERATURE,
        num_ctx: int = 8192,
        keep_alive: str | int = "5m",
        before_llm: BeforeLlm | None = None,
        examples: tuple[Example, ...] | list[Example] | None = None,
        fixed: tuple[Example, ...] | list[Example] | None = None,
        max_attempts: int = MAX_ATTEMPTS,
    ) -> None:
        self.client = client
        self.model = model
        self.temperature = temperature
        self.num_ctx = num_ctx
        self.keep_alive = keep_alive
        self.before_llm = before_llm
        self.examples = few_shot_pool() if examples is None else examples
        self.fixed = fixed_examples() if fixed is None else fixed
        self.max_attempts = max_attempts

    async def ensure_ready(self) -> None:
        try:
            installed = await self.client.installed_models()
        except OllamaError as exc:
            raise PlannerUnavailableError(exc) from exc
        if not model_in(self.model, installed):
            raise PlannerUnavailableError(OllamaModelMissingError(self.model))

    async def plan(
        self,
        command: str,
        project_summary: Any = "",
        *,
        use_router: bool = True,
        exclude_command: str = "",
    ) -> PlanOutcome:
        summary = summ.as_text(project_summary)
        start = time.perf_counter()
        if use_router:
            plan = route(command, summary)
            if plan is not None:
                return PlanOutcome(
                    plan=plan,
                    route="deterministic",
                    latency_ms=int((time.perf_counter() - start) * 1000),
                )
        await self.ensure_ready()
        warnings = list(self.before_llm() if self.before_llm else [])
        examples = pick_examples(command, self.examples, exclude=exclude_command)
        skip = exclude_command.strip().lower()
        fixed = [ex for ex in self.fixed if not skip or ex.command.strip().lower() != skip]
        messages = build_messages(command, summary, examples, fixed)
        errors: list[str] = []
        valid_json = False
        attempts = 0
        for attempt in range(1, self.max_attempts + 1):
            attempts = attempt
            try:
                result = await self.client.chat(
                    self.model,
                    messages,
                    format=ollama_format(),
                    temperature=self.temperature,
                    num_ctx=self.num_ctx,
                    keep_alive=self.keep_alive,
                    think=False,
                )
            except (OllamaUnavailableError, OllamaModelMissingError) as exc:
                raise PlannerUnavailableError(exc) from exc
            data, errors = parse_plan(result.content)
            valid_json = data is not None
            if data is not None and not errors:
                plan, id_warnings = enforce_known_ids(data, summary)
                warnings.extend(id_warnings)
                errors = validate_plan(plan)
                if not errors:
                    if attempt > 1:
                        warnings.append(f"llm_retries:{attempt - 1}")
                    return PlanOutcome(
                        plan=plan,
                        route="llm",
                        model=self.model,
                        latency_ms=int((time.perf_counter() - start) * 1000),
                        attempts=attempt,
                        warnings=warnings,
                    )
            messages = [
                *messages,
                {"role": "assistant", "content": result.content[:4000]},
                {
                    "role": "user",
                    "content": RETRY_TEMPLATE.format(
                        errors="\n".join(f"- {e}" for e in errors[:8])
                    ),
                },
            ]
        warnings.append("llm_invalid_plan")
        warnings.extend(errors[:3])
        return PlanOutcome(
            plan=fallback_plan(),
            route="llm",
            model=self.model,
            latency_ms=int((time.perf_counter() - start) * 1000),
            attempts=attempts,
            warnings=warnings,
            valid_json=valid_json,
            schema_valid=False,
            errors=errors,
        )
