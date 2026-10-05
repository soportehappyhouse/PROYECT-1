"""Sprint 3 local edit agent (docs/trabajo/sprint3-contratos.md, "Workers")."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import services
from ..agent.bugreport import draft_report
from ..agent.eval import evaluate, load_dataset, read_last, write_result
from ..agent.ollama_client import ALT_MODEL, DEFAULT_MODEL, OllamaError, model_in
from ..agent.planner import LLM_VRAM_MB, Example, Planner, PlannerUnavailableError
from ..config import get_settings
from ..errors import NotFoundError
from ..packs import AGENT_PACK_ID, PackRequiredError
from ..tasks import Task

router = APIRouter(prefix="/agent", tags=["agent"])


class LlmSettings(BaseModel):
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)


class PlanRequest(BaseModel):
    command: str = Field(min_length=1, max_length=2000)
    # The api sends a string (services/agent/summary.ts); objects are accepted for tools/tests.
    project_summary: str | dict[str, Any] | list[Any] = ""
    settings: LlmSettings = Field(default_factory=LlmSettings)


class EvalRequest(BaseModel):
    models: list[str] | None = None
    dataset: Literal["golden", "all"] = "golden"
    use_router: bool = True
    limit: int | None = Field(default=None, ge=1)


class BugreportRequest(BaseModel):
    title: str | None = None
    steps_text: str = ""
    breadcrumbs: list[Any] = Field(default_factory=list)
    errors: list[Any] = Field(default_factory=list)
    env: dict[str, Any] = Field(default_factory=dict)


def _release_gpu() -> list[str]:
    """GPU coordination: unload Whisper/vision before Ollama when free VRAM < 5.5 GB."""
    released = services.gpu_budget().make_room(LLM_VRAM_MB)
    return [f"gpu_released:{released}"] if released else []


def make_planner(model: str | None = None, temperature: float | None = None) -> Planner:
    settings = get_settings()
    return Planner(
        services.ollama_client(),
        model=model or settings.agent_model,
        temperature=0.2 if temperature is None else temperature,
        num_ctx=settings.agent_num_ctx,
        keep_alive=settings.agent_keep_alive,
        before_llm=_release_gpu,
    )


@router.get("/status")
async def status() -> dict[str, Any]:
    """{ollama, model, models_installed, ready, gpu_mode} (+ version, defaults, hint_es)."""
    settings = get_settings()
    client = services.ollama_client()
    model = settings.agent_model
    try:
        installed = await client.installed_models(timeout=2.0)
        version: str | None = await client.version(timeout=2.0)
        up = True
    except OllamaError as exc:
        installed, version, up = [], None, False
        hint: str | None = str(exc)
    ready = up and model_in(model, installed)
    if up:
        hint = None if ready else f"Falta el modelo {model}: descargá el paquete {AGENT_PACK_ID}."
    gpu = await asyncio.to_thread(services.gpu_budget().status)
    return {
        "ollama": up,
        "model": model,
        "models_installed": installed,
        "ready": ready,
        "gpu_mode": gpu.get("mode"),
        # additive
        "ollama_url": settings.ollama_url,
        "ollama_version": version,
        "default_model": DEFAULT_MODEL,
        "alt_models": [ALT_MODEL],
        "pack_id": AGENT_PACK_ID,
        "hint_es": hint,
    }


@router.post("/plan")
async def plan(req: PlanRequest) -> dict[str, Any]:
    """Router first (no LLM); otherwise Ollama + schema + ≤ 3 attempts. 409 PACK_REQUIRED when
    the command needs the LLM and Ollama or its model is missing."""
    planner = make_planner(req.settings.model, req.settings.temperature)
    try:
        outcome = await planner.plan(req.command, req.project_summary)
    except PlannerUnavailableError as exc:
        raise PackRequiredError(AGENT_PACK_ID, str(exc)) from exc
    return outcome.response()


@router.post("/eval")
def run_eval(req: EvalRequest) -> dict[str, Any]:
    """Queue an evaluation; result in storage/run/agent-eval.json (GET /agent/eval/last)."""
    settings = get_settings()
    models = req.models or [settings.agent_model]
    examples = load_dataset(req.dataset)
    if req.limit:
        examples = examples[: req.limit]
    if not examples:
        raise NotFoundError(
            f"No hay ejemplos en el dataset '{req.dataset}' (studio_workers/agent/dataset)"
        )

    def job(task: Task) -> dict[str, Any]:
        def step(p: float, msg: str) -> None:
            task.progress = min(0.99, p)
            task.current_file = msg

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

        result = asyncio.run(
            evaluate(models, examples, plan_fn_for, dataset=req.dataset, step=step)
        )
        result["use_router"] = req.use_router
        path = write_result(settings.storage_root, result)
        return {
            "path": path.relative_to(settings.storage_root).as_posix(),
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
        raise NotFoundError(f"Tarea desconocida: {task_id}")
    return task.public()


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
        req.model_dump(),
        services.ollama_client(),
        settings.agent_model,
        keep_alive=settings.agent_keep_alive,
        num_ctx=settings.agent_num_ctx,
        before_llm=_release_gpu,
    )
