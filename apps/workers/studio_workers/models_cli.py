"""Model bootstrap CLI used by scripts/windows/setup.ps1 (same verified code as /models/download).

python -m studio_workers.models_cli --piper es_AR-daniela-high --whisper base --rvc-base
"""

from __future__ import annotations

import argparse
import json
import sys

from .config import get_settings
from .rvc_engine import download_base_assets
from .stt.engine import download_model as download_whisper
from .tts.piper_catalog import download_voice


def _print_progress(label: str):
    state = {"last": -1}

    def report(done: int, total: int | None) -> None:
        if not total:
            return
        pct = int(done * 100 / total)
        if pct // 10 != state["last"]:
            state["last"] = pct // 10
            print(f"  {label}: {pct}% ({done // 1_000_000} MB)", flush=True)

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download Studio models into MODELS_DIR")
    parser.add_argument("--piper", nargs="*", default=[], help="Piper voice ids")
    parser.add_argument("--whisper", nargs="*", default=[], help="faster-whisper sizes")
    parser.add_argument("--rvc-base", action="store_true", help="rmvpe.pt + hubert_base")
    parser.add_argument("--rvc-legacy-hubert", action="store_true", help="also hubert_base.pt")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--json", action="store_true", help="print a JSON summary at the end")
    args = parser.parse_args(argv)

    root = get_settings().models_root
    summary: dict[str, dict[str, str]] = {}
    failed = False

    for voice in args.piper:
        print(f"[piper] {voice}", flush=True)
        try:
            res = download_voice(root, voice, force=args.force, on_progress=_print_progress(voice))
            summary[f"piper:{voice}"] = {"status": "ok", "files": str(len(res))}
        except Exception as exc:
            failed = True
            summary[f"piper:{voice}"] = {"status": "error", "error": str(exc)}
            print(f"  ERROR: {exc}", file=sys.stderr)

    for size in args.whisper:
        print(f"[whisper] {size}", flush=True)
        try:
            path = download_whisper(root, size)
            summary[f"whisper:{size}"] = {"status": "ok", "path": str(path)}
        except Exception as exc:
            failed = True
            summary[f"whisper:{size}"] = {"status": "error", "error": str(exc)}
            print(f"  ERROR: {exc}", file=sys.stderr)

    if args.rvc_base or args.rvc_legacy_hubert:
        print("[rvc] base assets (rmvpe + hubert)", flush=True)
        try:
            res = download_base_assets(
                root,
                include_legacy=args.rvc_legacy_hubert,
                force=args.force,
                on_progress=_print_progress("rvc"),
            )
            summary["rvc:base"] = {"status": "ok", "files": str(len(res))}
        except Exception as exc:
            failed = True
            summary["rvc:base"] = {"status": "error", "error": str(exc)}
            print(f"  ERROR: {exc}", file=sys.stderr)

    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
