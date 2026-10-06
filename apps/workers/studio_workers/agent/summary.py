"""Reading the compact project summary the api sends (``project_summary``).

The api builds it (apps/api/src/services/agent/summary.ts) in the dataset's JSON shape
``{canvas, cursor_s, tracks: [{kind, clips: [{id, name, start, end}]}], scenes?, assets?,
transcript_excerpt?}``; ``as_text`` renders it for the prompt as compact JSON (the same text the
few-shot pairs of ``prompts/fewshot_es.jsonl`` and the dataset show the model). The workers only
need two more things from it, and must survive any format change:

- ``known_ids``: is an id the model wrote really in the project? (substring as a whole token, so
  it works for JSON or plain text summaries);
- ``clips``: the clips (id, name, track kind) for the deterministic router's "single candidate"
  decisions. JSON summaries are walked; the older text format (track lines ``- V1 video "…": n
  clips`` + clip lines ``  1. id=c1 "playa.mp4" 0-12.5s``) is still read line by line. When nothing
  can be read the router leaves the command to the LLM rather than guessing.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

TRACK_KINDS = ("video", "audio", "text", "motion")
MAX_SUMMARY_CHARS = 6000  # ~1500 tokens (contract)


@dataclass(frozen=True)
class ClipInfo:
    id: str
    name: str
    track: str | None


def as_text(summary: Any) -> str:
    if summary is None:
        return ""
    if isinstance(summary, str):
        return summary
    return json.dumps(summary, ensure_ascii=False, separators=(",", ":"))


def compact(summary: Any, limit: int = MAX_SUMMARY_CHARS) -> str:
    text = as_text(summary).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n…(resumen recortado)"


def id_known(identifier: str, summary: Any) -> bool:
    if not identifier:
        return False
    text = as_text(summary)
    pattern = rf"(?<![\w-]){re.escape(identifier)}(?![\w-])"
    return re.search(pattern, text) is not None


def _parse_json(summary: Any) -> Any:
    if not isinstance(summary, str):
        return summary
    text = summary.strip()
    if not text.startswith(("{", "[")):
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _kind(value: Any) -> str | None:
    if isinstance(value, str) and value.lower() in TRACK_KINDS:
        return value.lower()
    return None


def _walk_json(node: Any, track: str | None, out: list[ClipInfo], seen: set[str]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk_json(item, track, out, seen)
        return
    if not isinstance(node, dict):
        return
    kind = _kind(node.get("kind")) or _kind(node.get("track")) or _kind(node.get("type"))
    clips = node.get("clips")
    if isinstance(clips, list):
        for clip in clips:
            if isinstance(clip, dict) and isinstance(clip.get("id"), str):
                cid = clip["id"]
                if cid in seen:
                    continue
                seen.add(cid)
                ckind = _kind(clip.get("track")) or _kind(clip.get("kind")) or kind or track
                name = clip.get("name") or clip.get("asset") or clip.get("file") or ""
                out.append(ClipInfo(cid, str(name), ckind))
    for key, value in node.items():
        if key != "clips" and isinstance(value, dict | list):
            _walk_json(value, kind or track, out, seen)


_TRACK_LINE = re.compile(r"^-\s+\S+\s+(video|audio|text|motion)\b", re.I)
_CLIP_LINE = re.compile(r"^\s+\d+\.\s+id=([^\s\"]+)(?:\s+\"([^\"]*)\")?")


def _walk_text(text: str) -> list[ClipInfo] | None:
    """apps/api summary.ts format::

    PISTAS (clips por orden de inicio; …):
    - V1 video "Video 1": 2 clips
      1. id=c1 "playa.mp4" 0-12.5s (12.5s)
    - A1 audio "Música": 0 clips
    """
    out: list[ClipInfo] = []
    kind: str | None = None
    saw_tracks = False
    for line in text.splitlines():
        tm = _TRACK_LINE.match(line)
        if tm:
            kind = tm.group(1).lower()
            saw_tracks = True
            continue
        cm = _CLIP_LINE.match(line)
        if cm and kind:
            out.append(ClipInfo(cm.group(1), cm.group(2) or "", kind))
            continue
        if line and not line[0].isspace():
            kind = None
            saw_tracks = saw_tracks or line.upper().startswith("PISTAS")
    return out if (out or saw_tracks) else None


def clips(summary: Any) -> list[ClipInfo] | None:
    """Clips found in the summary, or None when the format could not be read at all."""
    data = _parse_json(summary)
    if data is not None:
        out: list[ClipInfo] = []
        _walk_json(data, None, out, set())
        return out if out or _has_tracks(data) else None
    text = as_text(summary)
    if not text.strip():
        return None
    return _walk_text(text)


def _has_tracks(data: Any) -> bool:
    return isinstance(data, dict) and ("tracks" in data or "clips" in data)
