"""Entry point: `python -m studio_workers` (used by scripts/windows/start.ps1)."""

import logging

import uvicorn

from .config import get_settings

# LOG_LEVEL in .env uses pino names (shared with the api); map them to uvicorn/logging levels.
_LEVELS = {"fatal": "critical", "silent": "critical", "warn": "warning"}


def uvicorn_level(level: str) -> str:
    level = level.lower().strip()
    level = _LEVELS.get(level, level)
    return level if level in {"critical", "error", "warning", "info", "debug", "trace"} else "info"


def main() -> None:
    settings = get_settings()
    level = uvicorn_level(settings.log_level)
    logging.basicConfig(level=logging.DEBUG if level in ("debug", "trace") else logging.INFO)
    uvicorn.run(
        "studio_workers.main:app",
        host=settings.workers_host,
        port=settings.workers_port,
        log_level=level,
    )


if __name__ == "__main__":
    main()
