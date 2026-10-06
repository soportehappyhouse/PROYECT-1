"use client";

import { FACE_SWAPPER_INFO, FaceSwapperModelSchema, type FaceSwapperModel } from "@studio/shared";
import { ArrowLeft, ArrowRight, ScanFace, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Label, Range, Select } from "@/components/ui/input";
import { Badge, ErrorNotice, Progress, Spinner } from "@/components/ui/misc";
import { fileUrl, openLicenceDialog } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { clipEnd } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import {
  canAdvance,
  estimateMinutes,
  FACE_STEPS,
  faceClipContext,
  useFaceStore,
  type FaceError,
} from "@/stores/face-store";
import { useJobsStore } from "@/stores/jobs-store";
import { openReport } from "@/stores/report-store";
import { useSettingsStore } from "@/stores/settings-store";

function openPersons() {
  useFaceStore.getState().close();
  useSettingsStore.getState().setSettingsOpen(true, "persons");
}

/** Error box with the follow-up the contract asks for (Personas, licencia, reportar). */
export function FaceErrorNotice({ error }: { error: FaceError }) {
  const action =
    error.code === "CONSENT_REQUIRED" || error.code === "PERSON_NOT_FOUND" ? (
      <Button size="xs" variant="outline" className="mt-2" onClick={openPersons}>
        Abrir Personas
      </Button>
    ) : error.code === "LICENCE_REQUIRED" ? (
      <Button
        size="xs"
        variant="outline"
        className="mt-2"
        onClick={() => openLicenceDialog("faceswap")}
      >
        Leer y aceptar la licencia
      </Button>
    ) : error.code === "CONTENT_BLOCKED" || error.code === "TOOL_FAILED" || error.jobId ? (
      <Button
        size="xs"
        variant="outline"
        className="mt-2"
        onClick={() =>
          openReport({
            title: `Cambiar cara: ${error.code ?? "error"}`,
            ...(error.jobId && { jobIds: [error.jobId] }),
            source: "fallo",
          })
        }
      >
        Reportar error
      </Button>
    ) : undefined;
  return <ErrorNotice message={error.message} action={action} />;
}

function Steps() {
  const step = useFaceStore((s) => s.step);
  const index = FACE_STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex gap-1 text-[11px]" aria-label="Pasos">
      {FACE_STEPS.map((s, i) => (
        <li
          key={s.id}
          aria-current={s.id === step ? "step" : undefined}
          className={cn(
            "flex-1 rounded px-2 py-1 text-center",
            i < index
              ? "bg-primary/15 text-primary"
              : i === index
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground",
          )}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

function PersonStep() {
  const persons = useFaceStore((s) => s.persons);
  const loading = useFaceStore((s) => s.personsLoading);
  const personId = useFaceStore((s) => s.personId);
  const licence = useFaceStore((s) => s.licenceAccepted);
  return (
    <div className="flex flex-col gap-3">
      {licence === false ? (
        <ErrorNotice
          message="Para usar el cambio de cara tenés que leer y aceptar su licencia (modelos no comerciales + OpenRAIL-AS)."
          action={
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={() => openLicenceDialog("faceswap")}
            >
              Leer y aceptar la licencia
            </Button>
          }
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        Solo aparecen las Personas con un consentimiento de rostro vigente.
      </p>
      {loading ? <Spinner /> : null}
      <ul className="flex flex-col gap-1" role="radiogroup" aria-label="Persona">
        {persons.map((p) => (
          <li key={p.id}>
            <label
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm",
                personId === p.id && "border-primary bg-primary/5",
              )}
            >
              <input
                type="radio"
                name="face-person"
                checked={personId === p.id}
                onChange={() => useFaceStore.getState().selectPerson(p.id)}
              />
              <span className="flex-1 font-medium">{p.name}</span>
              <span className="text-[11px] text-muted-foreground">{p.photos} foto(s)</span>
              <Badge tone="success">rostro: vigente</Badge>
            </label>
          </li>
        ))}
      </ul>
      {!loading && persons.length === 0 ? (
        <p className="text-xs">No hay ninguna Persona con consentimiento de rostro vigente.</p>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        className="self-start text-primary underline"
        onClick={openPersons}
      >
        Registrar persona
      </Button>
    </div>
  );
}

function FaceStep() {
  const clipId = useFaceStore((s) => s.clipId);
  const detect = useFaceStore((s) => s.detect);
  const detecting = useFaceStore((s) => s.detecting);
  const error = useFaceStore((s) => s.detectError);
  const faceIndex = useFaceStore((s) => s.faceIndex);
  const t = useFaceStore((s) => s.t);
  const [slider, setSlider] = useState(t);
  useEffect(() => setSlider(t), [t]);
  const ctx = faceClipContext(clipId);
  if (!ctx) return null;
  const end = clipEnd(ctx.clip);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Hacé clic en la cara que querés cambiar (se elige en este fotograma y se sigue en todo el
        clip).
      </p>
      <div className="relative overflow-hidden rounded-md border bg-black">
        {detect ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(detect.framePath)} alt="Fotograma elegido" className="block w-full" />
        ) : (
          <div className="flex aspect-video items-center justify-center text-xs text-white/70">
            {detecting ? <Spinner /> : "Sin fotograma"}
          </div>
        )}
        {detect?.faces.map((f) => (
          <button
            key={f.index}
            type="button"
            aria-label={`Cara ${f.index + 1}`}
            aria-pressed={faceIndex === f.index}
            onClick={() => useFaceStore.getState().pickFace(f.index)}
            className={cn(
              "absolute rounded border-2",
              faceIndex === f.index
                ? "border-primary bg-primary/20"
                : "border-white/80 hover:bg-white/10",
            )}
            style={{
              left: `${f.box.x * 100}%`,
              top: `${f.box.y * 100}%`,
              width: `${f.box.w * 100}%`,
              height: `${f.box.h * 100}%`,
            }}
          >
            <span className="absolute -top-5 left-0 rounded bg-black/70 px-1 text-[10px] text-white">
              {f.index + 1}
            </span>
          </button>
        ))}
      </div>
      <Label>
        Otro momento del clip: {formatTime(slider)}
        <Range
          min={ctx.clip.start}
          max={Math.max(ctx.clip.start, end - 0.04)}
          step={0.04}
          value={slider}
          onChange={(e) => setSlider(Number(e.target.value))}
          onPointerUp={() => void useFaceStore.getState().detectAt(slider)}
          onKeyUp={() => void useFaceStore.getState().detectAt(slider)}
        />
      </Label>
      {detect && detect.faces.length === 1 ? (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={faceIndex === undefined}
            onChange={(e) => useFaceStore.getState().pickFace(e.target.checked ? undefined : 0)}
          />
          Es la única cara del clip (cambiar la que aparezca)
        </label>
      ) : null}
      {error ? <FaceErrorNotice error={error} /> : null}
    </div>
  );
}

function OptionsStep() {
  const options = useFaceStore((s) => s.options);
  const preview = useFaceStore((s) => s.preview);
  const previewing = useFaceStore((s) => s.previewing);
  const error = useFaceStore((s) => s.previewError);
  const set = useFaceStore.getState().setOptions;
  return (
    <div className="flex flex-col gap-3">
      <Label>
        Modelo
        <Select
          value={options.model}
          onChange={(e) => set({ model: e.target.value as FaceSwapperModel })}
        >
          {FaceSwapperModelSchema.options.map((m) => (
            <option key={m} value={m}>
              {FACE_SWAPPER_INFO[m].name_es} — licencia {FACE_SWAPPER_INFO[m].licence}
              {FACE_SWAPPER_INFO[m].pack !== "faceswap" ? " (paquete extra)" : ""}
            </option>
          ))}
        </Select>
      </Label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={options.enhancer}
            onChange={(e) => set({ enhancer: e.target.checked })}
          />
          Mejorar la nitidez de la cara (GFPGAN)
        </label>
        <Label>
          Mezcla del mejorador: {options.enhancerBlend} %
          <Range
            min={0}
            max={100}
            step={5}
            disabled={!options.enhancer}
            value={options.enhancerBlend}
            onChange={(e) => set({ enhancerBlend: Number(e.target.value) })}
          />
        </Label>
      </div>
      <Label>
        Intensidad: {Math.round(options.strength * 100)} %
        <Range
          min={0.1}
          max={1}
          step={0.05}
          value={options.strength}
          onChange={(e) => set({ strength: Number(e.target.value) })}
        />
      </Label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={previewing}
          onClick={() => void useFaceStore.getState().runPreview()}
        >
          {previewing ? <Spinner /> : <ScanFace />} Vista previa de 1 fotograma
        </Button>
        {preview ? (
          <Badge tone="muted">
            {preview.device === "cuda" ? "GPU" : "CPU"} · {(preview.ms / 1000).toFixed(1)} s
          </Badge>
        ) : null}
      </div>
      {preview ? (
        <div className="grid grid-cols-2 gap-2" aria-label="Vista previa antes y después">
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(preview.beforePath)} alt="Antes" className="w-full rounded border" />
            <figcaption className="text-center text-[11px] text-muted-foreground">Antes</figcaption>
          </figure>
          <figure>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(preview.afterPath)} alt="Después" className="w-full rounded border" />
            <figcaption className="text-center text-[11px] text-muted-foreground">
              Después
            </figcaption>
          </figure>
        </div>
      ) : null}
      {error ? <FaceErrorNotice error={error} /> : null}
    </div>
  );
}

function ApplyStep() {
  const clipId = useFaceStore((s) => s.clipId);
  const confirmed = useFaceStore((s) => s.confirmed);
  const applying = useFaceStore((s) => s.applying);
  const result = useFaceStore((s) => s.result);
  const error = useFaceStore((s) => s.applyError);
  const fps = useFaceStore((s) => s.perfFps);
  const jobId = useFaceStore((s) => s.progressJobId);
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const ctx = faceClipContext(clipId);
  const seconds = ctx ? ctx.clip.out - ctx.clip.in : 0;
  const minutes = estimateMinutes(seconds, ctx?.asset?.fps, fps);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs">
        Se procesan {formatTime(seconds)} de video y el clip pasa a mostrar el resultado (queda
        marcado como contenido alterado con IA y se puede deshacer).
        {minutes !== undefined
          ? ` Tiempo estimado: ≈ ${minutes} min.`
          : " En CPU puede tardar entre 15 y 60 minutos por minuto de video."}
      </p>
      <label className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
        <Checkbox
          checked={confirmed}
          onChange={(e) => useFaceStore.getState().setConfirmed(e.target.checked)}
        />
        <span className="inline-flex items-start gap-1">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          La persona dio su consentimiento y nadie en el video es menor de edad
        </span>
      </label>
      {applying ? (
        <div className="flex flex-col gap-1">
          <Progress value={job?.progress ?? 0.02} />
          <span className="text-[11px] text-muted-foreground">{job?.message ?? "En cola…"}</span>
        </div>
      ) : null}
      {result ? (
        <p className="text-xs text-emerald-600">
          Listo: {result.frames} fotogramas ({result.device === "cuda" ? "GPU" : "CPU"}). El clip ya
          muestra la cara nueva.
        </p>
      ) : null}
      {error ? <FaceErrorNotice error={error} /> : null}
    </div>
  );
}

/** «Cambiar cara» (clip context menu, Propiedades button, command palette; no shortcut). */
export function FaceSwapWizard() {
  const open = useFaceStore((s) => s.open);
  const step = useFaceStore((s) => s.step);
  const applying = useFaceStore((s) => s.applying);
  const result = useFaceStore((s) => s.result);
  const state = useFaceStore();
  useEffect(() => {
    const onAccepted = () => useFaceStore.setState({ licenceAccepted: true });
    window.addEventListener("studio:licence:accepted", onAccepted);
    return () => window.removeEventListener("studio:licence:accepted", onAccepted);
  }, []);
  const store = useFaceStore.getState();
  return (
    <Dialog open={open} onClose={() => store.close()} title="Cambiar cara">
      <div className="flex flex-col gap-4">
        <Steps />
        {step === "person" ? (
          <PersonStep />
        ) : step === "face" ? (
          <FaceStep />
        ) : step === "options" ? (
          <OptionsStep />
        ) : (
          <ApplyStep />
        )}
        <div className="flex items-center justify-between border-t pt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={step === "person" || applying}
            onClick={() => store.back()}
          >
            <ArrowLeft /> Atrás
          </Button>
          {step === "apply" ? (
            result ? (
              <Button size="sm" onClick={() => store.close()}>
                Cerrar
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canAdvance(state) || applying}
                onClick={() => void store.apply()}
              >
                {applying ? <Spinner /> : <ScanFace />} Aplicar cambio de cara
              </Button>
            )
          ) : (
            <Button size="sm" disabled={!canAdvance(state)} onClick={() => store.next()}>
              Siguiente <ArrowRight />
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
