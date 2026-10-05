import type { LottieAnimationData } from "@remotion/lottie";

/**
 * Built-in sample animation (own work, CC0): an expanding ring + pulsing dot, 512x512 @30fps.
 * Used by the lottie-overlay template when no .json is provided.
 */
const ease = { i: { x: [0.2], y: [1] }, o: { x: [0.6], y: [0] } };
const ease3 = { i: { x: [0.2, 0.2, 0.2], y: [1, 1, 1] }, o: { x: [0.6, 0.6, 0.6], y: [0, 0, 0] } };
const transform = {
  p: { a: 0, k: [0, 0] },
  a: { a: 0, k: [0, 0] },
  s: { a: 0, k: [100, 100] },
  r: { a: 0, k: 0 },
  o: { a: 0, k: 100 },
};

export const SAMPLE_LOTTIE: LottieAnimationData = {
  v: "5.7.4",
  fr: 30,
  ip: 0,
  op: 60,
  w: 512,
  h: 512,
  nm: "studio-pulse",
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: "ring",
      sr: 1,
      ks: {
        o: {
          a: 1,
          k: [
            { t: 0, s: [100], ...ease },
            { t: 60, s: [0] },
          ],
        },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [256, 256, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [20, 20, 100], ...ease3 },
            { t: 60, s: [100, 100, 100] },
          ],
        },
      },
      ao: 0,
      shapes: [
        {
          ty: "gr",
          nm: "ring-group",
          it: [
            { ty: "el", nm: "ellipse", d: 1, s: { a: 0, k: [440, 440] }, p: { a: 0, k: [0, 0] } },
            {
              ty: "st",
              nm: "stroke",
              c: { a: 0, k: [0.882, 0.196, 0.22, 1] },
              o: { a: 0, k: 100 },
              w: { a: 0, k: 28 },
              lc: 2,
              lj: 2,
            },
            { ty: "tr", ...transform },
          ],
        },
      ],
      ip: 0,
      op: 60,
      st: 0,
      bm: 0,
    },
    {
      ddd: 0,
      ind: 2,
      ty: 4,
      nm: "dot",
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [256, 256, 0] },
        a: { a: 0, k: [0, 0, 0] },
        s: {
          a: 1,
          k: [
            { t: 0, s: [100, 100, 100], ...ease3 },
            { t: 30, s: [130, 130, 100], ...ease3 },
            { t: 60, s: [100, 100, 100] },
          ],
        },
      },
      ao: 0,
      shapes: [
        {
          ty: "gr",
          nm: "dot-group",
          it: [
            { ty: "el", nm: "ellipse", d: 1, s: { a: 0, k: [120, 120] }, p: { a: 0, k: [0, 0] } },
            { ty: "fl", nm: "fill", c: { a: 0, k: [1, 0.831, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
            { ty: "tr", ...transform },
          ],
        },
      ],
      ip: 0,
      op: 60,
      st: 0,
      bm: 0,
    },
  ],
};
