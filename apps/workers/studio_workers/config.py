"""Settings loaded from the monorepo-root .env (same file the Node api reads)."""

from functools import lru_cache
from pathlib import Path

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
    piper_default_voice: str = "es_AR-daniela-high"
    log_level: str = "info"

    def storage_path(self, relative: str) -> Path:
        """Resolve a STORAGE_DIR-relative path, refusing traversal outside storage."""
        root = (REPO_ROOT / self.storage_dir).resolve()
        target = (root / relative).resolve()
        if root not in target.parents and target != root:
            raise ValueError(f"Path escapes storage: {relative}")
        return target

    @property
    def models_root(self) -> Path:
        return (REPO_ROOT / self.models_dir).resolve()


@lru_cache
def get_settings() -> Settings:
    return Settings()
