import { describe, expect, it } from "vitest";
import {
  ACOUSTIC_WORD_BASE,
  buildScript,
  CutLockedError,
  cutTimeline,
  detectFillers,
  fitDuration,
  fixSegmentText,
  fixWords,
  isAcoustic,
  lockedTracksBlockingCut,
  normWord,
  planCutsInternal,
  planWordCuts,
  refineCutsWithEnergy,
  scriptIsStale,
  ScriptSchema,
  SCRIPT_RULES,
  speedUpTimeline,
  type Project,
  type SubtitleSegment,
  type SubtitleWord,
  type Word,
} from "../src/index.js";

/** Words from "texto@inicio-fin" tokens (seconds). */
function seg(spec: string): SubtitleSegment {
  const words: SubtitleWord[] = spec.split(" ").map((tok) => {
    const [word, times] = tok.split("@") as [string, string];
    const [s, e] = times.split("-").map(Number) as [number, number];
    return { word: word.replace(/_/g, " "), start: s, end: e, probability: 0.9 };
  });
  return {
    start: words[0]!.start,
    end: words[words.length - 1]!.end,
    text: words.map((w) => w.word).join(" "),
    words,
  };
}

function project(subtitles: SubtitleSegment[], dur = 30): Project {
  return {
    id: "p1",
    name: "P",
    settings: { width: 1080, height: 1920, fps: 30, sampleRate: 48000 } as Project["settings"],
    tracks: [
      {
        id: "v",
        kind: "video",
        name: "Video 1",
        muted: false,
        locked: false,
        hidden: false,
        clips: [
          {
            id: "c1",
            trackId: "v",
            assetId: "a1",
            start: 0,
            in: 0,
            out: dur,
            speed: 1,
            volume: 1,
            opacity: 1,
            voiceEffects: [],
          },
        ],
      },
      {
        id: "t",
        kind: "text",
        name: "Texto 1",
        muted: false,
        locked: false,
        hidden: false,
        clips: [
          {
            id: "x1",
            trackId: "t",
            start: 10,
            in: 0,
            out: 2,
            speed: 1,
            volume: 1,
            opacity: 1,
            voiceEffects: [],
            text: "Hola",
          },
        ],
      },
    ],
    subtitles,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as Project;
}

const W = (words: Word[], text: string) => words.find((w) => w.text === text)!;

describe("normWord", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(normWord("¿Entendés?")).toBe("entendes");
    expect(normWord("Está,")).toBe("esta");
    expect(normWord("o sea…")).toBe("o sea");
  });
});

describe("detectFillers (léxico rioplatense)", () => {
  it("«este» is a filler only with a pause around it", () => {
    const withPause = buildScript(project([seg("y@0-0.2 este@0.5-0.8 vamos@1.0-1.3")]));
    expect(W(withPause.words, "este").filler?.level).toBe("probable");
    const demonstrative = buildScript(project([seg("este@0-0.3 auto@0.32-0.6 rojo@0.62-0.9")]));
    // At the start of the sentence but no pause after: «este auto» is a demonstrative.
    expect(W(demonstrative.words, "este").filler).toBeUndefined();
  });

  it("«viste» is not a filler after lo/la/me/te/ya", () => {
    const tag = buildScript(project([seg("era@0-0.2 enorme,@0.25-0.6 ¿viste?@0.65-1.0")]));
    expect(W(tag.words, "¿viste?").filler?.category).toBe("closing_tag");
    const verb = buildScript(project([seg("ya@0-0.2 lo@0.25-0.4 viste@0.45-0.8")]));
    expect(W(verb.words, "viste").filler).toBeUndefined();
  });

  it("«tipo de» is not a filler, «tipo» as a wildcard is (doubtful, not preselected)", () => {
    const noun = buildScript(project([seg("ese@0-0.2 tipo@0.25-0.5 de@0.55-0.6 cosas@0.65-1")]));
    expect(W(noun.words, "tipo").filler).toBeUndefined();
    const wild = buildScript(project([seg("fue@0-0.2 tipo@0.25-0.5 increíble@0.55-1")]));
    expect(W(wild.words, "tipo").filler?.level).toBe("doubtful");
  });

  it("repetition «en el en el» marks the FIRST occurrence (safe)", () => {
    const s = buildScript(
      project([seg("en@0-0.1 el@0.12-0.2 en@0.3-0.4 el@0.42-0.5 parque@0.6-1")]),
    );
    const marked = s.words.filter((w) => w.filler?.category === "repetition").map((w) => w.id);
    expect(marked).toEqual(["0:0", "0:1"]);
    expect(s.words[0]!.filler?.level).toBe("safe");
  });

  it("emphasis, counts and «ah» are not «safe» (audit S6 E3)", () => {
    const level = (spec: string, text: string) =>
      W(buildScript(project([seg(spec)])).words, text).filler?.level;
    expect(level("es@0-0.2 muy@0.25-0.4 muy@0.42-0.6 importante@0.65-1.2", "muy")).toBe("probable");
    expect(level("nunca@0-0.3 nunca@0.32-0.6 jamás@0.65-1", "nunca")).toBe("probable");
    const count = buildScript(
      project([
        seg(
          "uno@0-0.2 dos@0.25-0.4 tres@0.45-0.6 uno@0.7-0.9 dos@0.95-1.1 tres@1.15-1.3 listo@1.4-1.8",
        ),
      ]),
    );
    expect(count.words.filter((w) => w.filler?.level === "safe")).toEqual([]);
    expect(level("ah@0-0.2 entendí@0.25-0.6 lo@0.62-0.7 que@0.72-0.8 decís@0.82-1.2", "ah")).toBe(
      "probable",
    );
    // A stutter on a short function word is still safe.
    expect(level("y@0-0.1 que@0.12-0.2 que@0.22-0.3 hacemos@0.35-0.8", "que")).toBe("safe");
    // None of them is preselected by «Quitar seguras».
    const s = buildScript(
      project([
        seg("es@0-0.2 muy@0.25-0.4 muy@0.42-0.6 importante@0.65-1.2 ah@1.3-1.5 bien@1.6-2"),
      ]),
    );
    expect(planWordCuts(s, { fillers: "safe", avoidHarsh: true }).cuts).toEqual([]);
  });

  it("vocalizations «eh», «mmm» are safe", () => {
    const s = buildScript(project([seg("eh@0-0.3 hola@0.5-0.8 mmm@1.0-1.4 chau@1.6-2")]));
    expect(s.stats.fillers.safe).toBe(2);
  });

  it("acoustic gap ≥ 250 ms over the floor + 10 dB becomes an `acoustic` safe pseudo-word", () => {
    const p = project([seg("hola@0-0.5 vamos@1.2-1.6 ya@1.75-2")]);
    const s = buildScript(p, {
      jobId: "j1",
      noise_floor_db: -60,
      gaps: [
        { start: 0.5, end: 1.2, rms_db: -30, voiced: true },
        { start: 1.6, end: 1.75, rms_db: -30, voiced: true }, // 150 ms: too short
      ],
    });
    const ac = s.words.filter(isAcoustic);
    expect(ac).toHaveLength(1);
    expect(ac[0]!.filler).toMatchObject({ category: "acoustic", level: "safe" });
    expect(Number(ac[0]!.id.split(":")[1])).toBeGreaterThanOrEqual(ACOUSTIC_WORD_BASE);
    // A quiet gap is not an «eh».
    const quiet = buildScript(p, {
      jobId: "j1",
      noise_floor_db: -60,
      gaps: [{ start: 0.5, end: 1.2, rms_db: -55, voiced: false }],
    });
    expect(quiet.words.some(isAcoustic)).toBe(false);
    expect(ScriptSchema.safeParse(s).success).toBe(true);
  });

  it("detectFillers is idempotent and returns new objects", () => {
    const s = buildScript(project([seg("eh@0-0.3 hola@0.5-0.8")]));
    const again = detectFillers(s.words);
    expect(again.map((w) => w.filler?.level)).toEqual(s.words.map((w) => w.filler?.level));
  });
});

describe("planWordCuts", () => {
  const p = project([seg("hola@0-0.5 eh@0.7-0.9 que@1.1-1.3 tal@1.32-1.6 bien@2.0-2.4")]);
  const s = buildScript(p);

  it("cuts in the middle of the gap with a pad ≤ 60 ms and a 12 ms fade", () => {
    const res = planWordCuts(s, { wordIds: [W(s.words, "eh").id], avoidHarsh: true });
    expect(res.cuts).toHaveLength(1);
    const c = res.cuts[0]!;
    // gap_in 0.2 s → pad 60 ms; gap_out 0.2 s → pad 60 ms.
    expect(c.start).toBeCloseTo(0.56, 6);
    expect(c.end).toBeCloseTo(1.04, 6);
    expect(c.fade_ms).toBe(SCRIPT_RULES.join_fade_ms);
    expect(res.removed_s).toBeCloseTo(0.48, 3);
  });

  it("a small gap gives a pad of gap/2", () => {
    const q = project([seg("a@0-0.5 b@0.54-0.8 c@0.9-1.2")]);
    const res = planWordCuts(buildScript(q), { wordIds: ["0:1"], avoidHarsh: false });
    expect(res.cuts[0]!.start).toBeCloseTo(0.52, 6); // 40 ms gap -> 20 ms pad
    expect(res.cuts[0]!.end).toBeCloseTo(0.85, 6); // 100 ms gap -> 50 ms pad
  });

  it("a harsh neighbour (< 30 ms) is skipped with avoidHarsh, cut without it", () => {
    const id = W(s.words, "que").id; // «tal» starts 20 ms after «que»
    const skip = planWordCuts(s, { wordIds: [id], avoidHarsh: true });
    expect(skip.cuts).toHaveLength(0);
    expect(skip.skipped[0]!.wordId).toBe(id);
    expect(planWordCuts(s, { wordIds: [id], avoidHarsh: false }).cuts).toHaveLength(1);
  });

  it("a cut shorter than 40 ms is not made", () => {
    const q = project([seg("a@0-0.5 b@0.51-0.52 c@0.53-1")]);
    const res = planWordCuts(buildScript(q), { wordIds: ["0:1"], avoidHarsh: false });
    expect(res.cuts).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
  });

  it("contiguous words merge into one cut; fillers=safe picks only the safe ones", () => {
    const res = planWordCuts(s, { wordIds: ["0:1", "0:2", "0:3"], avoidHarsh: true });
    expect(res.cuts).toHaveLength(1);
    expect(res.cuts[0]!.start).toBeCloseTo(0.56, 6);
    expect(res.cuts[0]!.end).toBeCloseTo(1.94, 6);
    const safe = planWordCuts(s, { fillers: "safe", avoidHarsh: true });
    expect(safe.cuts).toHaveLength(1);
    expect(safe.cuts[0]!.reason).toBe("filler");
  });

  it("shortenLongPauses keeps 250 ms of each long pause", () => {
    const res = planWordCuts(s, { shortenLongPauses: true, avoidHarsh: true });
    expect(res.cuts).toHaveLength(0); // no pause > 600 ms here
    const q = buildScript(project([seg("a@0-0.5 b@1.5-2")]));
    const r2 = planWordCuts(q, { shortenLongPauses: true, avoidHarsh: true });
    expect(r2.cuts[0]!.end - r2.cuts[0]!.start).toBeCloseTo(0.75, 6);
    expect(r2.cuts[0]!.reason).toBe("pause");
  });

  it("ranges select the words whose middle is inside", () => {
    const res = planWordCuts(s, { ranges: [{ start: 0.65, end: 0.95 }], avoidHarsh: true });
    expect(res.cuts[0]!.start).toBeCloseTo(0.56, 6);
  });

  it("energy refinement moves an edge to the quietest window, never into a word", () => {
    const { bounded } = planCutsInternal(s, { wordIds: ["0:1"], avoidHarsh: true });
    const energy = (t: number) => (Math.abs(t - 0.53) < 0.003 ? -80 : -40);
    const cuts = refineCutsWithEnergy(bounded, energy);
    expect(cuts[0]!.start).toBeCloseTo(0.53, 2);
    // Minimum inside the next word (1.12) is ignored.
    const inside = refineCutsWithEnergy(bounded, (t) => (Math.abs(t - 1.12) < 0.003 ? -90 : -40));
    expect(inside[0]!.end).toBeLessThanOrEqual(1.1 + 1e-9);
  });

  it("a shortened pause keeps its 250 ms (the refinement does not move it)", () => {
    const q = buildScript(project([seg("a@0-0.5 b@1.5-2")]));
    const { bounded } = planCutsInternal(q, { shortenLongPauses: true, avoidHarsh: true });
    const pauses = bounded.filter((c) => c.reason === "pause");
    expect(pauses.length).toBeGreaterThan(0);
    const energy = (t: number) => -40 - 30 * Math.sin(t * 50); // minima everywhere
    const out = refineCutsWithEnergy(pauses, energy);
    expect(out.map((c) => [c.start, c.end])).toEqual(pauses.map((c) => [c.start, c.end]));
  });
});

describe("cutTimeline", () => {
  it("splits media clips, fades the joins, shrinks overlays and re-times subtitles", () => {
    const p = project([seg("hola@0-0.5 eh@0.7-0.9 que@1.1-1.3"), seg("chau@11-11.5")]);
    const out = cutTimeline(
      p,
      [
        { start: 0.56, end: 1.04 },
        { start: 10.5, end: 11 },
      ],
      {
        newId: (() => {
          let n = 0;
          return () => `n${++n}`;
        })(),
      },
    );
    const v = out.project.tracks[0]!.clips;
    expect(v.map((c) => c.id)).toEqual(["c1", "n1", "n2"]);
    expect(v[0]!.audioFade).toEqual({ inMs: 0, outMs: 12 });
    expect(v[1]!.audioFade).toEqual({ inMs: 12, outMs: 12 });
    expect(v[1]!.start).toBeCloseTo(0.56, 6);
    expect(v[1]!.in).toBeCloseTo(1.04, 6);
    expect(out.removed_s).toBeCloseTo(0.98, 3);
    // Text 10–12 overlaps 10.5–11: 0.5 s shorter, start moved by the first cut.
    const t = out.project.tracks[1]!.clips[0]!;
    expect(t.start).toBeCloseTo(10 - 0.48, 6);
    expect(t.out - t.in).toBeCloseTo(1.5, 6);
    // «eh» disappears from the subtitles, «que» moves left.
    const words = out.project.subtitles[0]!.words!;
    expect(words.map((w) => w.word)).toEqual(["hola", "que"]);
    expect(words[1]!.start).toBeCloseTo(1.1 - 0.48, 6);
    expect(out.project.subtitles[0]!.text).toBe("hola que");
    // Total duration = 30 − 0.98.
    const v2 = v[v.length - 1]!;
    expect(v2.start + (v2.out - v2.in)).toBeCloseTo(30 - 0.98, 6);
  });

  it("locked tracks: untouched if they end before the cut, otherwise the cut is refused (E8)", () => {
    const p = project([]);
    p.tracks[1]!.locked = true; // text 10–12
    const before = cutTimeline(p, [{ start: 20, end: 21 }], { newId: () => "z" });
    expect(before.project.tracks[1]).toBe(p.tracks[1]);
    expect(() => cutTimeline(p, [{ start: 1, end: 2 }], { newId: () => "z" })).toThrow(
      CutLockedError,
    );
    expect(lockedTracksBlockingCut(p, [{ start: 1, end: 2 }]).map((t) => t.name)).toEqual([
      "Texto 1",
    ]);
    expect(() => speedUpTimeline(p, 1.2)).toThrow(/Desbloqueá la pista «Texto 1»/);
  });
});

describe("fixWords", () => {
  const words: SubtitleWord[] = [
    { word: "hola", start: 0, end: 0.4 },
    { word: "como", start: 0.5, end: 0.8 },
    { word: "estas", start: 0.9, end: 1.3 },
  ];

  it("equal keeps timings (only spelling changes)", () => {
    const out = fixWords(words, "hola como estas", "Hola, cómo estás");
    expect(out.map((w) => [w.start, w.end])).toEqual(words.map((w) => [w.start, w.end]));
    expect(out.map((w) => w.word)).toEqual(["Hola,", "cómo", "estás"]);
    expect(out.some((w) => w.corrected)).toBe(false);
  });

  it("replace spreads the interval by letters, ≥ 80 ms each, marked corrected", () => {
    const out = fixWords(words, "hola como estas", "hola qué tal estás");
    const repl = out.filter((w) => w.corrected);
    expect(repl.map((w) => w.word)).toEqual(["qué", "tal"]);
    expect(repl[0]!.start).toBeCloseTo(0.5, 6);
    expect(repl[1]!.end).toBeCloseTo(0.8, 6);
    for (const w of repl) expect(w.end - w.start).toBeGreaterThanOrEqual(0.08 - 1e-9);
    const long = fixWords([{ word: "x", start: 0, end: 0.1 }], "x", "supercalifragilístico y");
    expect(long[1]!.end - long[1]!.start).toBeGreaterThanOrEqual(0.05 - 1e-9); // even split when short
  });

  it("insert takes ≤ 60 % of the gap; delete leaves the gap", () => {
    const out = fixWords(words, "hola como estas", "hola che como estas");
    const ins = out.find((w) => w.word === "che")!;
    expect(ins.corrected).toBe(true);
    expect(ins.end - ins.start).toBeLessThanOrEqual(0.06 + 1e-9);
    expect(ins.start).toBeGreaterThanOrEqual(0.4);
    expect(ins.end).toBeLessThanOrEqual(0.5);
    const del = fixWords(words, "hola como estas", "hola estas");
    expect(del.map((w) => w.word)).toEqual(["hola", "estas"]);
    expect(del[1]!.start).toBe(0.9);
  });

  // Audit S6 E2: Whisper words are usually glued (no gap) and text is often added at the end.
  const glued = seg("hoy@0-0.3 vamos@0.3-0.7 a@0.7-0.8 editar@0.8-1.3 un@1.3-1.5 video@1.5-2");
  const project1 = (s: SubtitleSegment) => {
    const p = project([s]);
    p.subtitles = [s];
    return p;
  };

  it("insert without a gap borrows time from the longer neighbour (never zero length)", () => {
    const fixed = fixSegmentText(glued, "hoy vamos a editar un muy buen video");
    const w = fixed.words!;
    expect(w.map((x) => x.word)).toEqual("hoy vamos a editar un muy buen video".split(" "));
    for (const x of w) expect(x.end - x.start, x.word).toBeGreaterThanOrEqual(0.04 - 1e-9);
    for (let k = 1; k < w.length; k++)
      expect(w[k]!.start).toBeGreaterThanOrEqual(w[k - 1]!.end - 1e-9);
    // Appended at the end of the segment, too.
    const end = fixSegmentText(glued, "hoy vamos a editar un video ahora").words!;
    expect(end.at(-1)!.word).toBe("ahora");
    expect(end.at(-1)!.end - end.at(-1)!.start).toBeGreaterThanOrEqual(0.04);
    expect(end.at(-1)!.end).toBeLessThanOrEqual(glued.end + 1e-9);
  });

  it("text added by a correction survives a later cut", () => {
    const fixed = fixSegmentText(glued, "hoy vamos a editar un muy buen video");
    const out = cutTimeline(project1(fixed), [{ start: 0, end: 0.1 }], { newId: () => "z" });
    expect(out.project.subtitles[0]!.text).toContain("muy buen video");
    const tail = fixSegmentText(glued, "hoy vamos a editar un video ahora");
    const out2 = cutTimeline(project1(tail), [{ start: 0.3, end: 0.7 }], { newId: () => "y" });
    expect(out2.project.subtitles[0]!.text).toBe("hoy a editar un video ahora");
  });
});

describe("fitDuration", () => {
  // 60 s: 10 sentences; 9 long pauses of 1.5 s; 8 «eh» of 0.4 s with 0.2 s gaps.
  function longProject(): Project {
    const segs: SubtitleSegment[] = [];
    let t = 0;
    for (let k = 0; k < 10; k++) {
      const parts: string[] = [];
      parts.push(`frase${k}@${t.toFixed(2)}-${(t + 1).toFixed(2)}`);
      t += 1.2;
      if (k < 8) {
        parts.push(`eh@${t.toFixed(2)}-${(t + 0.4).toFixed(2)}`);
        t += 0.6;
      }
      parts.push(`importante${k}.@${t.toFixed(2)}-${(t + 2).toFixed(2)}`);
      t += 2;
      segs.push(seg(parts.join(" ")));
      t += k < 9 ? 1.5 : 0;
    }
    return project(segs, 60);
  }

  it("removes long pauses first, then safe fillers, and never goes below the target", () => {
    const s = buildScript(longProject());
    const res = fitDuration(s, { target_s: 50 });
    expect(res.from_s).toBe(60);
    expect(res.groups[0]!.level).toBe("pauses");
    expect(res.reached).toBe(true);
    expect(res.to_s).toBeGreaterThanOrEqual(49.5 - 1e-6);
    expect(res.to_s).toBeLessThanOrEqual(50.5 + 1e-6);
    expect(res.plan?.ops[0]!.op).toBe("delete_words");
  });

  it("goes to the next level only when the previous one is not enough", () => {
    const s = buildScript(longProject());
    const res = fitDuration(s, { target_s: 45 });
    expect(res.groups.map((g) => g.level)).toEqual(["pauses", "fillers_safe"]);
    expect(res.to_s).toBeGreaterThanOrEqual(44.5 - 1e-6);
  });

  it("never cuts mid-word: every cut lies in a gap between words", () => {
    const s = buildScript(longProject());
    const res = fitDuration(s, { target_s: 45 });
    for (const c of res.cuts)
      for (const w of s.words) {
        const outside = c.end <= w.start + 1e-9 || c.start >= w.end - 1e-9;
        const whole = c.start <= w.start + 1e-9 && c.end >= w.end - 1e-9;
        expect(outside || whole).toBe(true);
      }
  });

  it("not reaching the target returns what it got and a question", () => {
    const s = buildScript(longProject());
    const res = fitDuration(s, { target_s: 30 });
    expect(res.reached).toBe(false);
    expect(res.question_es).toMatch(/Llego a .* s sin tocar contenido/);
    const fast = fitDuration(s, { target_s: 40, allow_speedup: true });
    expect(fast.speed).toBeLessThanOrEqual(1.1);
    expect(fast.plan?.ops[0]!.op).toBe("fit_duration");
  });

  it("tolerance 0.5 s: already within the target does nothing", () => {
    const s = buildScript(longProject());
    const res = fitDuration(s, { target_s: 59.6 });
    expect(res.cuts).toHaveLength(0);
    expect(res.reached).toBe(true);
  });

  it("sentences only with allow_sentences (and the plan asks for confirmation)", () => {
    const s = buildScript(longProject());
    expect(fitDuration(s, { target_s: 30 }).groups.some((g) => g.level === "sentences")).toBe(
      false,
    );
    const res = fitDuration(s, { target_s: 35, allow_sentences: true });
    expect(res.groups.some((g) => g.level === "sentences")).toBe(true);
    expect(res.plan?.ops.every((o) => o.confirm === true)).toBe(true);
  });
});

describe("scriptIsStale", () => {
  it("words over no media clip mark the script stale", () => {
    const p = project([seg("hola@0-0.5 chau@1-1.5")], 30);
    expect(scriptIsStale(p)).toBe(false);
    p.tracks[0]!.clips[0]!.out = 0.6;
    expect(scriptIsStale(p)).toBe(true);
  });
});
