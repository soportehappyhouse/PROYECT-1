"""Model bootstrap CLI used by scripts/windows/setup.ps1 (incremental, resumable, verified).

python -m studio_workers.models_cli --check  --piper es_AR-daniela-high --whisper base --rvc-base
python -m studio_workers.models_cli --update --piper es_AR-daniela-high --whisper base --rvc-base

--check   lists what is present/missing (offline; nothing is downloaded) and exits 0.
--update  downloads only what is missing, also re-checking every group already recorded in
          models/manifest.json. Without --check/--update the listed models are downloaded the same
          way (present files are skipped). --force re-downloads everything listed.
Every file ends up in models/manifest.json (name, path, size, sha256/md5, source URL, date).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import httpx

from .config import get_settings
from .downloads import DownloadError
from .models_manifest import (
    Item,
    ItemStatus,
    Manifest,
    build_plan,
    groups_to_args,
    human_size,
)

CHECK = "✔"
STATE_LABEL = {
    "present": "presente",
    "missing": "falta",
    "partial": "parcial (se reanuda)",
    "corrupt": "corrupto (se vuelve a bajar)",
}


def _make_client() -> httpx.Client:
    return httpx.Client(follow_redirects=True, timeout=get_settings().http_timeout_sec)


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


def _out(text: str = "") -> None:
    # Windows consoles may not be UTF-8: never crash on the check mark.
    enc = sys.stdout.encoding or "utf-8"
    print(text.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


def _catalog(root: Path, offline: bool, client: httpx.Client | None) -> dict | None:
    from .tts import piper_catalog  # noqa: PLC0415

    if offline:
        return piper_catalog.cached_voices_json(root)
    return piper_catalog.load_voices_json(root, client=client)


def _merge_manifest_groups(args: argparse.Namespace, manifest: Manifest) -> None:
    extra = groups_to_args(manifest.groups())
    args.piper = list(dict.fromkeys([*args.piper, *extra["piper"]]))
    args.whisper = list(dict.fromkeys([*args.whisper, *extra["whisper"]]))
    args.rvc_base = args.rvc_base or extra["rvc_base"]
    args.rvc_legacy_hubert = args.rvc_legacy_hubert or extra["rvc_legacy"]


def _plan(args: argparse.Namespace, root: Path, catalog: dict | None) -> list[Item]:
    return build_plan(
        root,
        piper=args.piper,
        whisper=args.whisper,
        rvc_base=args.rvc_base,
        rvc_legacy=args.rvc_legacy_hubert,
        catalog=catalog,
    )


def print_table(rows: list[ItemStatus]) -> None:
    _out(f"  {'Estado':<32} {'Modelo':<40} {'Tamano':>10}")
    _out("  " + "-" * 84)
    for r in rows:
        mark = CHECK if r.state == "present" else "x"
        size = r.size if r.state == "present" else r.expected_size
        name = f"{r.group.split(':')[0]}: {r.name}"
        _out(f"  {mark} {STATE_LABEL.get(r.state, r.state):<30} {name:<40} {human_size(size):>10}")
    present = sum(r.state == "present" for r in rows)
    _out("  " + "-" * 84)
    _out(f"  {present} presentes, {len(rows) - present} por descargar")


def run_check(
    plan: list[Item], root: Path, manifest: Manifest, deep: bool, write: bool = True
) -> list[ItemStatus]:
    rows = [item.status(root, manifest, deep=deep) for item in plan]
    if write and manifest.files:
        manifest.save()
    return rows


def run_download(
    plan: list[Item],
    root: Path,
    manifest: Manifest,
    *,
    force: bool,
    deep: bool,
    client: httpx.Client | None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for item in plan:
        status = item.status(root, manifest, deep=deep)
        row: dict[str, Any] = {"group": status.group, "name": status.name, "path": status.path}
        if status.state == "present" and not force:
            _out(f"  {CHECK} ya descargado, se omite: {status.name} ({human_size(status.size)})")
            results.append({**row, "action": "skipped", "size": status.size})
            continue
        verb = {"partial": "reanudando", "corrupt": "re-descargando"}.get(status.state, "bajando")
        _out(f"  [{status.group}] {verb} {status.name}")
        started = time.monotonic()
        try:
            size = item.fetch(root, manifest, client, _print_progress(status.name))
            manifest.save()  # after every file: an interrupted run keeps what it finished
            secs = round(time.monotonic() - started, 1)
            _out(f"  {CHECK} {status.name}: {human_size(size)} verificado ({secs} s)")
            results.append({**row, "action": "downloaded", "size": size, "seconds": secs})
        except (DownloadError, OSError, ValueError, RuntimeError) as exc:
            print(f"  ERROR: {exc}", file=sys.stderr, flush=True)
            results.append({**row, "action": "failed", "error": str(exc)})
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download Studio models into MODELS_DIR")
    parser.add_argument("--piper", nargs="*", default=[], help="Piper voice ids")
    parser.add_argument("--whisper", nargs="*", default=[], help="faster-whisper sizes")
    parser.add_argument("--rvc-base", action="store_true", help="rmvpe.pt + hubert_base")
    parser.add_argument("--rvc-legacy-hubert", action="store_true", help="also hubert_base.pt")
    parser.add_argument("--check", action="store_true", help="list present/missing; no downloads")
    parser.add_argument(
        "--update", action="store_true", help="only fetch what is missing (+ manifest groups)"
    )
    parser.add_argument("--verify", action="store_true", help="re-hash files already on disk")
    parser.add_argument(
        "--no-write", action="store_true", help="with --check: do not update manifest.json"
    )
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    parser.add_argument("--json", action="store_true", help="print a JSON summary at the end")
    parser.add_argument("--report", type=Path, help="write the JSON summary to this file")
    args = parser.parse_args(argv)
    if args.force and args.update:
        parser.error("--force y --update son incompatibles")

    root = get_settings().models_root
    if not args.no_write:
        root.mkdir(parents=True, exist_ok=True)
    manifest = Manifest.load(root)
    if args.update or (args.check and not (args.piper or args.whisper or args.rvc_base)):
        _merge_manifest_groups(args, manifest)

    summary: dict[str, Any]
    if args.check:
        try:
            plan = _plan(args, root, _catalog(root, offline=True, client=None))
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 2
        rows = run_check(plan, root, manifest, args.verify, write=not args.no_write)
        print_table(rows)
        present = sum(r.state == "present" for r in rows)
        summary = {
            "mode": "check",
            "present": present,
            "missing": len(rows) - present,
            "items": [asdict(r) for r in rows],
        }
        code = 0
    else:
        with _make_client() as client:
            try:
                plan = _plan(args, root, _catalog(root, offline=False, client=client))
            except ValueError as exc:
                print(f"ERROR: {exc}", file=sys.stderr)
                return 2
            results = run_download(
                plan, root, manifest, force=args.force, deep=args.verify, client=client
            )
        manifest.save()
        counts = {
            k: sum(r["action"] == k for r in results) for k in ("skipped", "downloaded", "failed")
        }
        _out(
            f"  Modelos: {counts['skipped']} ya estaban, {counts['downloaded']} descargados, "
            f"{counts['failed']} con error  (manifiesto: {manifest.path})"
        )
        summary = {"mode": "update" if args.update else "download", **counts, "items": results}
        code = 1 if counts["failed"] else 0

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
