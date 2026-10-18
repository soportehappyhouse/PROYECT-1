"""Agent evaluation: dataset commands -> plans -> metrics per model (storage/run/agent-eval.json).

Per model (docs/trabajo/sprint3-contratos.md)::

    {valid_json_rate, schema_valid_rate, exact_ops_rate, semantic_rate, semantic_rate_ops_only,
     p50_latency_ms, failures}

- valid_json_rate: the final answer parsed as JSON (deterministic route counts as valid);
- schema_valid_rate: the final plan passed the EditPlan schema (not the "rephrase" fallback);
- exact_ops_rate: same ops with the same arguments (``confirm``/``note_es`` ignored);
- semantic_rate: same op sequence AND the key arguments of each op match (``KEY_ARGS``: preset,
  target, template, time, text, clip reference…). A questions-only expected plan matches a
  questions-only answer. Criterion 4 of the plan: ≥ 90 % on golden with the default model;
- semantic_rate_ops_only: the same, only over the examples whose expected plan HAS ops (``n_ops``
  of them): a model that answers only questions cannot reach it by asking.

The same pipeline as POST /agent/plan runs (router first) unless ``use_router`` is false; the
evaluated command is excluded from the few-shot examples. Also usable offline for a future LoRA.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import statistics
import threading
import unicodedata
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .ollama_client import OllamaError
from .planner import (
    DATASET_DIR,
    Example,
    PlannerUnavailableError,
    PlanOutcome,
    fallback_plan,
    load_examples,
)

EVAL_FILE = "agent-eval.json"
MAX_FAILURES = 50
TIME_TOLERANCE_S = 0.5

# op -> arguments that must match for the plan to be "semantically" right.
KEY_ARGS: dict[str, tuple[str, ...]] = {
    "cut_silences": ("fillers", "clip"),
    "detect_scenes": ("split",),
    "split": ("clip", "t"),
    "trim": ("clip", "in", "out"),
    "delete_clip": ("clip",),
    "set_speed": ("clip", "speed"),
    "set_volume": ("clip", "volume_db"),
    "move_clip": ("clip", "t"),
    "add_text": ("text", "t"),
    "add_motion": ("template", "t"),
    "add_captions": ("animated", "style"),
    "transcribe": (),
    "tts": ("text", "t"),
    "voice_effect": ("clip", "effect"),
    "denoise": ("clip",),
    "add_audio": ("t",),
    "remove_background": ("clip", "background.type"),
    "reframe": ("target",),
    "set_canvas": ("preset",),
    "set_publish": ("for_social", "ai_label"),
    "export": ("preset",),
    "report_bug": (),
    "face_swap": ("clip", "person"),
}
BOOL_DEFAULT_FALSE = {"fillers", "split", "animated", "ai_label"}
IGNORED = ("confirm", "note_es")

PlanFn = Callable[[Example], Awaitable[Any]]  # -> planner.PlanOutcome
StepFn = Callable[[float, str], None]
# (done, total, stage_es): commands finished over all models and «qwen3:8b · 17/20».
ItemsFn = Callable[[int, int, str], None]

# Sprint 5: examples of the quick «Evaluar modelos» (AGENT_EVAL_QUICK_N in packages/shared).
QUICK_N = 20
# How often the cancel watcher checks the event while a plan is being generated.
CANCEL_POLL_S = 0.1


class EvalCanceled(Exception):  # noqa: N818
    """The evaluation was canceled (``cancel`` event set): Ollama's request was closed."""


def dataset_ids(kind: str = "golden", directory: Path | None = None) -> dict[str, str]:
    """command -> row ``id`` of the dataset files (examples without id keep the file order)."""
    names = ["golden", "train"] if kind == "all" else [kind]
    out: dict[str, str] = {}
    for name in names:
        path = (directory or DATASET_DIR) / f"{name}.jsonl"
        if not path.is_file():
            continue
        for n, line in enumerate(path.read_text("utf-8").splitlines()):
            try:
                row = json.loads(line) if line.strip() else None
            except ValueError:
                continue
            if isinstance(row, dict) and "command" in row:
                out.setdefault(str(row["command"]), str(row.get("id") or f"{name}-{n:05d}"))
    return out


def select_quick(
    examples: list[Example], n: int = QUICK_N, ids: dict[str, str] | None = None
) -> list[Example]:
    """Deterministic quick subset: sort by id, then round-robin over the first op of each
    expected plan (questions-only plans count as their own group) until ``n`` examples."""
    ids = ids or {}
    ordered = sorted(enumerate(examples), key=lambda p: (ids.get(p[1].command, ""), f"{p[0]:05d}"))
    groups: dict[str, list[Example]] = {}
    for _, ex in ordered:
        first = ops_of(ex.plan)
        key = str(first[0].get("op")) if first else "(pregunta)"
        groups.setdefault(key, []).append(ex)
    picked: list[Example] = []
    depth = 0
    while len(picked) < min(n, len(examples)):
        added = False
        for items in groups.values():
            if depth < len(items) and len(picked) < n:
                picked.append(items[depth])
                added = True
        if not added:
            break
        depth += 1
    return picked


async def _plan_cancellable(plan_fn: PlanFn, ex: Example, cancel: threading.Event | None) -> Any:
    """Run ``plan_fn(ex)`` as an asyncio task; when ``cancel`` is set, cancel it (httpx closes
    the connection and Ollama stops generating) and raise EvalCanceled."""
    if cancel is None:
        return await plan_fn(ex)
    if cancel.is_set():
        raise EvalCanceled
    plan = asyncio.ensure_future(plan_fn(ex))

    async def watch() -> None:
        while not cancel.is_set():
            await asyncio.sleep(CANCEL_POLL_S)

    watcher = asyncio.ensure_future(watch())
    try:
        await asyncio.wait({plan, watcher}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        watcher.cancel()
    if not plan.done():
        plan.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await plan
        raise EvalCanceled
    return plan.result()


def eval_path(storage_root: Path) -> Path:
    return storage_root / "run" / EVAL_FILE


def read_last(storage_root: Path) -> dict[str, Any] | None:
    path = eval_path(storage_root)
    try:
        return json.loads(path.read_text("utf-8")) if path.is_file() else None
    except (OSError, ValueError):
        return None


def load_dataset(kind: str = "golden", directory: Path | None = None) -> list[Example]:
    if kind == "all":
        return load_examples("golden", directory) + load_examples("train", directory)
    if kind not in ("golden", "train"):
        raise ValueError(f"dataset desconocido: {kind} (golden | all)")
    return load_examples(kind, directory)


# ------------------------------------------------------------------------------ comparison


def _norm_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value).lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _strip(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip(v) for k, v in sorted(value.items()) if k not in IGNORED}
    if isinstance(value, list):
        return [_strip(v) for v in value]
    return value


def ops_of(plan: dict[str, Any] | None) -> list[dict[str, Any]]:
    ops = (plan or {}).get("ops") or []
    return [o for o in ops if isinstance(o, dict)]


def exact_match(expected: dict[str, Any], got: dict[str, Any] | None) -> bool:
    if got is None:
        return False
    same_ops = _strip(ops_of(expected)) == _strip(ops_of(got))
    return same_ops and bool(expected.get("questions")) == bool(got.get("questions"))


def _clip_match(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    if isinstance(a, str) or isinstance(b, str):  # follow: "face"
        return a == b
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if a.get("id") and b.get("id"):
        return a["id"] == b["id"]
    if a.get("name") and b.get("name"):
        na, nb = _norm_text(a["name"]), _norm_text(b["name"])
        if na and nb and (na in nb or nb in na):
            return True
    keys = ("index", "track", "at")
    pa = {k: a.get(k) for k in keys if a.get(k) is not None}
    pb = {k: b.get(k) for k in keys if b.get(k) is not None}
    if pa and pa == pb:
        return True
    return _strip(a) == _strip(b)


def _time_match(a: Any, b: Any) -> bool:
    if isinstance(a, int | float) and isinstance(b, int | float):
        return abs(float(a) - float(b)) <= TIME_TOLERANCE_S
    if isinstance(a, dict) and isinstance(b, dict) and "after_clip" in a and "after_clip" in b:
        return _clip_match(a["after_clip"], b["after_clip"])
    return _strip(a) == _strip(b)


def _get(op: dict[str, Any], path: str) -> Any:
    cur: Any = op
    for part in path.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur


def arg_match(name: str, key: str, a: Any, b: Any) -> bool:
    if key in BOOL_DEFAULT_FALSE:
        return bool(a) == bool(b)
    if key in ("clip", "follow"):
        return _clip_match(a, b)
    if key in ("t", "in", "out"):
        return _time_match(a, b)
    if key == "text":
        return _norm_text(a) == _norm_text(b)
    if key == "speed" and isinstance(a, int | float) and isinstance(b, int | float):
        return abs(float(a) - float(b)) < 1e-6
    if key == "style" and name == "add_captions" and (a is None or b is None):
        return True  # style left to the default is not a semantic error
    return _strip(a) == _strip(b)


def semantic_match(expected: dict[str, Any], got: dict[str, Any] | None) -> tuple[bool, str]:
    if got is None:
        return False, "sin plan"
    exp_ops, got_ops = ops_of(expected), ops_of(got)
    if not exp_ops:
        ok = not got_ops and bool(got.get("questions"))
        return ok, "" if ok else "se esperaba solo una pregunta"
    seq_e = [o.get("op") for o in exp_ops]
    seq_g = [o.get("op") for o in got_ops]
    if seq_e != seq_g:
        return False, f"ops {seq_g} != {seq_e}"
    for i, (e, g) in enumerate(zip(exp_ops, got_ops, strict=True)):
        name = str(e.get("op"))
        for key in KEY_ARGS.get(name, ()):
            if not arg_match(name, key, _get(e, key), _get(g, key)):
                return False, f"ops[{i}].{key}: {_get(g, key)!r} != {_get(e, key)!r}"
    return True, ""


# ------------------------------------------------------------------------------ run


def _rate(n: int, total: int) -> float:
    return round(n / total, 4) if total else 0.0


async def evaluate_model(
    model: str,
    examples: list[Example],
    plan_fn: PlanFn,
    step: StepFn | None = None,
    *,
    cancel: threading.Event | None = None,
    on_item: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    n = len(examples)
    valid_json = schema_ok = exact = semantic = 0
    n_ops = semantic_ops = 0
    latencies: list[int] = []
    attempts: list[int] = []
    routes = {"deterministic": 0, "llm": 0}
    failures: list[dict[str, Any]] = []
    for i, ex in enumerate(examples):
        if cancel is not None and cancel.is_set():
            raise EvalCanceled
        if step:
            step(i / max(n, 1), f"{model}: {i + 1}/{n}")
        if on_item:
            on_item(i, n)
        try:
            out = await _plan_cancellable(plan_fn, ex, cancel)
        except PlannerUnavailableError as exc:
            return {"model": model, "n": n, "error": str(exc), "available": False}
        except OllamaError as exc:  # one bad answer of Ollama is a failed example, not the run
            out = PlanOutcome(
                plan=fallback_plan(),
                route="llm",
                model=model,
                valid_json=False,
                schema_valid=False,
                errors=[str(exc)[:300]],
            )
        routes[out.route] = routes.get(out.route, 0) + 1
        latencies.append(out.latency_ms)
        attempts.append(out.attempts)
        valid_json += int(out.valid_json)
        schema_ok += int(out.schema_valid)
        is_exact = out.schema_valid and exact_match(ex.plan, out.plan)
        is_sem, reason = (
            semantic_match(ex.plan, out.plan)
            if out.schema_valid
            else (
                False,
                "plan inválido: " + "; ".join(out.errors[:2]),
            )
        )
        exact += int(is_exact)
        semantic += int(is_sem)
        if ops_of(ex.plan):
            n_ops += 1
            semantic_ops += int(is_sem)
        if not is_sem and len(failures) < MAX_FAILURES:
            failures.append(
                {
                    "command": ex.command,
                    "reason": reason,
                    "expected_ops": [o.get("op") for o in ops_of(ex.plan)],
                    "got": out.plan,
                    "route": out.route,
                    "attempts": out.attempts,
                }
            )
    return {
        "model": model,
        "available": True,
        "n": n,
        "valid_json_rate": _rate(valid_json, n),
        "schema_valid_rate": _rate(schema_ok, n),
        "exact_ops_rate": _rate(exact, n),
        "semantic_rate": _rate(semantic, n),
        "semantic_rate_ops_only": _rate(semantic_ops, n_ops),
        "n_ops": n_ops,
        "p50_latency_ms": int(statistics.median(latencies)) if latencies else 0,
        "mean_attempts": round(statistics.fmean(attempts), 3) if attempts else 0.0,
        "routes": routes,
        "failures": failures,
    }


async def evaluate(
    models: list[str],
    examples: list[Example],
    plan_fn_for: Callable[[str], PlanFn],
    *,
    dataset: str = "golden",
    step: StepFn | None = None,
    cancel: threading.Event | None = None,
    items: ItemsFn | None = None,
    mode: str = "full",
) -> dict[str, Any]:
    """Every model over ``examples``. ``items(done, total, model)`` reports the global count
    before each command; ``cancel`` stops between commands and during a generation."""
    results: dict[str, Any] = {}
    total = len(models) * len(examples)
    for idx, model in enumerate(models):

        def sub(p: float, msg: str, idx: int = idx) -> None:
            if step:
                step((idx + p) / max(len(models), 1), msg)

        def item(i: int, n: int, idx: int = idx, model: str = model) -> None:
            if items:
                items(idx * n + i, total, f"{model} · {i}/{n}")

        results[model] = await evaluate_model(
            model, examples, plan_fn_for(model), sub, cancel=cancel, on_item=item
        )
        if items:
            n = len(examples)
            items((idx + 1) * n, total, f"{model} · {n}/{n}")
    return {
        "generated": datetime.now(UTC).isoformat(timespec="seconds"),
        "dataset": dataset,
        "mode": mode,
        "canceled": False,
        "n": len(examples),
        "criterion_semantic_rate": 0.9,
        "models": results,
    }


def write_result(storage_root: Path, result: dict[str, Any]) -> Path:
    path = eval_path(storage_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(EVAL_FILE + ".tmp")
    tmp.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(path)
    return path
