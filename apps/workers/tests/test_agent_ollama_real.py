"""Against a REAL local Ollama (skipped when it is not running or the model is not pulled).

    AGENT_TEST_MODEL=qwen3:0.6b pytest tests/test_agent_ollama_real.py   (default model)

Checks the real wire format: /api/tags, /api/chat with ``format`` = the exported EditPlan schema
(Ollama turns it into a grammar, so the answer must be schema-valid JSON), the planner loop, and
the Spanish errors for a missing model / a failed pull. Semantics are not asserted: a 0.6B model
is only a plumbing check (criterion 4 is measured with POST /agent/eval and qwen3:8b).
"""

import asyncio
import json
import os

import pytest

from studio_workers.agent import schema
from studio_workers.agent.ollama_client import (
    OllamaClient,
    OllamaError,
    OllamaModelMissingError,
    installed_models_sync,
    model_in,
)
from studio_workers.agent.planner import Planner

URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("AGENT_TEST_MODEL", "qwen3:0.6b")
_installed = installed_models_sync(URL, timeout=1.0)

needs_ollama = pytest.mark.skipif(_installed is None, reason=f"Ollama no responde en {URL}")
needs_model = pytest.mark.skipif(
    _installed is None or not model_in(MODEL, _installed),
    reason=f"modelo {MODEL} no descargado en Ollama (ollama pull {MODEL})",
)

SUMMARY = """PROYECTO "Prueba" · lienzo 1920x1080 (16:9) · 30 fps · duración 20s · cursor 2s
PISTAS (clips por orden de inicio; tiempos en segundos de la línea de tiempo):
- V1 video "Video 1": 1 clip
  1. id=c1 "playa.mp4" 0-20s (20s)
ESCENAS: sin detectar
TRANSCRIPCIÓN: no hay"""


@needs_ollama
def test_real_tags_and_version() -> None:
    client = OllamaClient(URL)
    assert asyncio.run(client.version())
    names = asyncio.run(client.installed_models())
    assert names == _installed


@needs_ollama
def test_real_missing_model_is_spanish() -> None:
    client = OllamaClient(URL)
    with pytest.raises(OllamaModelMissingError, match="no está descargado"):
        asyncio.run(client.chat("studio-no-existe:0", [{"role": "user", "content": "hola"}]))


@needs_ollama
def test_real_pull_of_unknown_model_fails_cleanly() -> None:
    with pytest.raises(OllamaError):
        asyncio.run(OllamaClient(URL).pull("studio-no-existe-xyz:0"))


@needs_model
def test_real_structured_output_is_schema_valid() -> None:
    client = OllamaClient(URL, timeout=300)
    result = asyncio.run(
        client.chat(
            MODEL,
            [
                {"role": "system", "content": "Respondé solo un EditPlan JSON."},
                {"role": "user", "content": "Pedido: poné un título que diga Hola en el segundo 3"},
            ],
            format=schema.ollama_format(),
            temperature=0.2,
            num_ctx=4096,
            extra_options={"num_predict": 512},
        )
    )
    plan = json.loads(result.content)
    assert plan["version"] == 1 and isinstance(plan["ops"], list)


@needs_model
def test_real_planner_end_to_end() -> None:
    planner = Planner(OllamaClient(URL, timeout=300), model=MODEL, num_ctx=4096)
    out = asyncio.run(planner.plan("agregá un título que diga Hola en el segundo 3", SUMMARY))
    assert out.route == "llm" and 1 <= out.attempts <= 3
    assert schema.validate_plan(out.plan) == []  # valid plan or the "rephrase" question
