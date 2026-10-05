"""A precise in-process fake of the Ollama HTTP API (httpx.MockTransport) for agent tests.

Mirrors the real responses checked against Ollama 0.35.1: ``/api/version`` -> {version},
``/api/tags`` -> {models: [{name, model, size, …}]}, ``/api/chat`` (stream false) ->
{model, message: {role, content}, done, eval_count…} or 404 {error: "model 'x' not found"},
``/api/pull`` -> NDJSON stream of {status, digest?, total?, completed?} ending in
{status: "success"} (or a line {error}).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx

from studio_workers.agent.ollama_client import OllamaClient

ChatReply = str | dict[str, Any] | Callable[[dict[str, Any]], str]


class FakeOllama:
    def __init__(self, models: list[str] | None = None, *, up: bool = True) -> None:
        self.models = list(models or [])
        self.up = up
        self.replies: list[ChatReply] = []
        self.requests: list[dict[str, Any]] = []
        self.pull_lines: list[dict[str, Any]] | None = None

    # --------------------------------------------------------------- scripting
    def reply(self, *contents: ChatReply) -> FakeOllama:
        self.replies.extend(contents)
        return self

    @property
    def chats(self) -> list[dict[str, Any]]:
        return [r["body"] for r in self.requests if r["path"] == "/api/chat"]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def client(self, **kw: Any) -> OllamaClient:
        return OllamaClient("http://127.0.0.1:11434", transport=self.transport(), **kw)

    # --------------------------------------------------------------- handler
    def handle(self, request: httpx.Request) -> httpx.Response:
        if not self.up:
            raise httpx.ConnectError("[Errno 111] Connection refused", request=request)
        body = json.loads(request.content) if request.content else {}
        self.requests.append({"method": request.method, "path": request.url.path, "body": body})
        path = request.url.path
        if path == "/api/version":
            return httpx.Response(200, json={"version": "0.35.1"})
        if path == "/api/tags":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"name": m, "model": m, "size": 1000, "details": {"format": "gguf"}}
                        for m in self.models
                    ]
                },
            )
        if path == "/api/chat":
            model = body.get("model", "")
            if model not in self.models:
                return httpx.Response(404, json={"error": f"model '{model}' not found"})
            if not self.replies:
                return httpx.Response(500, json={"error": "fake: no scripted reply left"})
            reply = self.replies.pop(0)
            if callable(reply):
                reply = reply(body)
            content = reply if isinstance(reply, str) else json.dumps(reply)
            return httpx.Response(
                200,
                json={
                    "model": model,
                    "created_at": "2026-10-05T23:00:00Z",
                    "message": {"role": "assistant", "content": content},
                    "done": True,
                    "done_reason": "stop",
                    "eval_count": 42,
                    "prompt_eval_count": 300,
                },
            )
        if path == "/api/pull":
            lines = self.pull_lines
            if lines is None:
                model = body.get("model", "")
                lines = [
                    {"status": "pulling manifest"},
                    {
                        "status": "pulling abc",
                        "digest": "sha256:abc",
                        "total": 1000,
                        "completed": 0,
                    },
                    {
                        "status": "pulling abc",
                        "digest": "sha256:abc",
                        "total": 1000,
                        "completed": 600,
                    },
                    {
                        "status": "pulling abc",
                        "digest": "sha256:abc",
                        "total": 1000,
                        "completed": 1000,
                    },
                    {"status": "verifying sha256 digest"},
                    {"status": "writing manifest"},
                    {"status": "success"},
                ]
                self.models.append(model)
            text = "\n".join(json.dumps(x) for x in lines) + "\n"
            return httpx.Response(
                200, content=text.encode(), headers={"content-type": "application/x-ndjson"}
            )
        if path == "/api/generate":
            return httpx.Response(200, json={"done": True})
        return httpx.Response(404, text="404 page not found")
