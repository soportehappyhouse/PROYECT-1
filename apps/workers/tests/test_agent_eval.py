"""Agent evaluation metrics on a tiny dataset (mocked Ollama) + the /agent/eval task."""

import asyncio
import json
from pathlib import Path

from ollama_fake import FakeOllama

from studio_workers.agent import eval as ev
from studio_workers.agent.planner import Example, Planner

SUMMARY = {
    "canvas": {"w": 1920, "h": 1080},
    "tracks": [{"kind": "video", "clips": [{"id": "clip_a", "name": "playa.mp4"}]}],
}
DATASET = [
    {  # router
        "command": "exportá para reels",
        "project_summary": SUMMARY,
        "plan": {
            "version": 1,
            "summary_es": "x",
            "ops": [{"op": "export", "preset": "reels-tiktok", "confirm": True}],
        },
    },
    {  # llm, exact
        "command": "poné un título que diga Hola en el segundo 3",
        "project_summary": SUMMARY,
        "plan": {
            "version": 1,
            "summary_es": "x",
            "ops": [{"op": "add_text", "text": "Hola", "t": 3}],
        },
    },
    {  # llm, semantic but not exact (extra duration)
        "command": "acelerá la playa al doble",
        "project_summary": SUMMARY,
        "plan": {
            "version": 1,
            "summary_es": "x",
            "ops": [{"op": "set_speed", "clip": {"name": "playa"}, "speed": 2}],
        },
    },
    {  # llm, wrong preset
        "command": "exportá en vertical",
        "project_summary": SUMMARY,
        "plan": {"version": 1, "summary_es": "x", "ops": [], "questions": ["¿Reels o Shorts?"]},
    },
]
MODEL = "qwen3:0.6b"


def write_dataset(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "golden.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in DATASET) + "\n", "utf-8"
    )


def replies(fake: FakeOllama) -> FakeOllama:
    return fake.reply(
        {
            "version": 1,
            "summary_es": "Título",
            "ops": [{"op": "add_text", "text": "hola", "t": 3.2}],
        },
        {
            "version": 1,
            "summary_es": "Rápido",
            "ops": [{"op": "set_speed", "clip": {"name": "Playa"}, "speed": 2, "note_es": "x"}],
        },
        {
            "version": 1,
            "summary_es": "Export",
            "ops": [{"op": "export", "preset": "youtube-shorts"}],
        },
    )


def test_compare_helpers() -> None:
    exp = {"ops": [{"op": "add_text", "text": "Día 2", "t": {"after_clip": {"name": "cena"}}}]}
    got = {
        "ops": [
            {
                "op": "add_text",
                "text": "dia 2!",
                "t": {"after_clip": {"name": "Cena.mp4"}},
                "confirm": True,
            }
        ]
    }
    assert ev.semantic_match(exp, got) == (True, "")
    assert not ev.exact_match(exp, got)
    assert ev.exact_match(exp, {"ops": [{**exp["ops"][0], "confirm": True, "note_es": "n"}]})
    ok, reason = ev.semantic_match(
        {"ops": [{"op": "export", "preset": "reels-tiktok"}]},
        {"ops": [{"op": "export", "preset": "youtube-shorts"}]},
    )
    assert not ok and "preset" in reason
    assert not ev.semantic_match(
        {"ops": [{"op": "cut_silences"}]}, {"ops": [{"op": "transcribe"}]}
    )[0]
    assert ev.semantic_match({"ops": [], "questions": ["?"]}, {"ops": [], "questions": ["¿Cuál?"]})[
        0
    ]
    assert ev.semantic_match(
        {"ops": [{"op": "cut_silences", "fillers": False}]}, {"ops": [{"op": "cut_silences"}]}
    )[0]
    assert ev.semantic_match(
        {
            "ops": [
                {
                    "op": "remove_background",
                    "clip": {"name": "selfie"},
                    "background": {"type": "blur"},
                }
            ]
        },
        {
            "ops": [
                {
                    "op": "remove_background",
                    "clip": {"name": "selfie"},
                    "background": {"type": "color"},
                }
            ]
        },
    ) == (False, "ops[0].background.type: 'color' != 'blur'")


def test_metrics_on_a_tiny_dataset(tmp_path: Path) -> None:
    write_dataset(tmp_path)
    examples = ev.load_dataset("golden", tmp_path)
    assert len(examples) == 4 and isinstance(examples[0].project_summary, str)
    fake = replies(FakeOllama([MODEL]))
    planner = Planner(fake.client(), model=MODEL, examples=[])

    def plan_fn_for(model: str):
        async def plan_fn(ex: Example):
            return await planner.plan(ex.command, ex.project_summary, exclude_command=ex.command)

        return plan_fn

    result = asyncio.run(ev.evaluate([MODEL], examples, plan_fn_for))
    m = result["models"][MODEL]
    assert m["n"] == 4 and m["available"] is True
    assert m["valid_json_rate"] == 1.0 and m["schema_valid_rate"] == 1.0
    assert m["exact_ops_rate"] == 0.25  # only the router one is identical
    assert m["semantic_rate"] == 0.75  # title (text/time tolerance) + speed match; preset fails
    assert m["routes"] == {"deterministic": 1, "llm": 3}
    assert m["failures"][0]["command"] == "exportá en vertical"
    assert "p50_latency_ms" in m and m["mean_attempts"] == 0.75
    path = ev.write_result(tmp_path / "storage", result)
    assert path == tmp_path / "storage" / "run" / "agent-eval.json"
    assert ev.read_last(tmp_path / "storage")["models"][MODEL]["semantic_rate"] == 0.75


def test_unavailable_model_is_reported_not_raised(tmp_path: Path) -> None:
    write_dataset(tmp_path)
    examples = ev.load_dataset("golden", tmp_path)
    planner = Planner(FakeOllama([]).client(), model="hermes3:8b", examples=[])

    def plan_fn_for(model: str):
        async def plan_fn(ex: Example):
            return await planner.plan(ex.command, ex.project_summary)

        return plan_fn

    result = asyncio.run(ev.evaluate(["hermes3:8b"], examples, plan_fn_for))
    m = result["models"]["hermes3:8b"]
    assert m["available"] is False and "ollama pull hermes3:8b" in m["error"]


def test_eval_endpoint_writes_agent_eval_json(client, dirs, monkeypatch, tmp_path: Path) -> None:
    from studio_workers import services
    from studio_workers.agent import planner as planner_mod

    storage, _models = dirs
    write_dataset(tmp_path / "ds")
    monkeypatch.setattr(planner_mod, "DATASET_DIR", tmp_path / "ds")
    fake = replies(FakeOllama([MODEL]))
    monkeypatch.setattr(services, "ollama_client", fake.client)
    r = client.post("/agent/eval", json={"models": [MODEL]})
    assert r.status_code == 200, r.text
    task = services.agent_queue().wait(r.json()["task_id"], timeout=30)
    assert task is not None and task.status == "done", task and task.error
    data = json.loads((storage / "run" / "agent-eval.json").read_text("utf-8"))
    assert data["dataset"] == "golden" and data["models"][MODEL]["semantic_rate"] == 0.75
    assert client.get(f"/agent/tasks/{task.id}").json()["result"]["path"] == "run/agent-eval.json"
    assert client.get("/agent/eval/last").json()["n"] == 4


def test_eval_endpoint_without_dataset_is_404(client, monkeypatch, tmp_path: Path) -> None:
    from studio_workers.agent import planner as planner_mod

    monkeypatch.setattr(planner_mod, "DATASET_DIR", tmp_path / "empty")
    assert client.post("/agent/eval", json={}).status_code == 404
    assert client.get("/agent/eval/last").status_code == 404
