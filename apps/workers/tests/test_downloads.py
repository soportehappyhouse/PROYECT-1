import hashlib
import json

import httpx
import pytest

from studio_workers.downloads import DownloadError, Expected, download, file_matches
from studio_workers.tts import piper_catalog


def _client(routes: dict[str, bytes], lie_length: bool = False) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        body = routes.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        headers = {"content-length": str(len(body) + (5 if lie_length else 0))}
        return httpx.Response(200, content=body, headers=headers)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_download_verifies_md5_and_size(tmp_path) -> None:
    data = b"a" * 1000
    client = _client({"https://x/f.bin": data})
    exp = Expected(size_bytes=1000, md5=hashlib.md5(data).hexdigest())
    dest = tmp_path / "f.bin"
    assert download("https://x/f.bin", dest, exp, client=client) == 1000
    assert file_matches(dest, exp)
    assert not file_matches(dest, Expected(size_bytes=999))


def test_download_rejects_bad_hash_and_leaves_nothing(tmp_path) -> None:
    client = _client({"https://x/f.bin": b"abc"})
    dest = tmp_path / "f.bin"
    with pytest.raises(DownloadError, match="md5"):
        download("https://x/f.bin", dest, Expected(md5="0" * 32), client=client)
    assert not dest.exists() and not (tmp_path / "f.bin.part").exists()


def test_download_rejects_min_size_and_http_errors(tmp_path) -> None:
    client = _client({"https://x/small": b"abc"})
    with pytest.raises(DownloadError, match="minimo"):
        download("https://x/small", tmp_path / "s", Expected(min_bytes=10), client=client)
    with pytest.raises(DownloadError, match="HTTP 404"):
        download("https://x/missing", tmp_path / "m", client=client)


def test_download_voice_uses_official_catalog(tmp_path) -> None:
    onnx = b"o" * 2_000_000
    cfg = b'{"audio": {"sample_rate": 22050}, "language": {"code": "es_AR"}}' + b" " * 300
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
    base = piper_catalog.PIPER_VOICES_BASE
    client = _client(
        {
            piper_catalog.VOICES_JSON_URL: json.dumps(catalog).encode() + b" " * 1000,
            f"{base}/{folder}/es_AR-daniela-high.onnx": onnx,
            f"{base}/{folder}/es_AR-daniela-high.onnx.json": cfg,
        }
    )
    results = piper_catalog.download_voice(tmp_path, "es_AR-daniela-high", client=client)
    assert [r[2] for r in results] == [False, False]
    assert piper_catalog.installed_voice_ids(tmp_path) == ["es_AR-daniela-high"]
    # second call: files already verified -> skipped
    again = piper_catalog.download_voice(tmp_path, "es_AR-daniela-high", client=client)
    assert [r[2] for r in again] == [True, True]
    assert piper_catalog.remote_size(
        piper_catalog.cached_voices_json(tmp_path), "es_AR-daniela-high"
    ) == len(onnx)


def test_download_voice_unknown_id(tmp_path) -> None:
    client = _client({piper_catalog.VOICES_JSON_URL: b"{}" + b" " * 1000})
    with pytest.raises(ValueError, match="no existe"):
        piper_catalog.download_voice(tmp_path, "es_AR-nadie-high", client=client)
    with pytest.raises(ValueError, match="invalido"):
        piper_catalog.download_voice(tmp_path, "../../etc", client=client)


def test_catalog_paths() -> None:
    voice = piper_catalog.CATALOG["es_ES-carlfm-x_low"]
    assert voice.remote_paths() == (
        "es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx",
        "es/es_ES/carlfm/x_low/es_ES-carlfm-x_low.onnx.json",
    )
