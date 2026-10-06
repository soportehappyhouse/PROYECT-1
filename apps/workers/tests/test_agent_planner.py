"""Planner with a mocked Ollama: schema format, retries with feedback, invented ids, GPU room."""

import asyncio
import json

import pytest
from ollama_fake import FakeOllama

from studio_workers.agent import schema
from studio_workers.agent.ollama_client import (
    OllamaModelMissingError,
    OllamaTimeoutError,
    OllamaUnavailableError,
    strip_thinking,
)
from studio_workers.agent.planner import (
    Example,
    Planner,
    PlannerUnavailableError,
    build_messages,
    enforce_known_ids,
    pick_examples,
    system_prompt,
)
from studio_workers.gpu import GpuBudget, VramInfo

SUMMARY = """PROYECTO "Viaje" · lienzo 1920x1080 (16:9) · 30 fps · duración 40s · cursor 3s
PISTAS (clips por orden de inicio; tiempos en segundos de la línea de tiempo):
- V1 video "Video 1": 2 clips
  1. id=c1 "playa.mp4" 0-12.5s (12.5s)
  2. id=c2 "cena.mp4" 12.5-40s (27.5s)
ESCENAS: sin detectar"""

TITLE_PLAN = {
    "version": 1,
    "summary_es": "Título en el segundo 3.",
    "ops": [{"op": "add_text", "text": "Hola", "t": 3}],
}
MODEL = "qwen3:8b"


def run(coro):
    return asyncio.run(coro)


def planner(fake: FakeOllama, **kw) -> Planner:
    return Planner(fake.client(), model=MODEL, examples=[], **kw)


def test_valid_plan_on_first_try() -> None:
    fake = FakeOllama([MODEL]).reply(TITLE_PLAN)
    out = run(planner(fake).plan("agregá un título que diga Hola en el segundo 3", SUMMARY))
    assert out.route == "llm" and out.attempts == 1 and out.model == MODEL
    assert out.plan == TITLE_PLAN and out.warnings == []
    body = fake.chats[0]
    assert body["format"] == schema.ollama_format()  # structured outputs with the exported schema
    assert "$schema" not in body["format"] and "$defs" in body["format"]
    assert body["options"] == {"temperature": 0.2, "num_ctx": 4096}
    assert body["keep_alive"] == "60s" and body["think"] is False and body["stream"] is False
    assert out.prompt_tokens and out.response()["prompt_tokens"] == out.prompt_tokens
    assert body["messages"][0]["role"] == "system"
    assert "id=c1" in body["messages"][-1]["content"]  # compact project summary goes in
    assert body["messages"][-1]["content"].endswith(
        "Pedido: agregá un título que diga Hola en el segundo 3"
    )


def test_invalid_then_retry_with_errors_then_valid() -> None:
    bad = {
        "version": 1,
        "summary_es": "x",
        "ops": [{"op": "set_speed", "clip": {"id": "c1"}, "speed": 40}],
    }
    fake = FakeOllama([MODEL]).reply("esto no es json", bad, TITLE_PLAN)
    out = run(planner(fake).plan("poné un título", SUMMARY))
    assert out.attempts == 3 and out.plan == TITLE_PLAN
    assert "llm_retries:2" in out.warnings
    second = fake.chats[1]["messages"]
    assert second[-2] == {"role": "assistant", "content": "esto no es json"}
    assert "no es JSON válido" in second[-1]["content"]
    third = fake.chats[2]["messages"]
    assert "ops[0].speed" in third[-1]["content"] and "16" in third[-1]["content"]


def test_unknown_op_error_is_explicit() -> None:
    fake = FakeOllama([MODEL]).reply(
        {"version": 1, "summary_es": "x", "ops": [{"op": "zoom"}]}, TITLE_PLAN
    )
    out = run(planner(fake).plan("hacé zoom", SUMMARY))
    assert out.attempts == 2
    assert "operación desconocida «zoom»" in fake.chats[1]["messages"][-1]["content"]


def test_three_invalid_answers_end_in_a_question() -> None:
    fake = FakeOllama([MODEL]).reply("{", "{}", '{"version": 2}')
    out = run(planner(fake).plan("poné un título", SUMMARY))
    assert out.attempts == 3 and out.schema_valid is False and out.valid_json is True
    assert out.plan["ops"] == [] and out.plan["questions"]
    assert schema.validate_plan(out.plan) == []
    assert "llm_invalid_plan" in out.warnings


def test_invented_id_becomes_a_question() -> None:
    invented = {
        "version": 1,
        "summary_es": "Borrar el clip.",
        "ops": [{"op": "delete_clip", "clip": {"id": "clip_99"}}, {"op": "transcribe"}],
    }
    fake = FakeOllama([MODEL]).reply(invented)
    out = run(planner(fake).plan("borrá el clip del perro y transcribí", SUMMARY))
    assert out.plan["ops"] == [{"op": "transcribe"}]
    assert out.plan["questions"] and "clip_99" in out.plan["questions"][0]
    assert "invented_id:clip_99" in out.warnings
    assert schema.validate_plan(out.plan) == []


def test_invented_id_with_other_fields_keeps_the_op() -> None:
    plan = {
        "version": 1,
        "summary_es": "x",
        "ops": [
            {"op": "denoise", "clip": {"id": "nope", "name": "cena"}},
            {"op": "split", "clip": {"id": "c2"}, "t": {"after_clip": {"id": "ghost"}}},
            {"op": "delete_clip", "clip": {"id": "c1"}},
        ],
    }
    fixed, warnings = enforce_known_ids(plan, SUMMARY)
    assert fixed["ops"][0] == {"op": "denoise", "clip": {"name": "cena"}}
    assert fixed["ops"][1]["op"] == "delete_clip" and fixed["ops"][1]["confirm"] is True
    assert len(fixed["questions"]) == 1 and "ghost" in fixed["questions"][0]
    assert warnings == ["invented_id:nope", "invented_id:ghost"]


def test_known_ids_pass_untouched() -> None:
    plan = {
        "version": 1,
        "summary_es": "x",
        "ops": [{"op": "set_speed", "clip": {"id": "c2"}, "speed": 2}],
    }
    fixed, warnings = enforce_known_ids(plan, SUMMARY)
    assert fixed == plan and warnings == []


def test_router_answers_without_calling_ollama() -> None:
    fake = FakeOllama([], up=False)
    out = run(planner(fake).plan("exportá para reels", SUMMARY))
    assert out.route == "deterministic" and out.attempts == 0 and out.model is None
    assert out.plan["ops"] == [{"op": "export", "preset": "reels-tiktok", "confirm": True}]
    assert fake.requests == []


def test_ollama_down_or_model_missing_is_unavailable() -> None:
    with pytest.raises(PlannerUnavailableError) as down:
        run(planner(FakeOllama([MODEL], up=False)).plan("poné un título", SUMMARY))
    assert isinstance(down.value.cause, OllamaUnavailableError)
    assert "Ollama no está corriendo" in str(down.value)
    with pytest.raises(PlannerUnavailableError) as missing:
        run(planner(FakeOllama(["hermes3:8b"])).plan("poné un título", SUMMARY))
    assert isinstance(missing.value.cause, OllamaModelMissingError)
    assert "ollama pull qwen3:8b" in str(missing.value)


def test_before_llm_hook_runs_only_for_the_llm() -> None:
    calls: list[int] = []

    def hook() -> list[str]:
        calls.append(1)
        return ["gpu_released:whisper"]

    fake = FakeOllama([MODEL]).reply(TITLE_PLAN)
    p = planner(fake, before_llm=hook)
    run(p.plan("cortá los silencios", SUMMARY))
    assert calls == []
    out = run(p.plan("poné un título", SUMMARY))
    assert calls == [1] and out.warnings == ["gpu_released:whisper"]


def test_gpu_make_room_releases_resident_model_when_vram_is_short() -> None:
    freed: list[str] = []
    info = VramInfo("RTX 4050", 6141, 3000, "nvidia-smi")
    budget = GpuBudget(use_cuda=True, probe=lambda: info, reserve_mb=0)
    budget.acquire("whisper:large-v3-turbo", 1800, lambda: freed.append("whisper"))
    assert budget.make_room(5500) == "whisper:large-v3-turbo" and freed == ["whisper"]
    assert budget.resident is None
    assert budget.make_room(5500) is None  # nothing resident
    info.free_mb = 5800
    budget.acquire("rvc", 100, lambda: freed.append("rvc"))
    assert budget.make_room(5500) is None and budget.resident == "rvc"  # enough VRAM: keep it
    assert GpuBudget(use_cuda=False).make_room(5500) is None


def test_few_shot_examples_by_similarity_and_without_the_evaluated_command() -> None:
    pool = [
        Example("poné un título que diga Hola", "", TITLE_PLAN),
        Example("bajá la música", "", {"version": 1, "summary_es": "x", "ops": []}),
        Example("poné un título grande", "", TITLE_PLAN),
    ]
    picked = pick_examples("poné un título que diga Chau", pool, k=2)
    assert [e.command for e in picked] == ["poné un título que diga Hola", "poné un título grande"]
    picked = pick_examples(
        "poné un título que diga Hola", pool, exclude="poné un título que diga Hola"
    )
    assert all(e.command != "poné un título que diga Hola" for e in picked)
    msgs = build_messages("poné un título", SUMMARY, picked)
    assert msgs[1] == {"role": "user", "content": "Pedido: poné un título grande"}
    assert json.loads(msgs[2]["content"]) == TITLE_PLAN


def test_system_prompt_covers_every_op() -> None:
    text = system_prompt()
    assert all(name in text for name in schema.op_names())


def test_thinking_blocks_and_fences_are_stripped() -> None:
    assert strip_thinking('<think>mmm</think>\n```json\n{"a": 1}\n```') == '{"a": 1}'


def test_chat_timeout_is_spanish() -> None:
    import httpx

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    from studio_workers.agent.ollama_client import OllamaClient

    client = OllamaClient(transport=httpx.MockTransport(slow), timeout=5)
    with pytest.raises(OllamaTimeoutError, match="tardó más de 5 s"):
        run(client.chat(MODEL, [{"role": "user", "content": "hola"}]))


def test_hermes_does_not_get_the_think_flag() -> None:
    fake = FakeOllama(["hermes3:8b"]).reply(TITLE_PLAN)
    run(Planner(fake.client(), model="hermes3:8b", examples=[]).plan("poné un título", SUMMARY))
    assert "think" not in fake.chats[0]


def test_pull_streams_progress_and_reports_errors() -> None:
    fake = FakeOllama([])
    seen: list[tuple[str, int, int]] = []
    run(fake.client().pull("qwen3:0.6b", lambda p: seen.append((p.status, p.completed, p.total))))
    assert seen[0] == ("pulling manifest", 0, 0)
    assert ("pulling abc", 600, 1000) in seen and seen[-1][0] == "success"
    fake.pull_lines = [
        {"status": "pulling manifest"},
        {"error": 'pull model manifest: Get "https://registry.ollama.ai/v2/x": Forbidden'},
    ]
    from studio_workers.agent.ollama_client import OllamaError

    with pytest.raises(OllamaError, match="sin acceso a registry.ollama.ai"):
        run(fake.client().pull("x:y"))


def test_fixed_fewshot_pairs_go_first_with_their_summary() -> None:
    from studio_workers.agent.planner import FIXED_SHOTS, fixed_examples, pick_fixed

    fixed = fixed_examples()
    assert len(fixed) == 8  # prompts/fewshot_es.jsonl keeps 8; the prompt gets 4 of them
    fake = FakeOllama([MODEL]).reply(TITLE_PLAN)
    run(Planner(fake.client(), model=MODEL, examples=[]).plan("poné un título", SUMMARY))
    msgs = fake.chats[0]["messages"]
    chosen = pick_fixed("poné un título", fixed)
    assert len(chosen) == FIXED_SHOTS == 4
    assert msgs[1]["content"].startswith("Resumen del proyecto:\n")
    assert msgs[1]["content"].endswith(f"Pedido: {chosen[0].command}")
    assert json.loads(msgs[2]["content"]) == chosen[0].plan
    assert len(msgs) == 1 + 2 * FIXED_SHOTS + 1
    # the evaluated command is never among its own examples
    fake.reply(TITLE_PLAN)
    p = Planner(fake.client(), model=MODEL, examples=[])
    cmd = chosen[0].command
    run(p.plan(cmd, SUMMARY, use_router=False, exclude_command=cmd))
    msgs = fake.chats[1]["messages"]
    assert len(msgs) == 1 + 2 * FIXED_SHOTS + 1
    assert sum(cmd in m["content"] for m in msgs) == 1  # only the request itself


def test_pick_fixed_is_diverse_and_deterministic() -> None:
    from studio_workers.agent.planner import _features, fixed_examples, pick_fixed

    fixed = fixed_examples()
    chosen = pick_fixed("exportá para tiktok con subtítulos", fixed)
    assert chosen == pick_fixed("exportá para tiktok con subtítulos", fixed)
    feats = [_features(ex) for ex in chosen]
    # every pick teaches something the others do not (no two with the same op set)
    assert len({frozenset(f) for f in feats}) == len(chosen) == 4
    assert any("questions" in f for f in feats)  # asking instead of guessing is shown
    assert any("export" in f for f in feats)  # ties go to the command's words
    order = [fixed.index(ex) for ex in chosen]
    assert order == sorted(order)


def test_prompt_fits_num_ctx_4096_with_a_full_summary() -> None:
    """System + 4 fixed + 2 similar + a summary at the 4000-char budget + the output reserve fit
    in num_ctx 4096 (6 GB card); the estimate is logged and returned."""
    from studio_workers.agent import summary as summ
    from studio_workers.agent.planner import (
        OUTPUT_RESERVE_TOKENS,
        build_messages,
        estimate_tokens,
        few_shot_pool,
        fixed_examples,
        pick_examples,
        pick_fixed,
    )

    big = "x" * (summ.MAX_SUMMARY_CHARS + 2000)  # over budget: compact() trims it
    cmd = "subí la música y poné un título que diga Hola al principio"
    msgs = build_messages(
        cmd, big, pick_examples(cmd, few_shot_pool()), pick_fixed(cmd, fixed_examples())
    )
    tokens = estimate_tokens(msgs)
    assert tokens + OUTPUT_RESERVE_TOKENS <= 4096, tokens
    assert estimate_tokens([{"role": "user", "content": "a" * 350}]) == 100 + 6


def test_prompt_over_num_ctx_drops_examples_then_falls_back() -> None:
    """Ollama 0.35 refuses a prompt longer than num_ctx (400 exceed_context_size_error): the
    planner drops example pairs until it fits; with no examples left it answers the fallback."""
    import httpx

    from studio_workers.agent.ollama_client import OllamaClient
    from studio_workers.agent.planner import fixed_examples

    over = {
        "error": {
            "code": 400,
            "message": "request (4096 tokens) exceeds the available context size (4096 tokens)",
            "type": "exceed_context_size_error",
        }
    }

    def make(limit: int) -> tuple[FakeOllama, Planner]:
        fake = FakeOllama([MODEL]).reply(TITLE_PLAN)

        def handle(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/chat":
                body = json.loads(request.content)
                if len(body["messages"]) > limit:
                    fake.requests.append({"path": "/api/chat-refused", "body": body})
                    return httpx.Response(400, json=over)
            return fake.handle(request)

        client = OllamaClient("http://127.0.0.1:11434", transport=httpx.MockTransport(handle))
        return fake, Planner(client, model=MODEL, examples=[], fixed=fixed_examples())

    fake, p = make(limit=1 + 2 * 2 + 1)  # only 2 of the 4 fixed pairs fit
    out = run(p.plan("agregá un título que diga Hola en el segundo 3", SUMMARY))
    assert out.plan == TITLE_PLAN and "prompt_trimmed" in out.warnings
    assert len(fake.chats[-1]["messages"]) == 1 + 2 * 2 + 1
    fake, p = make(limit=1)  # not even the request alone fits
    out = run(p.plan("agregá un título que diga Hola en el segundo 3", SUMMARY))
    assert out.schema_valid is False and out.plan["questions"]
    assert "prompt_over_ctx:4096" in out.warnings
