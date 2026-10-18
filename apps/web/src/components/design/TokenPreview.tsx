"use client";

import { captionStyleFromTokens, type BrandKit, type DesignAspect } from "@studio/shared";
import { useMemo, useState } from "react";
import { Badge, Tabs } from "@/components/ui/misc";
import { useStillPreview, type StillRequest } from "@/hooks/use-design";
import { ensureBundledFontFaces } from "@/lib/api-design";
import { SafeZoneOverlay } from "./SafeZoneCalibrator";
import { KIT_TEXTS_ES } from "./texts";

const SIZE: Record<"9:16" | "16:9", { width: number; height: number }> = {
  "9:16": { width: 540, height: 960 },
  "16:9": { width: 960, height: 540 },
};

/**
 * Live preview of the kit: subtitle + title + lower third, rendered by the api with Remotion
 * renderStill (same pipeline as the export) over a frame of the last video, in 9:16 and 16:9.
 * Until the stills arrive (or when Remotion is missing) an approximate CSS preview drawn with the
 * same tokens and the bundled fonts is shown.
 */
export function TokenPreview({
  kit,
  backgroundAssetId,
}: {
  kit: BrandKit;
  backgroundAssetId?: string;
}) {
  const [aspect, setAspect] = useState<"9:16" | "16:9">("9:16");
  ensureBundledFontFaces();
  const size = SIZE[aspect];
  const version = kit.updated_at ?? "";
  const title: StillRequest = useMemo(
    () => ({
      template: "title-card",
      props: { title: kit.name, subtitle: "", __kit: version },
      ...size,
      ...(backgroundAssetId && { background_asset_id: backgroundAssetId }),
    }),
    [kit.name, version, size, backgroundAssetId],
  );
  const lower: StillRequest = useMemo(
    () => ({
      template: "lower-third",
      props: { name: kit.name, role: "Tu canal", __kit: version },
      ...size,
    }),
    [kit.name, version, size],
  );
  const captions: StillRequest = useMemo(
    () => ({ template: "animated-captions", props: { __kit: version }, ...size }),
    [version, size],
  );
  const a = useStillPreview(title);
  const b = useStillPreview(lower);
  const c = useStillPreview(captions);
  const urls = [a.url, b.url, c.url].filter(Boolean) as string[];
  const error = a.error ?? b.error ?? c.error;
  const loading = a.loading || b.loading || c.loading;
  return (
    <div className="flex flex-col gap-2" data-testid="token-preview">
      <Tabs<"9:16" | "16:9">
        value={aspect}
        onChange={setAspect}
        items={[
          { value: "9:16", label: "Vertical 9:16" },
          { value: "16:9", label: "Horizontal 16:9" },
        ]}
      />
      <div
        className="relative mx-auto w-full overflow-hidden rounded-md bg-neutral-800"
        style={{
          aspectRatio: `${size.width} / ${size.height}`,
          maxWidth: aspect === "9:16" ? 220 : 420,
        }}
      >
        {urls.length === 3 ? (
          urls.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element -- object URL of the api still
            <img key={i} src={u} alt="" className="absolute inset-0 size-full" />
          ))
        ) : (
          <ApproxPreview kit={kit} aspect={aspect} />
        )}
        <SafeZoneOverlay zone={kit.tokens.safe_zone[aspect]} />
        {urls.length < 3 ? (
          <Badge tone="muted" className="absolute bottom-1 left-1" title={error}>
            {loading ? KIT_TEXTS_ES.previewPending : KIT_TEXTS_ES.previewApprox}
          </Badge>
        ) : null}
      </div>
      {error && !loading ? <p className="text-[11px] text-muted-foreground">{error}</p> : null}
    </div>
  );
}

/** CSS preview with the same tokens (fonts from GET /fonts/*). */
function ApproxPreview({ kit, aspect }: { kit: BrandKit; aspect: DesignAspect }) {
  const t = kit.tokens;
  const z = t.safe_zone[aspect];
  const cap = captionStyleFromTokens(t);
  const outline = `${Math.max(1, cap.outlineWidth ?? 2) / 10}cqh`;
  return (
    <div className="absolute inset-0 [container-type:size]" data-testid="approx-preview">
      <div
        className="absolute inset-x-0 text-center"
        style={{
          top: `${z.top + 4}%`,
          fontFamily: `"${t.font.title.family}"`,
          fontWeight: t.font.title.weight,
          color: t.color.text,
          fontSize: "6cqh",
          lineHeight: 1.05,
          padding: `0 ${z.left}%`,
        }}
      >
        {kit.name}
        <div
          className="mx-auto mt-[1cqh] h-[0.6cqh] w-[12cqh]"
          style={{ background: t.color.accent }}
        />
      </div>
      <div
        className="absolute flex flex-col items-start"
        style={{ left: `${z.left}%`, bottom: `${z.bottom + 12}%` }}
      >
        <span
          className="px-[1.5cqh] py-[0.5cqh]"
          style={{
            background: t.color.plate,
            borderLeft: `0.8cqh solid ${t.color.accent}`,
            fontFamily: `"${t.font.body.family}"`,
            fontWeight: 700,
            color: t.color.text,
            fontSize: "3cqh",
          }}
        >
          {kit.name}
        </span>
      </div>
      <div
        className="absolute inset-x-0 text-center"
        style={{
          bottom: `${z.bottom}%`,
          padding: `0 ${z.left}%`,
          fontFamily: `"${t.font.caption.family}"`,
          fontWeight: t.font.caption.weight,
          color: t.color.text,
          fontSize: `${t.caption.size_pct_short_side * (aspect === "9:16" ? 9 / 16 : 1)}cqh`,
          WebkitTextStroke: `${outline} ${t.color.text_outline}`,
          paintOrder: "stroke",
          lineHeight: 1.2,
        }}
      >
        Así se ven tus
        <br />
        subtítulos
      </div>
    </div>
  );
}
