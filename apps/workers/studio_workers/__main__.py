"""Entry point: `python -m studio_workers` (run from apps/workers with the venv active)."""

import uvicorn

from .config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "studio_workers.main:app",
        host=settings.workers_host,
        port=settings.workers_port,
        log_level=settings.log_level,
    )


if __name__ == "__main__":
    main()
