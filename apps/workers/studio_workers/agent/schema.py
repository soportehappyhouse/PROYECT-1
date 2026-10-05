"""EditPlan JSON Schema (exported from packages/shared/src/agent.ts) and validation helpers.

``editplan.schema.json`` is written by ``pnpm --filter @studio/shared export-schemas``: the same
schema the api validates with zod. Here it serves two purposes: ``format`` for Ollama structured
outputs and the jsonschema validation of what the model answered (Spanish error lines fed back to
the model on a retry). zod ``.refine`` checks are not representable in JSON Schema, so the ones
that matter are repeated in ``extra_checks``.
"""

from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

SCHEMA_PATH = Path(__file__).with_name("editplan.schema.json")
ALWAYS_CONFIRM_OPS = ("delete_clip", "export")
MAX_OPS = 20


@lru_cache
def load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text("utf-8"))


@lru_cache
def _validator() -> Draft202012Validator:
    schema = load_schema()
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def op_variants() -> list[dict[str, Any]]:
    items = load_schema()["properties"]["ops"]["items"]
    return list(items.get("oneOf") or items.get("anyOf") or [])


@lru_cache
def op_names() -> tuple[str, ...]:
    return tuple(v["properties"]["op"]["const"] for v in op_variants())


def ollama_format() -> dict[str, Any]:
    """The schema for Ollama's ``format`` (metadata keys removed; $defs/$ref kept)."""
    schema = copy.deepcopy(load_schema())
    for key in ("$schema", "$id", "title"):
        schema.pop(key, None)
    return schema


def _path(err: ValidationError) -> str:
    out = ""
    for p in err.absolute_path:
        out += f"[{p}]" if isinstance(p, int) else (f".{p}" if out else str(p))
    return out or "(raíz)"


def _op_error(err: ValidationError, instance: Any) -> str | None:
    """oneOf over ops: report the errors of the variant whose `op` matches (much clearer)."""
    if err.validator != "oneOf" or not isinstance(instance, dict):
        return None
    name = instance.get("op")
    if name not in op_names():
        return f"{_path(err)}.op: operación desconocida «{name}»; válidas: {', '.join(op_names())}"
    for sub in err.context or ():
        # sub.relative_schema_path starts with the index of the oneOf variant
        idx = sub.relative_schema_path[0] if sub.relative_schema_path else None
        if isinstance(idx, int) and op_variants()[idx]["properties"]["op"]["const"] == name:
            return f"{_path(sub)}: {sub.message}"
    return None


def validate_plan(plan: Any) -> list[str]:
    """Spanish-ish error lines ("ops[1].speed: 20 is greater than the maximum of 16")."""
    errors: list[str] = []
    for err in sorted(_validator().iter_errors(plan), key=lambda e: list(e.absolute_path)):
        detail = _op_error(err, err.instance)
        errors.append(detail or f"{_path(err)}: {err.message}")
    if not errors:
        errors.extend(extra_checks(plan))
    return errors[:12]


def extra_checks(plan: dict[str, Any]) -> list[str]:
    if not plan.get("ops") and not plan.get("questions"):
        return ["ops: el plan no tiene operaciones ni preguntas"]
    return []


def is_valid(plan: Any) -> bool:
    return not validate_plan(plan)
