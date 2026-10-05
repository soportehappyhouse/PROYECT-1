"""Voice cleanup with DeepFilterNet 3 (pack voz-limpia; MIT/Apache-2.0; CPU ~real time).

The ``deepfilternet`` package is imported lazily. Weights come from the pack
(models/deepfilter/DeepFilterNet3/{config.ini, checkpoints/}), never from the user cache. Audio is
decoded with FFmpeg to 48 kHz mono PCM (DeepFilterNet's rate) and read/written with ``wave`` so
torchaudio's I/O backends are not needed. GPU use goes through the GPU budget; on CPU fallback the
df config DEVICE is pinned to cpu (df.utils.get_device reads it on every call).
"""

from __future__ import annotations

import logging
import tempfile
import threading
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import Settings
from .gpu import DEEPFILTER_VRAM_MB, GPU_FALLBACK_CPU, GpuBudget
from .media import to_wav, wav_to_mp3
from .packs import DEEPFILTER_MODEL, PackRequiredError, deepfilter_dir, extract_deepfilter
from .packs import module_present as _present

log = logging.getLogger("studio_workers")

SAMPLE_RATE = 48_000
BUDGET_KEY = "deepfilternet"

# (in_wav_48k_mono, out_wav, device) -> None. Tests inject a fake.
Backend = Callable[[Path, Path, str], None]


class DenoiseEngine:
    def __init__(
        self, settings: Settings, budget: GpuBudget | None = None, backend: Backend | None = None
    ) -> None:
        self.settings = settings
        self.budget = budget
        self._backend = backend
        self._state: dict[str, Any] = {}
        self._lock = threading.Lock()

    def available(self) -> bool:
        if self._backend is not None:
            return True
        root = self.settings.models_root
        return (
            _present("df")
            and _present("libdf")
            and (
                (deepfilter_dir(root) / "config.ini").is_file()
                or (root / "deepfilter" / f"{DEEPFILTER_MODEL}.zip").is_file()
            )
        )

    def unload(self) -> None:
        with self._lock:
            self._state.clear()

    # ----------------------------------------------------------------------- real backend
    def _df_backend(self, src: Path, dst: Path, device: str) -> None:
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415
        from df.config import config  # noqa: PLC0415
        from df.enhance import enhance, init_df  # noqa: PLC0415

        with self._lock:
            if self._state.get("device") != device:
                root = self.settings.models_root
                extract_deepfilter(root)
                try:
                    model, df_state, _ = init_df(
                        str(deepfilter_dir(root)), log_level="WARNING", log_file=None
                    )
                except SystemExit as exc:  # df calls exit(1) when the checkpoint is missing
                    raise RuntimeError("DeepFilterNet: no se encontro el checkpoint") from exc
                config.set("DEVICE", device if device == "cpu" else "cuda:0", str, "train")
                model = model.to(torch.device("cpu" if device == "cpu" else "cuda:0"))
                self._state = {"device": device, "model": model, "df": df_state}
            model, df_state = self._state["model"], self._state["df"]
            with wave.open(str(src), "rb") as wf:
                frames = wf.readframes(wf.getnframes())
            pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
            audio = torch.from_numpy(pcm.copy()).unsqueeze(0)
            out = enhance(model, df_state, audio)
            data = np.clip(out.squeeze(0).cpu().numpy(), -1.0, 1.0)
            with wave.open(str(dst), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(int(df_state.sr()))
                wf.writeframes((data * 32767.0).astype("<i2").tobytes())

    # ------------------------------------------------------------------------------ public
    def denoise(self, src: Path, out: Path) -> tuple[Path, str, list[str]]:
        """Clean src into out (.wav or .mp3). Returns (path, device, warnings)."""
        if not self.available():
            raise PackRequiredError("voz-limpia")
        warnings: list[str] = []
        device = "cpu"
        if self.settings.use_cuda and self.budget is not None and self._backend is None:
            decision = self.budget.acquire(BUDGET_KEY, DEEPFILTER_VRAM_MB, self.unload)
            device = decision.device
            warnings.extend(decision.warnings)
        backend = self._backend or self._df_backend
        out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
            wav48 = Path(tmp) / "in_48k.wav"
            to_wav(src, wav48, sample_rate=SAMPLE_RATE, mono=True)
            clean = Path(tmp) / "clean.wav"
            try:
                backend(wav48, clean, device)
            except Exception as exc:
                if device != "cuda":
                    raise
                log.warning("DeepFilterNet on CUDA failed (%s); retrying on CPU", exc)
                self.unload()
                if self.budget is not None:
                    self.budget.failed(BUDGET_KEY)
                warnings.append(GPU_FALLBACK_CPU)
                device = "cpu"
                backend(wav48, clean, device)
            if out.suffix.lower() == ".mp3":
                wav_to_mp3(clean, out)
            else:
                out.unlink(missing_ok=True)
                clean.replace(out)
        return out, device, list(dict.fromkeys(warnings))
