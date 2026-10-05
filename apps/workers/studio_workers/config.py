"""Settings loaded from the monorepo-root .env (same file the Node api reads)."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    workers_host: str = "127.0.0.1"
    workers_port: int = 8001
    storage_dir: Path = Path("./storage")
    models_dir: Path = Path("./models")
    use_cuda: bool = False
    whisper_model: str = "small"
    # "auto" -> int8 on CPU, float16 on CUDA.
    whisper_compute_type: str = "auto"
    piper_default_voice: str = "es_AR-daniela-high"
    # Empty = resolve from PATH (shutil.which).
    ffmpeg_path: str = ""
    log_level: str = "info"
    # Optional cloud TTS providers: enabled only when the key is non-empty.
    elevenlabs_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    openai_tts_model: str = "gpt-4o-mini-tts"
    elevenlabs_model: str = "eleven_multilingual_v2"
    # Network timeout (seconds) for model downloads and cloud TTS calls.
    http_timeout_sec: float = 60.0
    # Sprint 2: GPL-isolated RVM runner. Empty = apps/workers/.venv-gpl. GPL_PYTHON overrides the
    # interpreter that runs `python -m vision_gpl.rvm` (development/tests).
    gpl_venv_dir: str = ""
    gpl_python: str = ""

    @property
    def storage_root(self) -> Path:
        return (REPO_ROOT / self.storage_dir).resolve()

    @property
    def models_root(self) -> Path:
        return (REPO_ROOT / self.models_dir).resolve()

    def storage_path(self, relative: str) -> Path:
        """Resolve a STORAGE_DIR-relative path, refusing traversal outside storage."""
        return _resolve_inside(self.storage_root, relative, "storage")

    def models_path(self, relative: str) -> Path:
        """Resolve a MODELS_DIR-relative path, refusing traversal outside models."""
        return _resolve_inside(self.models_root, relative, "models")

    def storage_relative(self, absolute: Path) -> str:
        """Inverse of storage_path(): posix path relative to STORAGE_DIR."""
        return absolute.resolve().relative_to(self.storage_root).as_posix()

    def secret(self, name: str) -> str | None:
        value = getattr(self, name, None)
        if value is None:
            return None
        raw = value.get_secret_value() if isinstance(value, SecretStr) else str(value)
        return raw.strip() or None


def _resolve_inside(root: Path, relative: str, label: str) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"Path must be relative to {label} without '..': {relative}")
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"Path escapes {label}: {relative}")
    return target


@lru_cache
def get_settings() -> Settings:
    return Settings()
