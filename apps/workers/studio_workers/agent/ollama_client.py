"""Async client for the local Ollama service (http://127.0.0.1:11434, MIT).

Only the endpoints the agent needs (docs/api.md of Ollama):

- ``GET /api/version`` and ``GET /api/tags``: is the service up, which models are pulled;
- ``GET /api/ps``: which models are loaded in memory right now (status ``loaded``);
- ``POST /api/pull`` (NDJSON stream ``{status, digest?, total?, completed?}`` or ``{error}``);
- ``POST /api/chat`` with ``format`` = JSON Schema (structured outputs), ``options``
  (``temperature``, ``num_ctx``), ``keep_alive`` and ``think`` (qwen3: off, we want only JSON).

Every failure becomes an ``OllamaError`` subclass with a Spanish message the UI shows as is.
Tests pass ``transport=httpx.MockTransport(...)``; ``installed_models_sync`` is the tiny
synchronous probe GET /packs uses (it runs in a worker thread, never in the event loop).

Safety: the agent only talks to a loopback Ollama (127.0.0.0/8, ::1, localhost). Any other
``OLLAMA_URL`` is refused (``OllamaRemoteRefusedError``) unless ``AGENT_ALLOW_REMOTE_OLLAMA=true``:
the prompt carries the project summary, and decision 8 says nothing leaves the PC.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import ipaddress
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

DEFAULT_URL = "http://127.0.0.1:11434"
DEFAULT_MODEL = "qwen3:8b"
ALT_MODEL = "hermes3:8b"
CI_MODEL = "qwen3:0.6b"
# Approximate download sizes (Q4_K_M) [S, ollama.com library pages].
MODEL_SIZES = {
    "qwen3:8b": 5_225_000_000,
    "hermes3:8b": 4_661_000_000,
    "qwen3:0.6b": 523_000_000,
}
UNKNOWN_MODEL_SIZE = 5_000_000_000

INSTALL_HINT_ES = (
    "Instalalo con scripts\\windows\\setup.ps1 (paso Ollama) o con "
    "`winget install Ollama.Ollama`, y abrilo desde el menú Inicio."
)
DOCTOR_HINT_ES = "Para revisar la instalación ejecutá scripts\\windows\\doctor.cmd."
TRAY_HINT_ES = (
    "Abrí la aplicación Ollama desde el menú Inicio: queda como ícono en la bandeja del sistema "
    "(junto al reloj) y atiende en segundo plano"
)
# Pack/display names of the known models (the agent-llm pack is named after AGENT_MODEL).
MODEL_LABELS = {
    "qwen3:8b": "Qwen3 8B",
    "hermes3:8b": "Hermes 3 8B",
    "qwen3:0.6b": "Qwen3 0.6B",
}


class OllamaError(RuntimeError):
    """Ollama answered with an error (message already in Spanish)."""


class OllamaRemoteRefusedError(OllamaError):
    """OLLAMA_URL is not loopback and AGENT_ALLOW_REMOTE_OLLAMA is off."""

    def __init__(self, url: str) -> None:
        super().__init__(
            f"OLLAMA_URL={url} no es local: el asistente solo habla con un Ollama en esta PC "
            f"(127.0.0.1 / localhost) para que el proyecto no salga de tu computadora. Usá "
            f"OLLAMA_URL=http://127.0.0.1:11434, o poné AGENT_ALLOW_REMOTE_OLLAMA=true en .env "
            f"si de verdad querés usar otro equipo."
        )


class OllamaUnavailableError(OllamaError):
    def __init__(self, url: str) -> None:
        super().__init__(
            f"Ollama no está corriendo en {url}. Abrí la aplicación Ollama (menú Inicio) o "
            f"ejecutá `ollama serve`. Si no está instalado: {INSTALL_HINT_ES}"
        )


class OllamaModelMissingError(OllamaError):
    def __init__(self, model: str) -> None:
        self.model = model
        super().__init__(
            f"El modelo {model} no está descargado en Ollama. Descargalo en Ajustes → "
            f"Asistente local (paquete agent-llm) o con `ollama pull {model}`."
        )


class OllamaTimeoutError(OllamaError):
    def __init__(self, what: str, seconds: float) -> None:
        super().__init__(
            f"Ollama tardó más de {seconds:.0f} s en {what}. Probá de nuevo, cerrá otros "
            f"programas que usen la GPU o elegí un modelo más chico en Ajustes."
        )


def is_loopback_url(url: str) -> bool:
    """http(s)://127.x.x.x | [::1] | localhost (any port)."""
    try:
        host = (urlsplit(url.strip()).hostname or "").lower()
    except ValueError:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def model_label(model: str) -> str:
    """'qwen3:8b' -> 'Qwen3 8B'; unknown models keep their Ollama tag (custom AGENT_MODEL)."""
    return MODEL_LABELS.get(normalize_model(model), model.strip())


def pack_required_detail(model: str, *, url: str, version: str | None) -> str:
    """Spanish PACK_REQUIRED text for agent-llm with the exact manual commands. ``version`` is
    what /api/version answered (None: Ollama is not running)."""
    pull = f"`ollama pull {model}`"
    if version is None:
        return (
            f"Ollama no está corriendo en {url} (no responde /api/version). {TRAY_HINT_ES}; "
            f"si no está instalado: `winget install Ollama.Ollama` "
            f"(o scripts\\windows\\setup.cmd). "
            f"Después descargá el modelo una sola vez en Ajustes → Paquetes o en una terminal: "
            f"{pull}. {DOCTOR_HINT_ES}"
        )
    return (
        f"Ollama {version} está corriendo, pero falta el modelo {model}. Descargalo en Ajustes → "
        f"Paquetes («Asistente local») o en una terminal: {pull}. {DOCTOR_HINT_ES}"
    )


def normalize_model(name: str) -> str:
    """'qwen3' -> 'qwen3:latest' (how /api/tags lists it)."""
    name = name.strip()
    return name if ":" in name else f"{name}:latest"


def model_in(model: str, installed: list[str]) -> bool:
    want = normalize_model(model)
    return any(normalize_model(m) == want for m in installed)


def model_size(model: str) -> int:
    return MODEL_SIZES.get(normalize_model(model), UNKNOWN_MODEL_SIZE)


_THINK_RE = re.compile(r"<think>.*?</think>", re.S)


def strip_thinking(text: str) -> str:
    """Drop <think>…</think> blocks and ``` fences some models add around the JSON."""
    text = _THINK_RE.sub("", text).strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def supports_think_flag(model: str) -> bool:
    """Models with a thinking mode accept ``think: false``; others reject the flag."""
    base = normalize_model(model).split(":")[0].lower()
    return base.startswith(("qwen3", "deepseek-r1", "qwq", "magistral", "gpt-oss"))


@dataclass
class ChatResult:
    content: str
    model: str
    latency_ms: int
    eval_count: int | None = None
    prompt_eval_count: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class PullProgress:
    status: str
    completed: int
    total: int


ProgressFn = Callable[[PullProgress], None | Awaitable[None]]


class OllamaClient:
    def __init__(
        self,
        base_url: str = DEFAULT_URL,
        *,
        timeout: float = 120.0,
        connect_timeout: float = 3.0,
        transport: httpx.AsyncBaseTransport | None = None,
        allow_remote: bool = False,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self._transport = transport
        self.allow_remote = allow_remote

    def check_url(self) -> None:
        """OllamaRemoteRefusedError when OLLAMA_URL is not loopback (see module doc)."""
        if not self.allow_remote and not is_loopback_url(self.base_url):
            raise OllamaRemoteRefusedError(self.base_url)

    def _client(self, timeout: float | None = None) -> httpx.AsyncClient:
        t = httpx.Timeout(timeout or self.timeout, connect=self.connect_timeout)
        return httpx.AsyncClient(base_url=self.base_url, timeout=t, transport=self._transport)

    async def _request(
        self, method: str, path: str, what: str, *, timeout: float | None = None, **kw: Any
    ) -> httpx.Response:
        self.check_url()
        try:
            async with self._client(timeout) as c:
                resp = await c.request(method, path, **kw)
        except httpx.ConnectError as exc:
            raise OllamaUnavailableError(self.base_url) from exc
        except httpx.TimeoutException as exc:
            raise OllamaTimeoutError(what, timeout or self.timeout) from exc
        except httpx.HTTPError as exc:
            raise OllamaError(f"Error de red hablando con Ollama ({what}): {exc}") from exc
        return resp

    @staticmethod
    def _error_text(resp: httpx.Response) -> str:
        try:
            data = resp.json()
            if isinstance(data, dict) and data.get("error"):
                return str(data["error"])
        except ValueError:
            pass
        return resp.text.strip()[:300] or f"HTTP {resp.status_code}"

    # ------------------------------------------------------------------ status
    async def version(self, *, timeout: float = 2.0) -> str:
        resp = await self._request("GET", "/api/version", "responder", timeout=timeout)
        if resp.status_code != 200:
            raise OllamaError(f"Ollama respondió {resp.status_code}: {self._error_text(resp)}")
        return str(resp.json().get("version", ""))

    async def is_up(self, *, timeout: float = 2.0) -> bool:
        try:
            await self.version(timeout=timeout)
        except OllamaError:
            return False
        return True

    async def tags(self, *, timeout: float = 3.0) -> list[dict[str, Any]]:
        resp = await self._request("GET", "/api/tags", "listar los modelos", timeout=timeout)
        if resp.status_code != 200:
            raise OllamaError(f"Ollama respondió {resp.status_code}: {self._error_text(resp)}")
        models = resp.json().get("models") or []
        return [m for m in models if isinstance(m, dict)]

    async def installed_models(self, *, timeout: float = 3.0) -> list[str]:
        return [str(m.get("name") or m.get("model")) for m in await self.tags(timeout=timeout)]

    async def loaded_models(self, *, timeout: float = 2.0) -> list[str]:
        """GET /api/ps: models resident in memory (VRAM/RAM) right now."""
        resp = await self._request("GET", "/api/ps", "listar los modelos cargados", timeout=timeout)
        if resp.status_code != 200:
            raise OllamaError(f"Ollama respondió {resp.status_code}: {self._error_text(resp)}")
        models = resp.json().get("models") or []
        return [str(m.get("name") or m.get("model")) for m in models if isinstance(m, dict)]

    # ------------------------------------------------------------------ pull
    async def pull(self, model: str, on_progress: ProgressFn | None = None) -> None:
        """Stream /api/pull; aggregates per-layer bytes into one (completed, total)."""
        self.check_url()
        layers: dict[str, tuple[int, int]] = {}
        t = httpx.Timeout(None, connect=self.connect_timeout, read=600.0)
        body = {"model": model, "stream": True}
        try:
            client = httpx.AsyncClient(base_url=self.base_url, timeout=t, transport=self._transport)
            async with client as c, c.stream("POST", "/api/pull", json=body) as resp:
                if resp.status_code != 200:
                    await resp.aread()
                    raise OllamaError(f"No se pudo descargar {model}: {self._error_text(resp)}")
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if msg.get("error"):
                        raise OllamaError(_pull_error_es(model, str(msg["error"])))
                    status = str(msg.get("status", ""))
                    digest = msg.get("digest")
                    if digest and msg.get("total"):
                        layers[digest] = (int(msg.get("completed") or 0), int(msg["total"]))
                    done = sum(c for c, _ in layers.values())
                    total = sum(t for _, t in layers.values())
                    if on_progress is not None:
                        res = on_progress(PullProgress(status, done, total))
                        if res is not None:
                            await res
                    if status == "success":
                        return
        except httpx.ConnectError as exc:
            raise OllamaUnavailableError(self.base_url) from exc
        except httpx.TimeoutException as exc:
            raise OllamaTimeoutError(f"descargar {model}", 600) from exc
        except httpx.HTTPError as exc:
            raise OllamaError(f"Se cortó la descarga de {model}: {exc}") from exc
        raise OllamaError(f"La descarga de {model} terminó sin confirmación de Ollama")

    # ------------------------------------------------------------------ chat
    async def chat(
        self,
        model: str,
        messages: list[dict[str, str]],
        *,
        format: dict[str, Any] | str | None = None,  # noqa: A002 - Ollama's field name
        temperature: float | None = None,
        num_ctx: int | None = 4096,
        keep_alive: str | int | None = "60s",
        think: bool | None = False,
        extra_options: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> ChatResult:
        options: dict[str, Any] = dict(extra_options or {})
        if temperature is not None:
            options["temperature"] = temperature
        if num_ctx:
            options["num_ctx"] = num_ctx
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
        if options:
            body["options"] = options
        if format is not None:
            body["format"] = format
        if keep_alive is not None:
            body["keep_alive"] = keep_alive
        if think is not None and supports_think_flag(model):
            body["think"] = think
        start = time.perf_counter()
        resp = await self._request(
            "POST", "/api/chat", f"responder con {model}", timeout=timeout, json=body
        )
        latency = int((time.perf_counter() - start) * 1000)
        if resp.status_code == 404:
            raise OllamaModelMissingError(model)
        if resp.status_code != 200:
            text = self._error_text(resp)
            if "not found" in text.lower() and "model" in text.lower():
                raise OllamaModelMissingError(model)
            raise OllamaError(f"Ollama falló con {model}: {text}")
        data = resp.json()
        msg = data.get("message") or {}
        return ChatResult(
            content=str(msg.get("content") or ""),
            model=str(data.get("model") or model),
            latency_ms=latency,
            eval_count=data.get("eval_count"),
            prompt_eval_count=data.get("prompt_eval_count"),
            raw=data,
        )

    async def unload(self, model: str) -> None:
        """keep_alive 0 frees the model's VRAM right away (best-effort)."""
        with contextlib.suppress(OllamaError):
            await self._request(
                "POST",
                "/api/generate",
                "liberar el modelo",
                timeout=10,
                json={"model": model, "keep_alive": 0},
            )

    async def unload_loaded(self) -> list[str]:
        """Unload every model /api/ps lists (best-effort; [] when Ollama is not running)."""
        try:
            loaded = await self.loaded_models()
        except OllamaError:
            return []
        for model in loaded:
            await self.unload(model)
        return loaded

    def unload_loaded_sync(self, *, timeout: float = 15.0) -> list[str]:
        """``unload_loaded`` from synchronous code (GpuBudget.acquire runs in engine threads, maybe
        under a running event loop): a short-lived thread with its own loop."""
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            try:
                return pool.submit(asyncio.run, self.unload_loaded()).result(timeout=timeout)
            except (concurrent.futures.TimeoutError, OllamaError):
                return []


def _pull_error_es(model: str, error: str) -> str:
    low = error.lower()
    if "file does not exist" in low or "manifest unknown" in low or "not found" in low:
        return f"El modelo {model} no existe en el registro de Ollama ({error})."
    if "forbidden" in low or "connect" in low or "dial tcp" in low or "timeout" in low:
        return (
            f"Ollama no pudo bajar {model}: sin acceso a registry.ollama.ai ({error}). Revisá la "
            f"conexión a internet, el proxy o el firewall y reintentá."
        )
    if "space" in low:
        return f"No hay espacio en disco para {model} ({error})."
    return f"Ollama no pudo descargar {model}: {error}"


def installed_models_sync(
    base_url: str = DEFAULT_URL,
    *,
    timeout: float = 1.0,
    transport: httpx.BaseTransport | None = None,
    allow_remote: bool = False,
) -> list[str] | None:
    """Models in /api/tags, or None when the service does not answer (GET /packs, doctor) or
    the URL is refused (not loopback, see module doc)."""
    if not allow_remote and not is_loopback_url(base_url):
        return None
    try:
        with httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport) as c:
            resp = c.get("/api/tags")
        if resp.status_code != 200:
            return None
        return [
            str(m.get("name") or m.get("model"))
            for m in resp.json().get("models") or []
            if isinstance(m, dict)
        ]
    except (httpx.HTTPError, ValueError):
        return None
