"""Sprint 6 Paso 0: task registry, payload contracts and 501 stubs (sprint6-contratos.md)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from studio_workers.errors import NOT_IMPLEMENTED_ES, not_implemented
from studio_workers.task_schema import (
    SPRINT6_MODULES,
    SPRINT6_TASKS,
    TASK_PRIORITY_BACKGROUND,
    TASK_PRIORITY_USER,
    ScriptAudio,
    SttWordsRequest,
    SuggestAnalyzeRequest,
    SuggestAnalyzeResult,
)

ROOT = Path(__file__).resolve().parents[3]


def test_registry() -> None:
    assert set(SPRINT6_TASKS) == {"stt.words", "suggest.analyze"}
    words, suggest = SPRINT6_TASKS["stt.words"], SPRINT6_TASKS["suggest.analyze"]
    assert (words.area, words.module, words.priority) == ("transcribe", "M1 Guion", 0)
    assert (suggest.area, suggest.module) == ("analyze", "M3 Sugerencias")
    assert suggest.priority == TASK_PRIORITY_BACKGROUND > TASK_PRIORITY_USER
    assert words.payload is SttWordsRequest and suggest.payload is SuggestAnalyzeRequest


def test_payload_defaults_and_validation() -> None:
    req = SttWordsRequest(input_path="media/a.mp4", output_base="renders/j1")
    assert req.language == "es" and req.hallucination_silence_threshold == 2.0
    with pytest.raises(ValidationError):
        SttWordsRequest(input_path="media/a.mp4", output_base="renders/j1", vad=True)
    s = SuggestAnalyzeRequest(input_path="media/a.mp4")
    assert (s.silence_min_ms, s.silence_rel_db, s.priority) == (500, 9.0, 5)
    with pytest.raises(ValidationError):
        SuggestAnalyzeRequest(input_path="media/a.mp4", silence_min_ms=10)
    audio = ScriptAudio(
        noise_floor_db=-55,
        rms_db_path="renders/j1/script-rms.f32",
        gaps=[{"start": 1, "end": 1.4, "rms_db": -30, "voiced": True}],
    )
    assert audio.window_ms == 5
    res = SuggestAnalyzeResult(
        duration_s=12,
        noise_floor_db=-60,
        silence_threshold_db=-50,
        silences=[(3, 6.5)],
        lufs_i=-30,
        lra=None,
        true_peak_db=-6,
    )
    assert res.silences == [(3.0, 6.5)]


def test_payload_fields_match_the_shared_contract() -> None:
    """Field names equal the zod schemas in packages/shared (read from the TS source)."""
    script_ts = (ROOT / "packages/shared/src/script.ts").read_text(encoding="utf-8")
    suggest_ts = (ROOT / "packages/shared/src/suggestions.ts").read_text(encoding="utf-8")
    for field in SttWordsRequest.model_fields:
        assert f"{field}:" in script_ts, field
    for field in SuggestAnalyzeRequest.model_fields:
        assert f"{field}:" in suggest_ts, field


def test_editplan_schema_has_the_new_ops() -> None:
    schema = json.loads(
        (ROOT / "apps/workers/studio_workers/agent/editplan.schema.json").read_text("utf-8")
    )
    text = json.dumps(schema)
    for op in ("delete_words", "fit_duration", "fix_text"):
        assert f'"const": "{op}"' in text, op


def test_not_implemented_error() -> None:
    err = not_implemented(SPRINT6_MODULES["M2"])
    assert err.status == 501
    assert err.payload() == {
        "detail": NOT_IMPLEMENTED_ES.format(modulo="M2 Sistema de diseño"),
        "code": "NOT_IMPLEMENTED",
        "details": {"module": "M2 Sistema de diseño"},
    }


@pytest.mark.parametrize(
    ("method", "url", "body", "module"),
    [
        ("post", "/transcribe/words", {"input_path": "a.mp4", "output_base": "r/j"}, "M1 Guion"),
        ("get", "/transcribe/tasks/t1", None, "M1 Guion"),
        ("post", "/transcribe/tasks/t1/cancel", None, "M1 Guion"),
        ("post", "/analyze/suggest", {"input_path": "a.mp4"}, "M3 Sugerencias"),
        ("get", "/analyze/tasks/t1", None, "M3 Sugerencias"),
        ("post", "/analyze/tasks/t1/cancel", None, "M3 Sugerencias"),
    ],
)
def test_stub_routes_answer_501(
    client: TestClient, method: str, url: str, body: dict | None, module: str
) -> None:
    res = client.request(method.upper(), url, json=body)
    assert res.status_code == 501
    assert res.json() == {
        "detail": f"Todavía no está disponible ({module}).",
        "code": "NOT_IMPLEMENTED",
        "details": {"module": module},
    }
