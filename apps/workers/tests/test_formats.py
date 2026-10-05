from studio_workers.schemas import SubtitleSegment, SubtitleWord, Transcript
from studio_workers.stt.formats import (
    ass_time,
    karaoke_text,
    split_lines,
    srt_time,
    to_ass,
    to_srt,
    write_all,
)


def _seg() -> SubtitleSegment:
    words = [
        SubtitleWord(start=0.0, end=0.5, word="Hola"),
        SubtitleWord(start=0.6, end=1.1, word="mundo"),
        SubtitleWord(start=1.5, end=2.0, word="{raro}"),
    ]
    return SubtitleSegment(start=0.0, end=2.0, text="Hola mundo {raro}", words=words)


def test_timestamps() -> None:
    assert srt_time(3661.5) == "01:01:01,500"
    assert srt_time(0.0004) == "00:00:00,000"
    assert ass_time(3661.5) == "1:01:01.50"


def test_split_lines_by_word_count() -> None:
    lines = split_lines([_seg()], max_words=2)
    assert [line.text for line in lines] == ["Hola mundo", "{raro}"]
    assert lines[1].start == 1.5


def test_srt_and_ass_karaoke() -> None:
    srt = to_srt([_seg()], max_words=7)
    assert srt.startswith("1\n00:00:00,000 --> 00:00:02,000\nHola mundo {raro}\n")
    line = split_lines([_seg()], 7)[0]
    # \kf spans until the next word starts (keeps pauses inside the highlight)
    assert karaoke_text(line) == "{\\kf60}Hola {\\kf90}mundo {\\kf50}(raro)"
    ass = to_ass([_seg()])
    assert "[Events]" in ass and "Dialogue: 0,0:00:00.00,0:00:02.00,Default" in ass


def test_segment_without_words() -> None:
    seg = SubtitleSegment(start=1, end=2, text=" solo texto ")
    assert "solo texto" in to_srt([seg])
    assert "solo texto" in to_ass([seg])


def test_write_all(tmp_path) -> None:
    t = Transcript(language="es", duration_sec=2.0, segments=[_seg()])
    j, s, a = write_all(t, tmp_path / "out" / "job1")
    assert j.name == "job1.json" and s.name == "job1.srt" and a.name == "job1.ass"
    assert '"durationSec": 2.0' in j.read_text("utf-8")
    assert a.read_bytes().startswith(b"\xef\xbb\xbf")
