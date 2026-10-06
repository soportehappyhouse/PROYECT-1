"""Model bootstrap CLI used by scripts/windows/setup.ps1 (incremental, resumable, verified).

python -m studio_workers.models_cli --check  --piper es_AR-daniela-high --whisper base --rvc-base
python -m studio_workers.models_cli --update --piper es_AR-daniela-high --whisper base --rvc-base

python -m studio_workers.models_cli --packs list
python -m studio_workers.models_cli --packs download core whisper-turbo
python -m studio_workers.models_cli --packs all          (setup.ps1 -Full: every pack, in sequence;
                                                          licence-gated packs only when accepted)
python -m studio_workers.models_cli --tool-venv facefusion|chatterbox status|ensure|verify [--json]
python -m studio_workers.models_cli --licences --json    (read-only licence mirror, doctor.ps1)

--check   lists what is present/missing (offline; nothing is downloaded) and exits 0.
--update  downloads only what is missing, also re-checking every group already recorded in
          models/manifest.json. Without --check/--update the listed models are downloaded the same
          way (present files are skipped). --force re-downloads everything listed.
Every file ends up in models/manifest.json (name, path, size, sha256/md5, source URL, date).
"""

from __future__ import annotations

import argparse
import contextlib
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


def run_packs(actions: list[str], root: Path, args: argparse.Namespace) -> int:
    """--packs list | download <id>... | all (sequential; a failed pack does not stop the rest)."""
    from . import packs as packs_mod  # noqa: PLC0415

    verb, ids = actions[0], actions[1:]
    with contextlib.suppress(OSError):  # models/packs.json, also without the service running
        packs_mod.write_registry(root)
    if verb == "list":
        rows = packs_mod.list_packs(root)
        _out(f"  {'Paquete':<16} {'Estado':<12} {'Tamano':>10}  Nombre")
        _out("  " + "-" * 84)
        for r in rows:
            state = "instalado" if r["installed"] else "parcial" if r["partial"] else "falta"
            mark = CHECK if r["installed"] else "x"
            _out(
                f"  {mark} {r['id']:<14} {state:<12} {human_size(r['size_bytes']):>10}"
                f"  {r['name_es']}"
            )
        summary: dict[str, Any] = {"mode": "packs-list", "packs": rows}
        code = 0
    else:
        if verb == "all":
            ids = list(packs_mod.PACKS)
        elif verb != "download" or not ids:
            print("ERROR: uso --packs list | download <id>... | all", file=sys.stderr)
            return 2
        unknown = [i for i in ids if i not in packs_mod.PACKS]
        if unknown:
            print(f"ERROR: paquete(s) desconocido(s): {', '.join(unknown)}", file=sys.stderr)
            print(f"  disponibles: {', '.join(packs_mod.PACKS)}", file=sys.stderr)
            return 2
        results: list[dict[str, Any]] = []
        with _make_client() as client:
            catalog = _catalog(root, offline=False, client=client)
            for pid in ids:
                pack = packs_mod.PACKS[pid]
                _out(f"[{pid}] {pack.name_es}")
                gate = getattr(pack, "licence_gate", None)
                if gate and not _licence_ok(gate):
                    # Criterion 5: nothing of the face swap on disk without the on-screen licence.
                    reason = "requiere aceptar la licencia en Studio (Ajustes > Paquetes de IA)"
                    _out(f"  se omite: {reason}")
                    action = "skipped" if verb == "all" else "failed"
                    results.append({"id": pid, "action": action, "reason": "licence_required",
                                    "licence": gate, "error": reason})  # fmt: skip
                    continue
                if (
                    verb == "all"
                    and pack.ollama_models is not None
                    and packs_mod.ollama_installed_models() is None
                ):  # -Full without Ollama (-SkipOllama): not an error, the assistant stays off
                    _out("  Ollama no responde: se omite (instalalo con setup.ps1)")
                    results.append({"id": pid, "action": "skipped", "reason": "ollama_down"})
                    continue
                report_progress = _print_progress(pid)
                started = time.monotonic()
                try:
                    rep = packs_mod.install_pack(
                        pid,
                        root,
                        on_progress=lambda d, t, _f, rp=report_progress: rp(d, t),
                        on_line=lambda line: _out(f"  {line.rstrip()}"),
                        client=client,
                        catalog=catalog,
                        force=args.force,
                    )
                    secs = round(time.monotonic() - started, 1)
                    action = "skipped" if not (rep.downloaded or rep.pip) else "installed"
                    _out(f"  {CHECK} {pid}: listo ({secs} s)")
                    results.append({"id": pid, "action": action, **asdict(rep), "seconds": secs})
                except Exception as exc:  # next pack continues; setup shows the failure
                    print(f"  ERROR [{pid}]: {exc}", file=sys.stderr, flush=True)
                    results.append({"id": pid, "action": "failed", "error": str(exc)})
        counts = {
            k: sum(r["action"] == k for r in results) for k in ("skipped", "installed", "failed")
        }
        _out(
            f"  Paquetes: {counts['skipped']} ya estaban, {counts['installed']} instalados, "
            f"{counts['failed']} con error"
        )
        summary = {"mode": "packs-download", **counts, "items": results}
        code = 1 if counts["failed"] else 0
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    return code


def _licence_ok(licence_id: str) -> bool:
    from .toolvenv import licence_accepted  # noqa: PLC0415

    return licence_accepted(licence_id)


def run_tool_venv(tool: str, action: str, args: argparse.Namespace) -> int:
    """--tool-venv facefusion|chatterbox status|ensure|verify (setup.ps1 «Herramientas aisladas»
    and doctor.ps1). Same code as the packs (toolvenv.ensure). verify --no-write: doctor."""
    from . import toolvenv  # noqa: PLC0415

    settings = get_settings()
    summary: dict[str, Any] = {"mode": f"tool-venv-{action}", "tool": tool}
    code = 0
    if action == "ensure":
        try:
            summary["action"] = toolvenv.ensure(
                tool,  # type: ignore[arg-type]
                use_cuda=settings.use_cuda,
                on_line=lambda line: _out("  " + line.rstrip()),
                force=args.force,
            )
        except Exception as exc:
            summary["action"] = "failed"
            summary["error"] = str(exc)
            print(f"ERROR: {exc}", file=sys.stderr)
            code = 1
    elif action == "verify":
        res = toolvenv.verify(tool, record=not args.no_write)  # type: ignore[arg-type]
        summary.update({k: v for k, v in res.items() if k not in ("check",)})
        summary["check"] = res.get("check")
    summary.update({k: v for k, v in toolvenv.status(tool).items() if k not in summary})  # type: ignore[arg-type]
    summary["state"] = summary.get("state") or "missing"
    base = toolvenv.find_base_python(tool)  # type: ignore[arg-type]
    summary["base_python"] = base[0] if base else None
    summary["base_python_version"] = base[1] if base else None
    pack_id = toolvenv.spec_of(tool).pack_id
    summary["pack_id"] = pack_id
    gate = getattr(_pack_or_none(pack_id), "licence_gate", None)
    summary["licence"] = gate
    summary["licence_accepted"] = toolvenv.licence_accepted(gate) if gate else None
    if action == "verify" and summary.get("state") == "broken" and code == 0:
        code = 1
    _out(
        f"  tools/{tool}/.venv: {toolvenv.STATE_ES.get(summary['state'], summary['state'])}"
        f" ({summary.get('dir') or summary.get('python')})"
    )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    return code


def _pack_or_none(pack_id: str) -> Any:
    from . import packs as packs_mod  # noqa: PLC0415

    return packs_mod.PACKS.get(pack_id)


def run_licences(args: argparse.Namespace) -> int:
    """--licences: the read-only licence mirror storage/consent/licences.json (doctor.ps1)."""
    from .toolvenv import licence_status  # noqa: PLC0415

    st = licence_status()
    for lid, row in st["licences"].items():
        _out(f"  licencia {lid}: {'aceptada' if row['accepted'] else 'no aceptada'}")
    if args.json:
        print(json.dumps(st, ensure_ascii=False))
    return 0


def run_gpl_venv(action: str, args: argparse.Namespace) -> int:
    """--gpl-venv status|ensure: setup.ps1 step for .venv-gpl (same code as the matting pack)."""
    from .packs import _gpl_venv_dir  # noqa: PLC0415
    from .vision import gpl  # noqa: PLC0415

    settings = get_settings()
    venv = _gpl_venv_dir()
    summary: dict[str, Any] = {"mode": f"gpl-venv-{action}", "dir": str(venv)}
    code = 0
    if action == "ensure":
        try:
            summary["action"] = gpl.ensure_venv(
                venv, use_cuda=settings.use_cuda, on_line=lambda line: _out("  " + line.rstrip()),
                force=args.force,
            )  # fmt: skip
        except Exception as exc:
            summary["action"] = "failed"
            summary["error"] = str(exc)
            print(f"ERROR: {exc}", file=sys.stderr)
            code = 1
    summary.update(gpl.status(venv))
    _out(f"  .venv-gpl: {summary['state']} ({venv})")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    return code


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
    parser.add_argument(
        "--packs",
        nargs="+",
        metavar="ACCION",
        help="paquetes de IA: list | download <id>... | all (ver studio_workers/packs.py)",
    )
    parser.add_argument(
        "--gpl-venv",
        choices=("status", "ensure"),
        help="entorno aislado GPL apps/workers/.venv-gpl (recorte RVM): status | ensure",
    )
    parser.add_argument(
        "--tool-venv",
        nargs=2,
        metavar=("HERRAMIENTA", "ACCION"),
        help="entorno aislado tools/<id>/.venv: facefusion|chatterbox status|ensure|verify",
    )
    parser.add_argument(
        "--licences", action="store_true", help="estado del espejo de licencias (doctor)"
    )
    args = parser.parse_args(argv)
    if args.tool_venv:
        tool, action = args.tool_venv
        if tool not in ("facefusion", "chatterbox") or action not in ("status", "ensure", "verify"):
            parser.error("--tool-venv facefusion|chatterbox status|ensure|verify")
        return run_tool_venv(tool, action, args)
    if args.licences:
        return run_licences(args)
    if args.gpl_venv:
        return run_gpl_venv(args.gpl_venv, args)
    if args.packs:
        root = get_settings().models_root
        root.mkdir(parents=True, exist_ok=True)
        return run_packs(args.packs, root, args)
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
