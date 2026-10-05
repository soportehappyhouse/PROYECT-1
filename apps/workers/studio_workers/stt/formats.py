"""Transcript -> JSON / SRT / ASS (karaoke \\kf tags) writers.

The word-level JSON is the source of truth (Remotion animated captions read it); SRT and ASS are
derived. Long segments are split into lines of at most `max_words` words.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..schemas import SubtitleSegment, SubtitleWord, Transcript


@dataclass
class Line:
    start: float
    end: float
    words: list[SubtitleWord]
    text: str


def srt_time(seconds: float) -> str:
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02}:{s:02}.{cs:02}"


def split_lines(segments: list[SubtitleSegment], max_words: int) -> list[Line]:
    lines: list[Line] = []
    for seg in segments:
        words = [w for w in (seg.words or []) if w.word.strip()]
        if not words:
            text = seg.text.strip()
            if text:
                lines.append(Line(seg.start, seg.end, [], text))
            continue
        for i in range(0, len(words), max_words):
            chunk = words[i : i + max_words]
            lines.append(
                Line(
                    chunk[0].start,
                    chunk[-1].end,
                    chunk,
                    " ".join(w.word.strip() for w in chunk),
                )
            )
    return lines


def to_srt(segments: list[SubtitleSegment], max_words: int = 7) -> str:
    blocks = []
    for n, line in enumerate(split_lines(segments, max_words), start=1):
        end = max(line.end, line.start + 0.05)
        blocks.append(f"{n}\n{srt_time(line.start)} --> {srt_time(end)}\n{line.text}\n")
    return "\n".join(blocks)


def _ass_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, \
Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, \
Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,{font_size},&H00FFFFFF,&H0000D7FF,&H00000000,&H64000000,-1,0,0,0,100,100,\
0,0,1,3,1,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def karaoke_text(line: Line) -> str:
    """`{\\kfNN}word` per word; NN (centiseconds) spans until the next word starts."""
    if not line.words:
        return _ass_escape(line.text)
    parts = []
    for i, word in enumerate(line.words):
        until = line.words[i + 1].start if i + 1 < len(line.words) else word.end
        duration_cs = max(1, round((until - word.start) * 100))
        parts.append(f"{{\\kf{duration_cs}}}{_ass_escape(word.word.strip())}")
    return " ".join(parts)


def to_ass(
    segments: list[SubtitleSegment], max_words: int = 7, width: int = 1920, height: int = 1080
) -> str:
    header = ASS_HEADER.format(
        width=width, height=height, font_size=round(height * 0.06), margin_v=round(height * 0.08)
    )
    events = []
    for line in split_lines(segments, max_words):
        end = max(line.end, line.start + 0.05)
        times = f"{ass_time(line.start)},{ass_time(end)}"
        events.append(f"Dialogue: 0,{times},Default,,0,0,0,,{karaoke_text(line)}")
    return header + "\n".join(events) + ("\n" if events else "")


def write_all(transcript: Transcript, base: Path, max_words: int = 7) -> tuple[Path, Path, Path]:
    """Write <base>.json, <base>.srt and <base>.ass (UTF-8). Returns the three paths."""
    base.parent.mkdir(parents=True, exist_ok=True)
    json_path = base.with_name(base.name + ".json")
    srt_path = base.with_name(base.name + ".srt")
    ass_path = base.with_name(base.name + ".ass")
    payload = transcript.model_dump(by_alias=True, exclude={"files"}, exclude_none=True)
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    srt_path.write_text(to_srt(transcript.segments, max_words), encoding="utf-8")
    # BOM helps some Windows players detect UTF-8 in .ass files.
    ass_path.write_text(to_ass(transcript.segments, max_words), encoding="utf-8-sig")
    return json_path, srt_path, ass_path
