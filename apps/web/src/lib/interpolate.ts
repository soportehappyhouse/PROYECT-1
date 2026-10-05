/**
 * Keyframe evaluation: the ONE implementation shared with the export compiler lives in
 * @studio/shared (keyframes.ts). The preview only re-exports it (parity cases:
 * KEYFRAME_PARITY_CASES, checked in test/sprint2.test.tsx).
 */
export {
  ease,
  interpolate,
  normalizeCropRect as cropFraction,
  sortKeyframes,
} from "@studio/shared";
