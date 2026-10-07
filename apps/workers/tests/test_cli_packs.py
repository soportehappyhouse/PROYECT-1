"""Sprint 4 (M3): licence-gated packs in models_cli --packs all / download and POST
/packs/{id}/download (criterion 5: nothing of the face swap on disk without the on-screen licence),
plus models_cli --tool-venv / --licences. Independent of M1's real faceswap pack: a fake gated
pack is registered."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_workers import models_cli, packs, toolvenv
from studio_workers.routers import packs as packs_router

GATED = "gated-test"


@pytest.fixture
def gated(dirs, monkeypatch: pytest.MonkeyPatch) -> list[str]:  # type: ignore[no-untyped-def]
    monkeypatch.setitem(
        packs.PACKS,
        GATED,
        packs.Pack(
            id=GATED,
            name_es="Pack con licencia (prueba)",
            description_es="",
            group="faceswap",
            license="NC",
            required_by=("test.gated",),
            licence_gate="faceswap",
        ),
    )
    done: list[str] = []

    def fake_install(pid, root, **kw):  # type: ignore[no-untyped-def]
        done.append(pid)
        return packs.InstallReport(pid, downloaded=["x"])

    monkeypatch.setattr(packs, "install_pack", fake_install)
    monkeypatch.setattr(packs_router, "install_pack", fake_install)
    monkeypatch.setattr(models_cli, "_catalog", lambda *a, **k: None)
    monkeypatch.setattr(packs, "ollama_installed_models", lambda *a, **k: [])
    return done


def accept(storage: Path, version: str = "2026-10-06") -> None:
    mirror = storage / "consent" / "licences.json"
    mirror.parent.mkdir(parents=True, exist_ok=True)
    mirror.write_text(
        json.dumps({"accepted": {"faceswap": {"text_version": version, "accepted_at": "x"}}}),
        "utf-8",
    )


def test_packs_all_skips_gated_without_licence(dirs, gated, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    storage, _models = dirs
    report = tmp_path / "r.json"
    assert models_cli.main(["--packs", "all", "--report", str(report)]) == 0
    assert GATED not in gated
    assert all(not packs.PACKS[p].licence_gate for p in gated)
    rows = json.loads(report.read_text("utf-8"))["items"]
    row = next(r for r in rows if r["id"] == GATED)
    assert row["action"] == "skipped" and row["reason"] == "licence_required"
    # explicit download of a gated pack without the licence: refused (exit 1), nothing installed
    gated.clear()
    assert models_cli.main(["--packs", "download", GATED]) == 1
    assert gated == []
    # with the mirror (api wrote it after the on-screen acceptance) it is included
    accept(storage)
    assert models_cli.main(["--packs", "all"]) == 0
    assert GATED in gated
    # an old text version does not count
    gated.clear()
    accept(storage, "2020-01-01")
    assert models_cli.main(["--packs", "all"]) == 0
    assert GATED not in gated


def test_workers_route_403_licence_required(client: TestClient, dirs, gated) -> None:  # type: ignore[no-untyped-def]
    storage, _ = dirs
    res = client.post(f"/packs/{GATED}/download")
    assert res.status_code == 403, res.text
    body = res.json()
    assert body["code"] == "LICENCE_REQUIRED"
    assert body["details"] == {"licenceId": "faceswap", "text_version": "2026-10-06"}
    assert "licencia" in body["detail"]
    accept(storage)
    res = client.post(f"/packs/{GATED}/download")
    assert res.status_code == 200 and "task_id" in res.json()
    # ungated packs are not affected
    assert client.post("/packs/scenes/download").status_code == 200


def test_cli_tool_venv_status_json(dirs, capsys, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("CHATTERBOX_PYTHON", "")
    assert models_cli.main(["--tool-venv", "chatterbox", "status", "--json"]) == 0
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["tool"] == "chatterbox" and data["mode"] == "tool-venv-status"
    assert data["state"] in ("missing", "ready", "stale", "broken")
    assert data["pack_id"] == "tts-chatterbox"
    with pytest.raises(SystemExit):
        models_cli.main(["--tool-venv", "nope", "status"])


def test_cli_tool_venv_ensure_uses_toolvenv(dirs, capsys, monkeypatch, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    calls: list[tuple[str, bool]] = []

    def fake_ensure(tool, *, use_cuda, on_line=None, force=False, **_):  # type: ignore[no-untyped-def]
        calls.append((tool, force))
        return "omitido"

    monkeypatch.setattr(toolvenv, "ensure", fake_ensure)
    report = tmp_path / "tv.json"
    # open point D: FaceFusion's venv needs the accepted licence, like the pack route (403)
    assert models_cli.main(["--tool-venv", "facefusion", "ensure", "--report", str(report)]) == 3
    refused = json.loads(report.read_text("utf-8"))
    assert calls == [] and refused["action"] == "licence_required"
    assert "aceptar su licencia" in refused["error"] and refused["licence"] == "faceswap"
    accept(dirs[0])
    assert models_cli.main(["--tool-venv", "facefusion", "ensure", "--report", str(report)]) == 0
    assert calls == [("facefusion", False)]
    data = json.loads(report.read_text("utf-8"))
    assert data["action"] == "omitido" and data["licence"] == "faceswap"

    def boom(tool, **_):  # type: ignore[no-untyped-def]
        raise toolvenv.ToolError("pip falló")

    monkeypatch.setattr(toolvenv, "ensure", boom)
    assert models_cli.main(["--tool-venv", "chatterbox", "ensure", "--report", str(report)]) == 1
    assert json.loads(report.read_text("utf-8"))["action"] == "failed"


def test_cli_licences(dirs, capsys) -> None:  # type: ignore[no-untyped-def]
    storage, _ = dirs
    assert models_cli.main(["--licences", "--json"]) == 0
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["licences"]["faceswap"]["accepted"] is False and data["exists"] is False
    accept(storage)
    assert models_cli.main(["--licences", "--json"]) == 0
    data = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert data["licences"]["faceswap"]["accepted"] is True and data["readable"] is True
