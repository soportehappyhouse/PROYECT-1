"use client";

import {
  SUGGESTION_KIND_LABELS_ES,
  SUGGESTION_SETTINGS_ES,
  type SuggestionKind,
  type SuggestionSettings,
} from "@studio/shared";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Label } from "@/components/ui/input";
import { Badge, Section } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { suggestionsApi } from "@/lib/api-suggestions";
import { useSuggestionsStore } from "@/stores/suggestions-store";

/**
 * Integration S6 (M3 cross request 6): Ajustes → Asistente → «Sugerencias al importar»: turn the
 * import analysis on/off and bring back the kinds silenced with «No sugerir más».
 */
export function SuggestionSettingsSection() {
  const [settings, setSettings] = useState<SuggestionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    suggestionsApi
      .settings()
      .then((s) => alive && setSettings(s))
      .catch((err: unknown) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, []);

  const save = async (next: SuggestionSettings) => {
    const before = settings;
    setSettings(next);
    try {
      setSettings(await suggestionsApi.saveSettings(next));
      if (useSuggestionsStore.getState().projectId) void useSuggestionsStore.getState().load();
    } catch (err) {
      setSettings(before);
      toast.error("No se pudo guardar", { description: errorMessage(err) });
    }
  };

  return (
    <Section title={SUGGESTION_SETTINGS_ES.title}>
      <div className="flex flex-col gap-2 text-sm" data-testid="suggestion-settings">
        <p className="text-[11px] text-muted-foreground">{SUGGESTION_SETTINGS_ES.help}</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {settings ? (
          <>
            <Label className="flex-row items-center gap-2">
              <Checkbox
                checked={settings.enabled}
                onChange={(e) => void save({ ...settings, enabled: e.target.checked })}
              />
              {SUGGESTION_SETTINGS_ES.enabled}
            </Label>
            {settings.mutedKinds.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {SUGGESTION_SETTINGS_ES.noneMuted}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" aria-label={SUGGESTION_SETTINGS_ES.muted}>
                {settings.mutedKinds.map((k: SuggestionKind) => (
                  <li key={k} className="flex items-center gap-2" data-testid="muted-kind">
                    <Badge tone="muted">{SUGGESTION_KIND_LABELS_ES[k]}</Badge>
                    <span className="flex-1 text-[11px] text-muted-foreground">
                      {SUGGESTION_SETTINGS_ES.mutedHint}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="unmute-kind"
                      onClick={() =>
                        void save({
                          ...settings,
                          mutedKinds: settings.mutedKinds.filter((x) => x !== k),
                        })
                      }
                    >
                      <RotateCcw /> {SUGGESTION_SETTINGS_ES.unmute}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </Section>
  );
}
