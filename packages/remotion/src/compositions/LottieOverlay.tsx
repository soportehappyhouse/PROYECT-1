import { Lottie, type LottieAnimationData } from "@remotion/lottie";
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, useVideoConfig } from "remotion";
import { SAMPLE_LOTTIE } from "../assets/sample-lottie.js";
import type { LottieOverlayProps } from "../schemas/lottie-overlay.js";
import { Backdrop } from "./common.js";

/** Fetch a Lottie JSON over HTTP holding the render until it arrives (docs: lottie-staticfile). */
function useLottieFromUrl(src: string | undefined): LottieAnimationData | null {
  const [data, setData] = useState<LottieAnimationData | null>(null);
  const [handle] = useState(() => (src ? delayRender(`Cargando Lottie ${src}`) : null));
  useEffect(() => {
    if (!src || handle === null) return;
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`No se pudo cargar la animación Lottie (${r.status}): ${src}`);
        return r.json() as Promise<LottieAnimationData>;
      })
      .then((json) => {
        setData(json);
        continueRender(handle);
      })
      .catch((err: unknown) => cancelRender(err));
  }, [src, handle]);
  return data;
}

const JUSTIFY = {
  center: ["center", "center"],
  "top-left": ["flex-start", "flex-start"],
  "top-right": ["flex-start", "flex-end"],
  "bottom-left": ["flex-end", "flex-start"],
  "bottom-right": ["flex-end", "flex-end"],
} as const;

/** Lottie animation over a transparent (or colored) background via @remotion/lottie. */
export function LottieOverlay(props: LottieOverlayProps) {
  const { width, height } = useVideoConfig();
  const remote = useLottieFromUrl(props.animationData ? undefined : props.lottieSrc);
  const data =
    (props.animationData as LottieAnimationData | undefined) ??
    remote ??
    (props.lottieSrc ? null : SAMPLE_LOTTIE);
  const side = Math.min(width, height) * props.size;
  const [v, h] = JUSTIFY[props.position];

  return (
    <Backdrop
      color={props.background}
      style={{
        justifyContent: v,
        alignItems: h,
        padding: (props.marginPct / 100) * Math.min(width, height),
      }}
    >
      {data ? (
        <div style={{ width: side, height: side }}>
          <Lottie animationData={data} loop={props.loop} playbackRate={props.playbackRate} />
        </div>
      ) : null}
    </Backdrop>
  );
}
