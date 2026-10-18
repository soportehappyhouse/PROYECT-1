"use client";

import {
  BrandLogoPositionSchema,
  BUNDLED_FONT_FAMILIES,
  BUNDLED_FONT_WEIGHTS,
  contrastRatio,
  DESIGN_TEXTS_ES,
  GLOSSARY_ES,
  type BrandKit,
  type BundledFontFamily,
  type DesignTokens,
  type SafeZone,
} from "@studio/shared";
import { Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Range, Select } from "@/components/ui/input";
import { ErrorNotice, Section, Spinner } from "@/components/ui/misc";
import { useApiResource } from "@/hooks/use-api-resource";
import { STILL_DEBOUNCE_MS, useBrandKit } from "@/hooks/use-design";
import { api, errorMessage } from "@/lib/api";
import { designApi } from "@/lib/api-design";
import { DesignChecklist } from "./DesignChecklist";
import { SafeZoneCalibrator } from "./SafeZoneCalibrator";
import { TokenPreview } from "./TokenPreview";
import {
  COLOR_LABELS_ES,
  FONT_ROLE_LABELS_ES,
  FONT_WEIGHT_LABELS_ES,
  KIT_TEXTS_ES,
  LOGO_POSITION_LABELS_ES,
  SIDE_LABELS_ES,
} from "./texts";

type ColorKey = keyof typeof COLOR_LABELS_ES;
type FontRole = keyof DesignTokens["font"];

/** Contrast pairs checked live: [color, against, label]. */
const PAIRS: [ColorKey, ColorKey, string][] = [
  ["text", "text_outline", "Texto sobre el contorno"],
  ["text", "plate", "Texto sobre la caja"],
];

export function lowContrastColors(tokens: DesignTokens): Set<ColorKey> {
  const bad = new Set<ColorKey>();
  for (const [a, b] of PAIRS)
    if (contrastRatio(tokens.color[a], tokens.color[b]) < tokens.caption.min_contrast) {
      bad.add(a);
      bad.add(b);
    }
  return bad;
}

const SHORTS_ZONE: SafeZone = { top: 15, bottom: 35, left: 11, right: 18 };
const REELS_ZONE: SafeZone = { top: 15, bottom: 35, left: 11, right: 11 };

/** Ajustes → Kit de marca: the single brand kit with a live preview. */
export function BrandKitTab() {
  const { kit, error, save } = useBrandKit();
  const [draft, setDraft] = useState<BrandKit>();
  const [calibrating, setCalibrating] = useState(false);
  const media = useApiResource(() => api.listMedia());
  const lastVideo = useMemo(
    () =>
      (media.data ?? [])
        .filter((m) => m.kind === "video")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id,
    [media.data],
  );
  useEffect(() => {
    if (kit && !draft) setDraft(kit);
  }, [kit, draft]);

  // Autosave (debounced like the preview): the preview stills use the stored kit.
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const update = (next: BrandKit) => {
    setDraft(next);
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      void save({
        name: next.name.trim() || "Mi canal",
        tokens: next.tokens,
        logo_position: next.logo_position,
        logo_opacity: next.logo_opacity,
        logo_scale_pct: next.logo_scale_pct,
        ...(next.calibration && { calibration: next.calibration }),
      }).then(
        (saved) => saved && setDraft((d) => (d ? { ...d, updated_at: saved.updated_at } : d)),
      );
    }, STILL_DEBOUNCE_MS);
  };
  useEffect(() => () => clearTimeout(pending.current), []);

  if (error && !draft) return <ErrorNotice message={error} />;
  if (!draft) return <Spinner />;
  const t = draft.tokens;
  const setTokens = (patch: Partial<DesignTokens>) =>
    update({ ...draft, tokens: { ...t, ...patch } });
  const bad = lowContrastColors(t);

  return (
    <div className="flex flex-col gap-5" data-testid="brand-kit-tab">
      <p className="text-xs text-muted-foreground">{KIT_TEXTS_ES.intro}</p>
      <div className="grid gap-5 md:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-5">
          <Section title={KIT_TEXTS_ES.name}>
            <Input
              aria-label={KIT_TEXTS_ES.name}
              value={draft.name}
              maxLength={80}
              onChange={(e) => update({ ...draft, name: e.target.value })}
            />
            <div className="flex flex-wrap items-end gap-2">
              <Label className="flex-1">
                {KIT_TEXTS_ES.logo}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml"
                  className="text-xs"
                  aria-label={KIT_TEXTS_ES.logo}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    designApi
                      .uploadLogo(f)
                      .then((k) => {
                        setDraft(k);
                        toast.success("Logo guardado");
                      })
                      .catch((err: unknown) =>
                        toast.error("No se pudo subir el logo", { description: errorMessage(err) }),
                      );
                  }}
                />
              </Label>
              <Label>
                {KIT_TEXTS_ES.logoPosition}
                <Select
                  value={draft.logo_position}
                  onChange={(e) =>
                    update({
                      ...draft,
                      logo_position: BrandLogoPositionSchema.parse(e.target.value),
                    })
                  }
                >
                  {BrandLogoPositionSchema.options.map((p) => (
                    <option key={p} value={p}>
                      {LOGO_POSITION_LABELS_ES[p]}
                    </option>
                  ))}
                </Select>
              </Label>
              {draft.logo_asset_id ? (
                <Upload className="size-4 text-muted-foreground" aria-label="Logo cargado" />
              ) : null}
            </div>
          </Section>

          <Section title={KIT_TEXTS_ES.colors}>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(COLOR_LABELS_ES) as ColorKey[]).map((k) => (
                <Label key={k}>
                  {COLOR_LABELS_ES[k]}
                  <div className="flex items-center gap-1">
                    <Input
                      type="color"
                      className="w-10 p-0.5"
                      aria-label={`Color ${COLOR_LABELS_ES[k]}`}
                      aria-invalid={bad.has(k) || undefined}
                      data-low-contrast={bad.has(k) || undefined}
                      value={t.color[k].slice(0, 7)}
                      onChange={(e) => {
                        const alpha = t.color[k].length === 9 ? t.color[k].slice(7) : "";
                        setTokens({
                          color: { ...t.color, [k]: `${e.target.value.toUpperCase()}${alpha}` },
                        });
                      }}
                    />
                    <span className="font-mono text-[11px]">{t.color[k]}</span>
                  </div>
                </Label>
              ))}
            </div>
            <ul className="flex flex-col gap-0.5 text-[11px]">
              {PAIRS.map(([a, b, label]) => {
                const r = contrastRatio(t.color[a], t.color[b]);
                const ok = r >= t.caption.min_contrast;
                return (
                  <li key={label} className={ok ? "text-muted-foreground" : "text-destructive"}>
                    {label}: {r.toFixed(1).replace(".", ",")}:1{" "}
                    {ok ? "✓" : `— ${DESIGN_TEXTS_ES.lowContrast}`}
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section title={KIT_TEXTS_ES.fonts}>
            <p className="text-[11px] text-muted-foreground">{DESIGN_TEXTS_ES.fontsBundled}</p>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(FONT_ROLE_LABELS_ES) as FontRole[]).map((role) => (
                <div key={role} className="flex gap-1">
                  <Label className="flex-1">
                    {FONT_ROLE_LABELS_ES[role]}
                    <Select
                      value={t.font[role].family}
                      style={{ fontFamily: `"${t.font[role].family}"` }}
                      onChange={(e) =>
                        setTokens({
                          font: {
                            ...t.font,
                            [role]: {
                              ...t.font[role],
                              family: e.target.value as BundledFontFamily,
                            },
                          },
                        })
                      }
                    >
                      {BUNDLED_FONT_FAMILIES.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </Select>
                  </Label>
                  <Label>
                    Grosor
                    <Select
                      value={String(t.font[role].weight)}
                      onChange={(e) =>
                        setTokens({
                          font: {
                            ...t.font,
                            [role]: {
                              ...t.font[role],
                              weight: Number(e.target.value) as 400 | 700 | 900,
                            },
                          },
                        })
                      }
                    >
                      {BUNDLED_FONT_WEIGHTS.map((w) => (
                        <option key={w} value={w}>
                          {FONT_WEIGHT_LABELS_ES[w]}
                        </option>
                      ))}
                    </Select>
                  </Label>
                </div>
              ))}
            </div>
          </Section>

          <Section
            title={KIT_TEXTS_ES.safeZone}
            actions={
              <Button
                size="xs"
                variant="outline"
                tip="kitCalibrate"
                onClick={() => setCalibrating(true)}
              >
                {GLOSSARY_ES.actions.calibrate}
              </Button>
            }
          >
            <p className="text-[11px] text-muted-foreground">{DESIGN_TEXTS_ES.safeZoneGuide}</p>
            {calibrating ? (
              <SafeZoneCalibrator
                value={t.safe_zone["9:16"]}
                onCancel={() => setCalibrating(false)}
                onSave={(zone) => {
                  setCalibrating(false);
                  update({
                    ...draft,
                    tokens: { ...t, safe_zone: { ...t.safe_zone, "9:16": zone } },
                    calibration: { aspect: "9:16", calibrated_at: new Date().toISOString() },
                  });
                }}
              />
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {(Object.keys(SIDE_LABELS_ES) as (keyof SafeZone)[]).map((side) => (
                  <Label key={side}>
                    {SIDE_LABELS_ES[side]} {t.safe_zone["9:16"][side]} %
                    <Range
                      min={0}
                      max={45}
                      value={t.safe_zone["9:16"][side]}
                      aria-label={`Zona segura 9:16 ${SIDE_LABELS_ES[side].toLowerCase()}`}
                      onChange={(e) =>
                        setTokens({
                          safe_zone: {
                            ...t.safe_zone,
                            "9:16": { ...t.safe_zone["9:16"], [side]: Number(e.target.value) },
                          },
                        })
                      }
                    />
                  </Label>
                ))}
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {GLOSSARY_ES.actions.advanced}
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setTokens({ safe_zone: { ...t.safe_zone, "9:16": REELS_ZONE } })}
                >
                  {KIT_TEXTS_ES.reelsProfile}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setTokens({ safe_zone: { ...t.safe_zone, "9:16": SHORTS_ZONE } })}
                >
                  {KIT_TEXTS_ES.shortsProfile}
                </Button>
                <Label className="w-40">
                  Tamaño de subtítulos ({t.caption.size_pct_short_side} % del lado corto)
                  <Range
                    min={4.5}
                    max={12}
                    step={0.5}
                    value={t.caption.size_pct_short_side}
                    onChange={(e) =>
                      setTokens({
                        caption: { ...t.caption, size_pct_short_side: Number(e.target.value) },
                      })
                    }
                  />
                </Label>
              </div>
            </details>
          </Section>
        </div>

        <Section title={KIT_TEXTS_ES.preview} className="md:w-[440px]">
          <TokenPreview kit={draft} {...(lastVideo && { backgroundAssetId: lastVideo })} />
        </Section>
      </div>

      <Section title={KIT_TEXTS_ES.check}>
        <DesignChecklist />
      </Section>
    </div>
  );
}
