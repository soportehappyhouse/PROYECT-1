"""Audit S6 E18: modules imported when the worker starts are declared, not only transitive."""

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _names(lines: list[str]) -> set[str]:
    out = set()
    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name = (
            line.replace("[", " ").replace(">", " ").replace("=", " ").replace("<", " ").split()[0]
        )
        out.add(name.lower())
    return out


def test_numpy_is_declared_everywhere():
    py = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert "numpy" in _names(py["project"]["dependencies"])
    assert "numpy" in _names((ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines())
    # The CUDA profile installs requirements.txt first.
    assert "-r requirements.txt" in (ROOT / "requirements-cuda.txt").read_text(encoding="utf-8")
