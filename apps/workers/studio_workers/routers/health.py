from importlib.util import find_spec

from fastapi import APIRouter

from ..config import get_settings
from ..schemas import Capabilities, WorkerHealth

router = APIRouter(tags=["health"])


def _installed(module: str) -> bool:
    return find_spec(module) is not None


@router.get("/health", response_model=WorkerHealth, response_model_by_alias=True)
def health() -> WorkerHealth:
    settings = get_settings()
    return WorkerHealth(
        cuda=settings.use_cuda,
        capabilities=Capabilities(
            whisper=_installed("faster_whisper"),
            piper=_installed("piper"),
            # TODO(module-d): detect the chosen RVC inference package + at least one model.
            rvc=False,
        ),
    )
