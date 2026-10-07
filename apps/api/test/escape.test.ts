import { describe, expect, it } from "vitest";
import {
  escapeDrawtextText,
  escapeFilterPath,
  escapeOptionValue,
  quoteFilterArg,
  sec,
  toForwardSlashes,
} from "../src/services/ffmpeg/escape.js";
import { burnSubtitlesFilter } from "../src/services/ffmpeg/builders.js";

describe("filtergraph escaping", () => {
  it("converts Windows separators to forward slashes", () => {
    expect(toForwardSlashes("C:\\Users\\Usuario\\jobs\\1\\job.srt")).toBe(
      "C:/Users/Usuario/jobs/1/job.srt",
    );
  });

  it("escapes the drive colon of a Windows path (fuentes-editor §4.9)", () => {
    expect(escapeFilterPath("C:\\Users\\Usuario\\jobs\\1\\job.srt")).toBe(
      "'C\\:/Users/Usuario/jobs/1/job.srt'",
    );
  });

  it("handles single quotes and spaces in paths", () => {
    expect(escapeFilterPath("C:\\Users\\Usuario Demó\\it's.srt")).toBe(
      "'C\\:/Users/Usuario Demó/it\\'\\''s.srt'",
    );
  });

  it("leaves posix paths readable", () => {
    expect(escapeFilterPath("/tmp/job/subs.srt")).toBe("'/tmp/job/subs.srt'");
    expect(escapeFilterPath("subs.srt")).toBe("'subs.srt'");
  });

  it("escapes level-1 specials", () => {
    expect(escapeOptionValue("a:b\\c'd")).toBe("a\\:b\\\\c\\'d");
    expect(quoteFilterArg("x'y")).toBe("'x'\\''y'");
  });

  it("escapes drawtext literal text", () => {
    expect(escapeDrawtextText("Hola: mundo")).toBe("'Hola\\: mundo'");
    expect(escapeDrawtextText("100%", true)).toBe("'100\\%'");
  });

  it("builds subtitles/ass filters with escaped absolute paths", () => {
    expect(
      burnSubtitlesFilter({ file: "C:\\studio\\tmp\\j1\\subs.srt", fontsDir: "C:\\studio\\fonts" }),
    ).toBe("subtitles='C\\:/studio/tmp/j1/subs.srt':fontsdir='C\\:/studio/fonts'");
    expect(burnSubtitlesFilter({ file: "t.ass" })).toBe("ass='t.ass'");
    expect(
      burnSubtitlesFilter({ file: "s.srt", style: { fontName: "DejaVu Sans", fontSize: 24 } }),
    ).toBe(
      "subtitles='s.srt':force_style='FontName=DejaVu Sans,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=40'",
    );
  });

  it("formats seconds without exponent noise", () => {
    expect(sec(3)).toBe("3");
    expect(sec(1.5)).toBe("1.5");
    expect(sec(0.1 + 0.2)).toBe("0.3");
    expect(sec(1 / 3)).toBe("0.333333");
  });
});
