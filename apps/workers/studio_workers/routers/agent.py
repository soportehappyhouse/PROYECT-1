"""Sprint 3 local edit agent (docs/trabajo/sprint3-contratos.md, "Workers")."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .. import services
from ..agent.bugreport import draft_report
from ..agent.eval import (
    QUICK_N,
    EvalCanceled,
    dataset_ids,
    evaluate,
    load_dataset,
    read_last,
    select_quick,
    write_result,
)
from ..agent.ollama_client import (
    ALT_MODEL,
    DEFAULT_MODEL,
    OllamaError,
    OllamaRemoteRefusedError,
    model_in,
    pack_required_detail,
)
from ..agent.planner import LLM_VRAM_MB, Example, Planner, PlannerUnavailableError
from ..config import get_settings
from ..errors import NotFoundError
from ..packs import AGENT_PACK_ID, PackRequiredError
from ..tasks import Task, TaskCanceled, cancel_or_404, task_not_found

router = APIRouter(prefix="/agent", tags=["agent"])


class LlmSettings(BaseModel):
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)


class PlanRequest(BaseModel):
    command: str = Field(min_length=1, max_length=2000)
    # The api sends the dataset JSON shape (services/agent/summary.ts: {canvas, cursor_s, tracks,
    # scenes?, assets?, transcript_excerpt?}); summary.as_text renders it for the prompt. A plain
    # string is still accepted (tools, old api).
    project_summary: dict[str, Any] | str | list[Any] = ""
    settings: LlmSettings = Field(default_factory=LlmSettings)


class EvalRequest(BaseModel):
    models: list[str] | None = None
    dataset: Literal["golden", "all"] = "golden"
    use_router: bool = True
    limit: int | None = Field(default=None, ge=1)
    # Sprint 5: quick = QUICK_N deterministic examples (select_quick), full = the whole dataset.
    mode: Literal["quick", "full"] = "quick"


class BugreportRequest(BaseModel):
    title: str | None = None
    steps_text: str = ""
    breadcrumbs: list[Any] = Field(default_factory=list)
    errors: list[Any] = Field(default_factory=list)
    env: dict[str, Any] = Field(default_factory=dict)
    model: str | None = None  # default AGENT_MODEL


def _release_gpu() -> list[str]:
    """GPU coordination: unload Whisper/vision before Ollama when free VRAM < 5.5 GB."""
    released = services.gpu_budget().make_room(LLM_VRAM_MB)
    return [f"gpu_released:{released}"] if released else []


def make_planner(model: str | None = None, temperature: float | None = None) -> Planner:
    settings = get_settings()
    return Planner(
        services.ollama_client(),
        model=model or settings.agent_model,
        temperature=settings.agent_temperature if temperature is None else temperature,
        num_ctx=settings.agent_num_ctx,
        keep_alive=settings.agent_keep_alive,
        before_llm=_release_gpu,
    )


@router.get("/status")
async def status() -> dict[str, Any]:
    """{ollama, model, models_installed, ready, gpu_mode} (+ version, defaults, hint_es, loaded:
    the model is already in memory per /api/ps, so the web knows the first call has to load it)."""
    settings = get_settings()
    client = services.ollama_client()
    model = settings.agent_model
    loaded = False
    try:
        installed = await client.installed_models(timeout=2.0)
        version: str | None = await client.version(timeout=2.0)
        up = True
    except OllamaError as exc:
        installed, version, up = [], None, False
        hint: str | None = str(exc)
        refused = isinstance(exc, OllamaRemoteRefusedError)
        if not refused:
            hint = pack_required_detail(model, url=settings.ollama_url, version=None)
    ready = up and model_in(model, installed)
    if up:
        hint = (
            None if ready else pack_required_detail(model, url=settings.ollama_url, version=version)
        )
        try:
            loaded = model_in(model, await client.loaded_models(timeout=2.0))
        except OllamaError:
            loaded = False
    gpu = await asyncio.to_thread(services.gpu_budget().status)
    return {
        "ollama": up,
        "model": model,
        "models_installed": installed,
        "ready": ready,
        "gpu_mode": gpu.get("mode"),
        # additive
        "loaded": loaded,
        "keep_alive": settings.agent_keep_alive,
        "num_ctx": settings.agent_num_ctx,
        "ollama_url": settings.ollama_url,
        "ollama_version": version,
        "default_model": DEFAULT_MODEL,
        "alt_models": [ALT_MODEL],
        "pack_id": AGENT_PACK_ID,
        "hint_es": hint,
    }


@router.post("/plan")
async def plan(req: PlanRequest, request: Request) -> dict[str, Any]:
    """Router first (no LLM); otherwise Ollama + schema + ≤ 3 attempts. 409 PACK_REQUIRED when
    the command needs the LLM and Ollama or its model is missing. Sprint 5 (H18): the planner runs
    as a task that is canceled when the client goes away (Cancelar in the web), which closes the
    request to Ollama so it stops generating."""
    planner = make_planner(req.settings.model, req.settings.temperature)
    work = asyncio.ensure_future(planner.plan(req.command, req.project_summary))
    try:
        while True:
            done, _ = await asyncio.wait({work}, timeout=0.25)
            if done:
                break
            if await request.is_disconnected():
                work.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await work
                raise ClientGoneError()
        outcome = work.result()
    except PlannerUnavailableError as exc:
        raise await _pack_required(planner.model, exc) from exc
    finally:
        if not work.done():
            work.cancel()
    return outcome.response()


class ClientGoneError(RuntimeError):
    """The api closed the /agent/plan request (user canceled): nothing to answer."""


async def _pack_required(model: str, exc: PlannerUnavailableError) -> Exception:
    """PACK_REQUIRED agent-llm with the exact manual commands; /api/version tells "Ollama is not
    running (open the tray app)" from "the model is missing (ollama pull)". A refused remote
    OLLAMA_URL stays its own error (403 OLLAMA_REMOTE_REFUSED)."""
    if isinstance(exc.cause, OllamaRemoteRefusedError):
        return exc.cause
    client = services.ollama_client()
    try:
        version: str | None = await client.version(timeout=2.0)
    except OllamaError:
        version = None
    url = get_settings().ollama_url
    return PackRequiredError(AGENT_PACK_ID, pack_required_detail(model, url=url, version=version))


@router.post("/eval")
def run_eval(req: EvalRequest) -> dict[str, Any]:
    """Queue an evaluation; result in storage/run/agent-eval.json (GET /agent/eval/last).

    Sprint 5: progress per command (``done/total``, ``stage_es`` «qwen3:8b · 17/20»), ``mode``
    quick (20) | full, cancel (POST /agent/tasks/{id}/cancel) stops Ollama's generation; when no
    model is available the task fails with code PACK_REQUIRED (agent-llm) and writes nothing."""
    settings = get_settings()
    models = req.models or [settings.agent_model]
    examples = load_dataset(req.dataset)
    if req.limit:
        examples = examples[: req.limit]
    elif req.mode == "quick":
        examples = select_quick(examples, QUICK_N, dataset_ids(req.dataset))
    if not examples:
        raise NotFoundError(
            f"No hay ejemplos en el dataset '{req.dataset}' (studio_workers/agent/dataset)"
        )

    def job(task: Task) -> dict[str, Any]:
        def items(done: int, total: int, stage_es: str) -> None:
            task.set_items(done, total, stage_es)

        def plan_fn_for(model: str):
            planner = make_planner(model)

            async def plan_fn(ex: Example):
                return await planner.plan(
                    ex.command,
                    ex.project_summary,
                    use_router=req.use_router,
                    exclude_command=ex.command,
                )

            return plan_fn

        task.set_items(0, len(models) * len(examples), f"{models[0]} · 0/{len(examples)}")
        try:
            result = asyncio.run(
                evaluate(
                    models,
                    examples,
                    plan_fn_for,
                    dataset=req.dataset,
                    cancel=task.cancel_event,
                    items=items,
                    mode="custom" if req.limit else req.mode,
                )
            )
        except EvalCanceled as exc:
            raise TaskCanceled(task.id) from exc
        unavailable = [r for r in result["models"].values() if r.get("available") is False]
        if unavailable and len(unavailable) == len(result["models"]):
            raise PackRequiredError(AGENT_PACK_ID, str(unavailable[0].get("error") or "") or None)
        result["use_router"] = req.use_router
        path = write_result(settings.storage_root, result)
        return {
            "path": path.relative_to(settings.storage_root).as_posix(),
            "mode": result["mode"],
            "n": result["n"],
            "summary": {
                m: {k: v for k, v in r.items() if k != "failures"}
                for m, r in result["models"].items()
            },
        }

    task = services.agent_queue().submit("agent.eval", ",".join(models), job)
    return {"task_id": task.id, "status": task.status}


@router.get("/tasks/{task_id}")
def task_status(task_id: str) -> dict[str, Any]:
    task = services.agent_queue().get(task_id)
    if task is None:
        raise task_not_found(task_id)
    return task.public()


@router.post("/tasks/{task_id}/cancel")
def task_cancel(task_id: str) -> dict[str, Any]:
    """Sprint 5: cancel the evaluation (the running Ollama request is closed)."""
    return cancel_or_404(services.agent_queue(), task_id)


@router.get("/eval/last")
def eval_last() -> dict[str, Any]:
    data = read_last(get_settings().storage_root)
    if data is None:
        raise NotFoundError("Todavía no se evaluó el asistente")
    return data


@router.post("/bugreport")
async def bugreport(req: BugreportRequest) -> dict[str, Any]:
    """{markdown_es, source: llm|template}: LLM draft when the model is there, else template."""
    settings = get_settings()
    return await draft_report(
        req.model_dump(exclude={"model"}),
        services.ollama_client(),
        req.model or settings.agent_model,
        temperature=settings.agent_temperature,
        keep_alive=settings.agent_keep_alive,
        num_ctx=settings.agent_num_ctx,
        before_llm=_release_gpu,
    )
