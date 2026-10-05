"use client";

import type { RvcRequest, TtsProvider } from "@studio/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { hasAudio, SelectedClipHint, useSelectedClip } from "@/components/common/SelectedClipInfo";
import { Button } from "@/components/ui/button";
import { Checkbox, Label, Range, Select, Textarea } from "@/components/ui/input";
import { ErrorNotice, NotImplementedNotice, Section, Spinner, Tabs } from "@/components/ui/misc";
import { useApiResource } from "@/hooks/use-api-resource";
import { api, errorMessage, isNotImplemented } from "@/lib/api";
import {
  defaultEffect,
  EFFECT_DEFS,
  EFFECT_TYPES,
  effectSummary,
  isBaseVoiceChain,
  VOICE_PRESETS,
  type EditableEffect,
  type EditableEffectType,
} from "@/lib/voice-effects";
import { useJobsStore } from "@/stores/jobs-store";
import { useProjectStore } from "@/stores/project-store";
import { Panel } from "./Panel";

type Tab = "tts" | "effects" | "rvc";

function reportError(action: string, err: unknown) {
  if (isNotImplemented(err)) toast.info(`${action}: módulo en desarrollo`);
  else toast.error(`${action}: error`, { description: errorMessage(err) });
}

function TtsForm() {
  const config = useApiResource(() => api.config());
  const voices = useApiResource(() => api.ttsVoices());
  const [provider, setProvider] = useState<TtsProvider>("piper");
  const [voice, setVoice] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);

  const providerEnabled: Record<TtsProvider, boolean> = {
    piper: true,
    elevenlabs: config.data?.providers.elevenlabs ?? false,
    openai: config.data?.providers.openai ?? false,
  };
  const list = (voices.data ?? []).filter((v) => v.provider === provider);
  const selectedVoice = voice || list[0]?.id || "";

  const submit = async () => {
    if (!text.trim() || !selectedVoice) return;
    setBusy(true);
    try {
      const { jobId } = await api.tts({
        provider,
        text,
        voice: selectedVoice,
        speed,
        format: "wav",
      });
      useJobsStore.getState().track(jobId, "voice.tts", {
        kind: "addToTimeline",
        start: useProjectStore.getState().playhead,
      });
      toast.info("Generando voz…");
    } catch (err) {
      reportError("Texto a voz", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>
        Proveedor
        <Select value={provider} onChange={(e) => setProvider(e.target.value as TtsProvider)}>
          <option value="piper">Piper (local)</option>
          <option value="elevenlabs" disabled={!providerEnabled.elevenlabs}>
            ElevenLabs{providerEnabled.elevenlabs ? "" : " (sin API key)"}
          </option>
          <option value="openai" disabled={!providerEnabled.openai}>
            OpenAI{providerEnabled.openai ? "" : " (sin API key)"}
          </option>
        </Select>
      </Label>
      {voices.status === "not-implemented" ? (
        <NotImplementedNotice what="La lista de voces" />
      ) : null}
      {voices.status === "error" && voices.error ? <ErrorNotice message={voices.error} /> : null}
      <Label>
        Voz
        <Select
          value={selectedVoice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={list.length === 0}
        >
          {list.length === 0 ? <option value="">Sin voces instaladas</option> : null}
          {list.map((v) => (
            <option key={v.id} value={v.id} disabled={!v.installed}>
              {v.name} · {v.language}
              {v.installed ? "" : " (no instalada)"}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Texto
        <Textarea
          rows={4}
          value={text}
          maxLength={20_000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escribe lo que quieres que diga la voz…"
        />
      </Label>
      <Label>
        Velocidad: {speed.toFixed(2)}×
        <Range
          min={0.5}
          max={2}
          step={0.05}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </Label>
      <Button
        size="sm"
        disabled={busy || !text.trim() || !selectedVoice}
        onClick={() => void submit()}
      >
        {busy ? <Spinner /> : null} Generar y añadir al cursor
      </Button>
    </div>
  );
}

function EffectsForm() {
  const sel = useSelectedClip();
  const [chain, setChain] = useState<EditableEffect[]>([]);
  const [busy, setBusy] = useState(false);
  const [addType, setAddType] = useState<EditableEffectType>("pitch");

  const setParam = (index: number, key: string, value: number) =>
    setChain((c) =>
      c.map((e, i) => (i === index ? ({ ...e, [key]: value } as EditableEffect) : e)),
    );

  const apply = async () => {
    if (!hasAudio(sel) || chain.length === 0) return;
    setBusy(true);
    try {
      const { jobId } = await api.voiceEffects({ assetId: sel.clip.assetId, effects: chain });
      useJobsStore
        .getState()
        .track(jobId, "voice.effect", { kind: "replaceClipAsset", clipId: sel.clip.id });
      toast.info("Aplicando efectos…");
    } catch (err) {
      reportError("Efectos de voz", err);
    } finally {
      setBusy(false);
    }
  };

  const applyOnExport = () => {
    if (!sel || !isBaseVoiceChain(chain)) return;
    useProjectStore.getState().updateClip(sel.clip.id, { voiceEffects: chain });
    toast.success("Efectos guardados en el clip (se aplican al exportar)");
  };

  return (
    <div className="flex flex-col gap-3">
      <SelectedClipHint
        sel={sel}
        need="Selecciona un clip de audio o video en la línea de tiempo."
      />
      <Section title="Presets">
        <div className="flex flex-wrap gap-1">
          {VOICE_PRESETS.map((p) => (
            <Button key={p.id} size="xs" variant="outline" onClick={() => setChain(p.effects)}>
              {p.name}
            </Button>
          ))}
        </div>
      </Section>
      <Section
        title="Cadena de efectos"
        actions={
          <div className="flex items-center gap-1">
            <Select
              aria-label="Tipo de efecto"
              className="h-6 w-auto text-xs"
              value={addType}
              onChange={(e) => setAddType(e.target.value as EditableEffectType)}
            >
              {EFFECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EFFECT_DEFS[t].label}
                </option>
              ))}
            </Select>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Añadir efecto"
              onClick={() => setChain((c) => [...c, defaultEffect(addType)])}
            >
              <Plus />
            </Button>
          </div>
        }
      >
        {chain.length === 0 ? (
          <p className="text-xs text-muted-foreground">Elige un preset o añade efectos.</p>
        ) : null}
        {chain.map((effect, i) => (
          <div key={i} className="rounded-md border p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">{EFFECT_DEFS[effect.type].label}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Quitar efecto"
                onClick={() => setChain((c) => c.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
            {EFFECT_DEFS[effect.type].params.map((p) => {
              const value = (effect as Record<string, unknown>)[p.key] as number;
              return (
                <Label key={p.key}>
                  {p.label}: {value}
                  <Range
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={value}
                    onChange={(e) => setParam(i, p.key, Number(e.target.value))}
                  />
                </Label>
              );
            })}
          </div>
        ))}
      </Section>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          disabled={busy || !hasAudio(sel) || chain.length === 0}
          onClick={() => void apply()}
        >
          {busy ? <Spinner /> : null} Aplicar (crea un nuevo audio)
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!sel || chain.length === 0 || !isBaseVoiceChain(chain)}
          title={
            isBaseVoiceChain(chain)
              ? "Guarda la cadena en el clip; se aplica al exportar"
              : "Algunos efectos solo se pueden aplicar creando un nuevo audio"
          }
          onClick={applyOnExport}
        >
          Aplicar al exportar
        </Button>
      </div>
      {sel && sel.clip.voiceEffects.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          En el clip: {sel.clip.voiceEffects.map(effectSummary).join(" → ")}
        </p>
      ) : null}
    </div>
  );
}

function RvcForm() {
  const sel = useSelectedClip();
  const config = useApiResource(() => api.config());
  const models = useApiResource(() => api.rvcModels());
  const [modelId, setModelId] = useState("");
  const [pitchShift, setPitchShift] = useState(0);
  const [indexRate, setIndexRate] = useState(0.75);
  const [f0Method, setF0Method] = useState<RvcRequest["f0Method"]>("rmvpe");
  const [useCuda, setUseCuda] = useState(false);
  const [busy, setBusy] = useState(false);
  const model = modelId || models.data?.[0]?.id || "";

  const submit = async () => {
    if (!hasAudio(sel) || !model) return;
    setBusy(true);
    try {
      const { jobId } = await api.rvc({
        assetId: sel.clip.assetId,
        modelId: model,
        pitchShift,
        indexRate,
        f0Method,
        device: useCuda ? "cuda" : "cpu",
      });
      useJobsStore
        .getState()
        .track(jobId, "voice.rvc", { kind: "replaceClipAsset", clipId: sel.clip.id });
      toast.info("Convirtiendo voz (puede tardar en CPU)…");
    } catch (err) {
      reportError("RVC", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SelectedClipHint sel={sel} need="Selecciona un clip con voz en la línea de tiempo." />
      {models.status === "not-implemented" ? (
        <NotImplementedNotice what="La lista de modelos RVC" />
      ) : null}
      {models.status === "error" && models.error ? <ErrorNotice message={models.error} /> : null}
      <Label>
        Modelo
        <Select
          value={model}
          onChange={(e) => setModelId(e.target.value)}
          disabled={!models.data?.length}
        >
          {!models.data?.length ? <option value="">Sin modelos en models/rvc</option> : null}
          {models.data?.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Cambio de tono: {pitchShift > 0 ? `+${pitchShift}` : pitchShift} semitonos
        <Range
          min={-24}
          max={24}
          step={1}
          value={pitchShift}
          onChange={(e) => setPitchShift(Number(e.target.value))}
        />
      </Label>
      <Label>
        Índice de rasgos: {indexRate.toFixed(2)}
        <Range
          min={0}
          max={1}
          step={0.05}
          value={indexRate}
          onChange={(e) => setIndexRate(Number(e.target.value))}
        />
      </Label>
      <Label>
        Método F0
        <Select
          value={f0Method}
          onChange={(e) => setF0Method(e.target.value as RvcRequest["f0Method"])}
        >
          <option value="rmvpe">rmvpe (recomendado)</option>
          <option value="harvest">harvest</option>
          <option value="pm">pm (rápido)</option>
          <option value="crepe">crepe</option>
        </Select>
      </Label>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={useCuda}
          disabled={!config.data?.useCuda}
          onChange={(e) => setUseCuda(e.target.checked)}
        />
        Usar GPU (CUDA){config.data?.useCuda ? "" : " — no disponible"}
      </label>
      <Button size="sm" disabled={busy || !hasAudio(sel) || !model} onClick={() => void submit()}>
        {busy ? <Spinner /> : null} Convertir voz
      </Button>
    </div>
  );
}

export function VoicePanel() {
  const [tab, setTab] = useState<Tab>("tts");
  return (
    <Panel title="Voz y audio">
      <div className="flex flex-col gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "tts", label: "Texto a voz" },
            { value: "effects", label: "Efectos" },
            { value: "rvc", label: "RVC" },
          ]}
        />
        {tab === "tts" ? <TtsForm /> : tab === "effects" ? <EffectsForm /> : <RvcForm />}
      </div>
    </Panel>
  );
}
