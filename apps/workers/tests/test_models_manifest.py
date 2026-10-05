"""Incremental model installs: manifest, resumable downloads (HTTP Range), --check / --update."""

import hashlib
import json
from pathlib import Path

import httpx
import pytest

from studio_workers import models_cli, models_manifest
from studio_workers.downloads import DownloadError, Expected
from studio_workers.models_manifest import FileItem, Manifest, WhisperItem, fetch_file
from studio_workers.tts import piper_catalog

URL = "https://hf.test/f.bin"


class _Broken(httpx.SyncByteStream):
    """Body that dies after `keep` bytes (simulates a dropped connection)."""

    def __init__(self, data: bytes, keep: int) -> None:
        self.data, self.keep = data, keep

    def __iter__(self):
        yield self.data[: self.keep]
        raise httpx.ReadError("conexion cortada")


class Server:
    """Range-aware mock (206 / 416), optional HF X-Linked-Etag, optional mid-stream failure."""

    def __init__(self, files: dict[str, bytes], *, ignore_range=False, etag=False) -> None:
        self.files, self.ignore_range, self.etag = files, ignore_range, etag
        self.ranges: list[str | None] = []
        self.cut_after: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = self.files.get(str(request.url))
        rng = request.headers.get("range")
        self.ranges.append(rng)
        if body is None:
            return httpx.Response(404)
        headers = {}
        if self.etag:
            headers["x-linked-etag"] = '"' + hashlib.sha256(body).hexdigest() + '"'
        if rng and not self.ignore_range:
            start = int(rng.removeprefix("bytes=").rstrip("-"))
            if start >= len(body):
                return httpx.Response(
                    416, headers={**headers, "content-range": f"bytes */{len(body)}"}
                )
            chunk = body[start:]
            headers["content-range"] = f"bytes {start}-{len(body) - 1}/{len(body)}"
            headers["content-length"] = str(len(chunk))
            return httpx.Response(206, content=chunk, headers=headers)
        headers["content-length"] = str(len(body))
        if self.cut_after is not None:
            keep, self.cut_after = self.cut_after, None
            return httpx.Response(200, headers=headers, stream=_Broken(body, keep))
        return httpx.Response(200, content=body, headers=headers)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def test_fetch_resumes_partial_file_with_range(tmp_path: Path) -> None:
    data = bytes(range(256)) * 40
    srv = Server({URL: data}, etag=True)
    dest = tmp_path / "f.bin"
    (tmp_path / "f.bin.part").write_bytes(data[:4000])
    res = fetch_file(URL, dest, Expected(size_bytes=len(data)), client=srv.client())
    assert srv.ranges == ["bytes=4000-"]
    assert res.resumed_from == 4000 and res.size == len(data)
    assert dest.read_bytes() == data and not (tmp_path / "f.bin.part").exists()
    assert res.sha256 == hashlib.sha256(data).hexdigest()


def test_interrupted_download_keeps_part_then_resumes(tmp_path: Path) -> None:
    data = b"z" * 5000
    srv = Server({URL: data})
    srv.cut_after = 1200
    dest = tmp_path / "f.bin"
    with pytest.raises(DownloadError, match="se reanuda"):
        fetch_file(URL, dest, client=srv.client())
    assert (tmp_path / "f.bin.part").stat().st_size == 1200 and not dest.exists()
    res = fetch_file(URL, dest, client=srv.client())
    assert srv.ranges == [None, "bytes=1200-"] and res.resumed_from == 1200
    assert dest.read_bytes() == data


def test_server_ignoring_range_restarts_from_zero(tmp_path: Path) -> None:
    data = b"q" * 3000
    srv = Server({URL: data}, ignore_range=True)
    (tmp_path / "f.bin.part").write_bytes(b"q" * 1000)
    fetch_file(URL, tmp_path / "f.bin", client=srv.client())
    assert (tmp_path / "f.bin").read_bytes() == data


def test_complete_part_is_finished_with_416(tmp_path: Path) -> None:
    data = b"k" * 2048
    srv = Server({URL: data})
    (tmp_path / "f.bin.part").write_bytes(data)
    res = fetch_file(URL, tmp_path / "f.bin", Expected(size_bytes=2048), client=srv.client())
    assert res.size == 2048 and (tmp_path / "f.bin").read_bytes() == data


def test_corrupt_resumed_part_retries_from_zero(tmp_path: Path) -> None:
    data = b"good" * 1000
    srv = Server({URL: data})
    (tmp_path / "f.bin.part").write_bytes(b"BAD!" * 100)
    exp = Expected(size_bytes=len(data), md5=hashlib.md5(data).hexdigest())
    fetch_file(URL, tmp_path / "f.bin", exp, client=srv.client())
    assert srv.ranges == ["bytes=400-", None]
    assert (tmp_path / "f.bin").read_bytes() == data


def test_hf_sha256_mismatch_is_rejected(tmp_path: Path) -> None:
    srv = Server({URL: b"abc" * 100}, etag=True)
    srv.files[URL] = b"abc" * 100

    def tamper(request: httpx.Request) -> httpx.Response:
        res = srv.handler(request)
        return httpx.Response(200, content=b"evil" * 75, headers=dict(res.headers))

    client = httpx.Client(transport=httpx.MockTransport(tamper))
    with pytest.raises(DownloadError, match="sha256"):
        fetch_file(URL, tmp_path / "f.bin", client=client)
    assert not (tmp_path / "f.bin").exists() and not (tmp_path / "f.bin.part").exists()


def test_existing_file_is_trusted_via_manifest_without_rehash(tmp_path: Path, monkeypatch) -> None:
    data = b"m" * 1500
    (tmp_path / "piper").mkdir()
    (tmp_path / "piper" / "v.onnx").write_bytes(data)
    item = FileItem(
        "piper:v", "v.onnx", "piper/v.onnx", URL, Expected(md5=hashlib.md5(data).hexdigest())
    )
    manifest = Manifest.load(tmp_path)
    assert item.status(tmp_path, manifest).state == "present"
    entry = manifest.get("piper/v.onnx")
    assert entry and entry["sha256"] == hashlib.sha256(data).hexdigest() and entry["adopted"]
    manifest.save()

    def no_hash(_p):
        raise AssertionError("should not re-hash a trusted file")

    monkeypatch.setattr(models_manifest, "hash_file", no_hash)
    again = Manifest.load(tmp_path)
    assert item.status(tmp_path, again).state == "present"


def test_checksum_mismatch_triggers_redownload(tmp_path: Path) -> None:
    data = b"v" * 2000
    srv = Server({URL: data})
    (tmp_path / "piper").mkdir()
    (tmp_path / "piper" / "v.onnx").write_bytes(b"x" * 2000)  # right size, wrong content
    item = FileItem(
        "piper:v",
        "v.onnx",
        "piper/v.onnx",
        URL,
        Expected(size_bytes=2000, md5=hashlib.md5(data).hexdigest()),
    )
    manifest = Manifest.load(tmp_path)
    assert item.status(tmp_path, manifest).state == "corrupt"
    rows = models_cli.run_download(
        [item], tmp_path, manifest, force=False, deep=False, client=srv.client()
    )
    assert rows[0]["action"] == "downloaded"
    assert (tmp_path / "piper" / "v.onnx").read_bytes() == data
    assert manifest.get("piper/v.onnx")["md5"] == hashlib.md5(data).hexdigest()


# --------------------------------------------------------------------------------- CLI


def _voice_catalog(models: Path, onnx: bytes, cfg: bytes) -> dict[str, bytes]:
    folder = "es/es_AR/daniela/high"
    catalog = {
        "es_AR-daniela-high": {
            "files": {
                f"{folder}/es_AR-daniela-high.onnx": {
                    "size_bytes": len(onnx),
                    "md5_digest": hashlib.md5(onnx).hexdigest(),
                },
                f"{folder}/es_AR-daniela-high.onnx.json": {
                    "size_bytes": len(cfg),
                    "md5_digest": hashlib.md5(cfg).hexdigest(),
                },
            }
        }
    }
    (models / "piper").mkdir(parents=True, exist_ok=True)
    (models / "piper" / "voices.json").write_text(json.dumps(catalog), "utf-8")
    base = piper_catalog.PIPER_VOICES_BASE
    return {
        f"{base}/{folder}/es_AR-daniela-high.onnx": onnx,
        f"{base}/{folder}/es_AR-daniela-high.onnx.json": cfg,
    }


def test_cli_check_then_update_only_fetches_missing(dirs, monkeypatch, capsys) -> None:
    _, models = dirs
    onnx, cfg = b"o" * 1_200_000, b"{}" + b" " * 300
    routes = _voice_catalog(models, onnx, cfg)
    # the .onnx.json was already downloaded by an older installer
    (models / "piper" / "es_AR-daniela-high.onnx.json").write_bytes(cfg)
    srv = Server(routes)
    monkeypatch.setattr(models_cli, "_make_client", srv.client)

    report = models / "check.json"
    args = ["--piper", "es_AR-daniela-high", "--report", str(report)]
    assert models_cli.main(["--check", *args]) == 0
    out = capsys.readouterr().out
    assert "1 presentes, 1 por descargar" in out and "falta" in out
    assert srv.ranges == []  # --check never downloads
    assert json.loads(report.read_text())["missing"] == 1

    assert models_cli.main(["--update", *args]) == 0
    out = capsys.readouterr().out
    assert "ya descargado, se omite: es_AR-daniela-high.onnx.json" in out
    summary = json.loads(report.read_text())
    assert (summary["skipped"], summary["downloaded"], summary["failed"]) == (1, 1, 0)
    manifest = json.loads((models / "manifest.json").read_text())
    entry = manifest["files"]["piper/es_AR-daniela-high.onnx"]
    assert entry["size"] == len(onnx) and entry["md5"] == hashlib.md5(onnx).hexdigest()
    assert entry["sha256"] == hashlib.sha256(onnx).hexdigest() and entry["source"].startswith(
        "https://"
    )

    # second run: everything skipped, no HTTP; --update with no args re-checks manifest groups
    srv.ranges.clear()
    assert models_cli.main(["--update", "--report", str(report)]) == 0
    assert srv.ranges == []
    assert json.loads(report.read_text())["skipped"] == 2


def test_cli_reports_failures(dirs, monkeypatch, capsys) -> None:
    _, models = dirs
    _voice_catalog(models, b"o" * 1_200_000, b"{}" + b" " * 300)
    monkeypatch.setattr(models_cli, "_make_client", Server({}).client)  # every file 404s

    def fake_whisper(root: Path, size: str) -> Path:
        snap = root / "whisper" / "models--Systran--faster-whisper-base" / "snapshots" / "abc"
        snap.mkdir(parents=True)
        (snap / "model.bin").write_bytes(b"w" * 100)
        (snap / "config.json").write_text("{}")
        return snap

    monkeypatch.setattr(models_manifest, "WhisperItem", _with_downloader(fake_whisper))
    code = models_cli.main(["--piper", "es_AR-daniela-high", "--whisper", "base", "--json"])
    assert code == 1
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    actions = {(r["group"], r["action"]) for r in summary["items"]}
    assert ("piper:es_AR-daniela-high", "failed") in actions
    assert ("whisper:base", "downloaded") in actions


def _with_downloader(fn):
    class Patched(WhisperItem):
        def __init__(self, model: str, downloader=None) -> None:
            super().__init__(model, fn)

    return Patched


def test_whisper_snapshot_detected_and_recorded(tmp_path: Path) -> None:
    item = WhisperItem("base")
    manifest = Manifest.load(tmp_path)
    assert item.status(tmp_path, manifest).state == "missing"
    snap = tmp_path / "whisper" / "models--Systran--faster-whisper-base" / "snapshots" / "rev1"
    snap.mkdir(parents=True)
    (snap / "model.bin").write_bytes(b"w" * 64)
    (snap / "config.json").write_text("{}")
    st = item.status(tmp_path, manifest)
    assert st.state == "present" and st.size == 66
    rel = "whisper/models--Systran--faster-whisper-base/snapshots/rev1/model.bin"
    assert manifest.get(rel)["group"] == "whisper:base"
    (snap / "model.bin").write_bytes(b"w" * 10)  # truncated later -> corrupt
    assert item.status(tmp_path, manifest).state == "corrupt"
