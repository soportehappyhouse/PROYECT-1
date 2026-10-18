"use client";

import type { SafeZone } from "@studio/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label, Range } from "@/components/ui/input";
import { DESIGN_TEXTS_ES, GLOSSARY_ES } from "@studio/shared";
import { KIT_TEXTS_ES, SIDE_LABELS_ES } from "./texts";

/**
 * «Calibrar con una captura»: a screenshot of Reels/TikTok from the user's phone behind a 9:16
 * frame; 4 sliders move the guides to the app's buttons and texts. The result is a guide.
 */
export function SafeZoneCalibrator({
  value,
  onSave,
  onCancel,
}: {
  value: SafeZone;
  onSave: (zone: SafeZone) => void;
  onCancel: () => void;
}) {
  const [zone, setZone] = useState<SafeZone>(value);
  const [shot, setShot] = useState<string>();
  useEffect(
    () => () => {
      if (shot) URL.revokeObjectURL(shot);
    },
    [shot],
  );
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border p-3"
      data-testid="calibrator"
    >
      <p className="text-xs text-muted-foreground">{KIT_TEXTS_ES.calibrateHelp}</p>
      <input
        type="file"
        accept="image/png,image/jpeg"
        aria-label="Captura del teléfono"
        className="text-xs"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setShot(URL.createObjectURL(f));
        }}
      />
      <div className="flex gap-3">
        <div
          className="relative w-40 shrink-0 overflow-hidden rounded-md bg-muted"
          style={{ aspectRatio: "9 / 16" }}
        >
          {shot ? (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL
            <img
              src={shot}
              alt="Captura del teléfono"
              className="absolute inset-0 size-full object-cover"
            />
          ) : null}
          <SafeZoneOverlay zone={zone} />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          {(Object.keys(SIDE_LABELS_ES) as (keyof SafeZone)[]).map((side) => (
            <Label key={side}>
              {SIDE_LABELS_ES[side]}: {zone[side]} %
              <Range
                min={0}
                max={45}
                step={1}
                value={zone[side]}
                aria-label={`Zona segura ${SIDE_LABELS_ES[side].toLowerCase()}`}
                onChange={(e) => setZone((z) => ({ ...z, [side]: Number(e.target.value) }))}
              />
            </Label>
          ))}
          <p className="text-[11px] text-muted-foreground">{DESIGN_TEXTS_ES.safeZoneGuide}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(zone)}>
          {KIT_TEXTS_ES.calibrateSave}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {KIT_TEXTS_ES.calibrateCancel}
        </Button>
        <span className="sr-only">{GLOSSARY_ES.actions.calibrate}</span>
      </div>
    </div>
  );
}

/** Translucent bands outside the safe zone (guide). */
export function SafeZoneOverlay({ zone }: { zone: SafeZone }) {
  const band = "absolute bg-[var(--safe-zone-band)] pointer-events-none";
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden data-testid="safe-zone">
      <div className={band} style={{ left: 0, right: 0, top: 0, height: `${zone.top}%` }} />
      <div className={band} style={{ left: 0, right: 0, bottom: 0, height: `${zone.bottom}%` }} />
      <div
        className={band}
        style={{ left: 0, top: `${zone.top}%`, bottom: `${zone.bottom}%`, width: `${zone.left}%` }}
      />
      <div
        className={band}
        style={{
          right: 0,
          top: `${zone.top}%`,
          bottom: `${zone.bottom}%`,
          width: `${zone.right}%`,
        }}
      />
      <div
        className="absolute border border-dashed border-[var(--safe-zone-line)]"
        style={{
          top: `${zone.top}%`,
          bottom: `${zone.bottom}%`,
          left: `${zone.left}%`,
          right: `${zone.right}%`,
        }}
      />
    </div>
  );
}
