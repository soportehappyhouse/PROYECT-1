"use client";

import {
  activeConsent,
  CONSENT_SCOPE_ES,
  consentCoversItem,
  consentExpired,
  consentReason,
  revocableConsents,
  type Consent,
  type ConsentAuditRow,
  type ConsentState,
  type Person,
} from "@studio/shared";
import { Mic, Plus, Square, Trash2, Upload, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, ErrorNotice, Section, Spinner } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { personsApi } from "@/lib/api-persons";
import { cn } from "@/lib/utils";
import { usePersonsStore } from "@/stores/persons-store";
import { ConsentForm } from "./ConsentForm";

const STATE_TONE: Record<ConsentState, "success" | "warning" | "danger" | "muted"> = {
  vigente: "success",
  vencido: "warning",
  revocado: "danger",
  "sin consentimiento": "muted",
};

export function ConsentBadge({ label, state }: { label: string; state: ConsentState }) {
  return (
    <Badge tone={STATE_TONE[state]} title={`${label}: ${state}`}>
      {label}: {state}
    </Badge>
  );
}

const fmtDate = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" })
    : "";

function consentRowState(c: Consent): ConsentState {
  if (c.revoked_at) return "revocado";
  if (consentExpired(c)) return "vencido";
  return "vigente";
}

const READ_PHRASE =
  "Che, ¿viste que mañana llueve? Yo llevo el paraguas, vos traé el mate y nos vemos en la plaza a las cinco.";

function VoiceRecorder({ onBlob }: { onBlob: (b: Blob) => void }) {
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | undefined>(undefined);
  const supported = typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined";
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const r = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      onBlob(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
    };
    rec.current = r;
    r.start();
    setRecording(true);
    setTimeout(() => r.state === "recording" && r.stop(), 10_000);
  };
  if (!supported) return null;
  return recording ? (
    <Button size="xs" variant="destructive" onClick={() => rec.current?.stop()}>
      <Square /> Detener
    </Button>
  ) : (
    <Button size="xs" variant="outline" onClick={() => void start()}>
      <Mic /> Grabar 10 s
    </Button>
  );
}

function PersonDetail({ person }: { person: Person }) {
  const busy = usePersonsStore((s) => s.busy);
  const [showConsent, setShowConsent] = useState(person.consents.length === 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<"face" | "voice" | "all" | undefined>();
  const [name, setName] = useState(person.name);
  const [notes, setNotes] = useState(person.notes ?? "");
  const [drag, setDrag] = useState(false);
  const store = usePersonsStore.getState();
  useEffect(() => {
    setName(person.name);
    setNotes(person.notes ?? "");
  }, [person.id, person.name, person.notes]);
  const uploadFiles = async (files: FileList | File[] | null) => {
    for (const f of [...(files ?? [])]) await store.uploadPhoto(f);
  };
  const face = activeConsent(person, "face");
  const voice = activeConsent(person, "voice");
  const canRevoke = {
    face: revocableConsents(person, "face").length > 0,
    voice: revocableConsents(person, "voice").length > 0,
    all: revocableConsents(person, "all").length > 0,
  };
  const REVOKE_ES = {
    face: "¿Revocar el rostro? Se revocan todos sus consentimientos de rostro (uno de «rostro y voz» se revoca entero, también la voz).",
    voice:
      "¿Revocar la voz? Se revocan todos sus consentimientos de voz (uno de «rostro y voz» se revoca entero, también el rostro).",
    all: "¿Revocar todo? Se revocan todos sus consentimientos.",
  } as const;
  return (
    <div className="flex flex-col gap-4" aria-label={`Persona ${person.name}`}>
      <div className="grid grid-cols-2 gap-2">
        <Label>
          Nombre
          <Input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() && name !== person.name && void store.update({ name: name.trim() })
            }
          />
        </Label>
        <Label>
          Notas
          <Textarea
            value={notes}
            maxLength={2000}
            className="min-h-9"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (person.notes ?? "") && void store.update({ notes })}
          />
        </Label>
      </div>
      <div className="flex flex-wrap gap-1">
        <ConsentBadge label="Rostro" state={face ? "vigente" : stateOf(person, "face")} />
        <ConsentBadge label="Voz" state={voice ? "vigente" : stateOf(person, "voice")} />
        {busy ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Spinner className="size-3" /> {busy}…
          </span>
        ) : null}
      </div>

      <Section title={`Fotos (${person.photos.length}/10)`}>
        <div
          className={cn(
            "flex flex-wrap gap-2 rounded-md border border-dashed p-2",
            drag && "border-primary bg-primary/5",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void uploadFiles(e.dataTransfer.files);
          }}
        >
          {person.photos.map((ph) => (
            <figure key={ph.id} className="relative w-20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={personsApi.photoUrl(person.id, ph.id)}
                crossOrigin="anonymous"
                alt={`Foto de ${person.name}`}
                className="h-20 w-20 rounded object-cover"
              />
              <figcaption className="text-[10px] text-muted-foreground">
                {ph.faces === null ? "caras: ?" : `${ph.faces} cara${ph.faces === 1 ? "" : "s"}`}
                {face && !consentCoversItem(face, "photo", ph) ? (
                  <span className="block text-amber-700 dark:text-amber-400">
                    sin consentimiento para esta foto
                  </span>
                ) : null}
              </figcaption>
              <Button
                size="icon-sm"
                variant="ghost"
                className="absolute right-0 top-0 bg-background/70"
                aria-label="Borrar foto"
                onClick={() => void store.deletePhoto(ph.id)}
              >
                <Trash2 />
              </Button>
            </figure>
          ))}
          <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded border text-[10px] text-muted-foreground hover:bg-accent">
            <Upload className="size-4" />
            Subir o arrastrar
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="sr-only"
              aria-label="Subir fotos"
              onChange={(e) => void uploadFiles(e.target.files)}
            />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          JPG, PNG o WebP de hasta 15 MB, con la cara bien visible (de frente y con buena luz).
        </p>
      </Section>

      <Section title={`Muestras de voz (${person.voiceSamples.length}/5)`}>
        <ul className="flex flex-col gap-1">
          {person.voiceSamples.map((v) => (
            <li key={v.id} className="flex items-center gap-2 text-xs">
              <audio
                controls
                crossOrigin="anonymous"
                src={personsApi.voiceUrl(person.id, v.id)}
                className="h-7 flex-1"
              />
              <span className="tabular-nums">{v.durationSec.toFixed(1)} s</span>
              {voice && !consentCoversItem(voice, "sample", v) ? (
                <span className="text-[10px] text-amber-700 dark:text-amber-400">
                  sin consentimiento para esta muestra
                </span>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Borrar muestra"
                onClick={() => void store.deleteVoice(v.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <VoiceRecorder onBlob={(b) => void store.uploadVoice(b, "grabacion.webm")} />
          <label className="inline-flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-accent">
            <Upload className="size-3.5" /> Subir audio
            <input
              type="file"
              accept="audio/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void store.uploadVoice(f, f.name);
              }}
            />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Entre 5 y 60 s de voz clara. Para grabar, que lea: «{READ_PHRASE}»
        </p>
      </Section>

      <Section
        title="Consentimientos"
        actions={
          <div className="flex flex-wrap gap-1">
            {(["face", "voice", "all"] as const).map((sc) =>
              canRevoke[sc] ? (
                <Button
                  key={sc}
                  size="xs"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => setConfirmRevoke(sc)}
                >
                  {sc === "face"
                    ? "Revocar rostro"
                    : sc === "voice"
                      ? "Revocar voz"
                      : "Revocar todo"}
                </Button>
              ) : null,
            )}
            <Button size="xs" variant="outline" onClick={() => setShowConsent((v) => !v)}>
              <Plus /> Registrar consentimiento
            </Button>
          </div>
        }
      >
        {confirmRevoke ? (
          <ErrorNotice
            message={REVOKE_ES[confirmRevoke]}
            action={
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    const sc = confirmRevoke;
                    setConfirmRevoke(undefined);
                    void store.revokeScope(sc);
                  }}
                >
                  Sí, revocar
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(undefined)}>
                  Cancelar
                </Button>
              </div>
            }
          />
        ) : null}
        {person.consents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Sin consentimiento no se puede usar su cara ni su voz.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border text-xs">
            {[...person.consents].reverse().map((c) => {
              const st = consentRowState(c);
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                  <Badge tone={STATE_TONE[st]}>{st}</Badge>
                  <span className="font-medium">{CONSENT_SCOPE_ES[c.scope]}</span>
                  <span className="text-muted-foreground">
                    {c.method} · firmó {c.signer_name}
                    {c.signer_name !== person.name
                      ? ` (la Persona ahora se llama «${person.name}»)`
                      : ""}
                    {" · "}
                    {fmtDate(c.accepted_at)}
                    {c.expires_at ? ` · vence ${fmtDate(c.expires_at)}` : ""}
                    {c.revoked_at ? ` · revocado ${fmtDate(c.revoked_at)}` : ""}
                    {coverage(c)}
                  </span>
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => void openEvidence(person.id, c.id)}
                  >
                    evidencia
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {showConsent ? <ConsentForm person={person} onDone={() => setShowConsent(false)} /> : null}
        <AuditLog personId={person.id} />
      </Section>

      <Section title="Borrar persona">
        {confirmDelete ? (
          <ErrorNotice
            message={`¿Borrar a «${person.name}»? Se borran sus fotos y muestras de voz; los consentimientos se archivan (no se pueden usar más).`}
            action={
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => void store.remove(person.id)}
                >
                  Sí, borrar
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancelar
                </Button>
              </div>
            }
          />
        ) : (
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 /> Borrar persona
          </Button>
        )}
      </Section>
    </div>
  );
}

/** State of `need` with the shared rule (the most recent consent covering it is authoritative). */
function stateOf(person: Person, need: "face" | "voice"): ConsentState {
  const reason = consentReason(person, need);
  if (reason === undefined) return "vigente";
  if (reason === "revoked") return "revocado";
  if (reason === "expired") return "vencido";
  return "sin consentimiento";
}

/** « · cubre 2 fotos y 1 muestra» (consents made before the binding cover everything). */
function coverage(c: Consent): string {
  if (!c.photo_ids && !c.sample_ids) return "";
  const parts = [];
  if (c.photo_ids?.length)
    parts.push(`${c.photo_ids.length} foto${c.photo_ids.length === 1 ? "" : "s"}`);
  if (c.sample_ids?.length)
    parts.push(`${c.sample_ids.length} muestra${c.sample_ids.length === 1 ? "" : "s"}`);
  return parts.length ? ` · cubre ${parts.join(" y ")}` : " · no cubre fotos ni muestras";
}

/** Evidence through fetch (the api only hands biometric files to the web: Origin required). */
async function openEvidence(personId: string, consentId: string) {
  const win = window.open("", "_blank");
  try {
    const blob = await personsApi.evidenceBlob(personId, consentId);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    win?.close();
    toast.error("No se pudo abrir la evidencia", { description: errorMessage(err) });
  }
}

const AUDIT_ES: Record<string, string> = {
  "person.create": "Persona creada",
  "person.rename": "Nombre cambiado",
  "person.photo.add": "Foto agregada",
  "person.photo.delete": "Foto borrada",
  "person.voice.add": "Muestra de voz agregada",
  "person.voice.delete": "Muestra de voz borrada",
  "consent.create": "Consentimiento registrado",
  "consent.revoke": "Consentimiento revocado",
  "face.preview": "Vista previa de cambio de cara",
  "face.swap": "Cambio de cara",
  "face.swap.done": "Cambio de cara terminado",
  "face.undo": "Cambio de cara deshecho",
  "voice.clone": "Voz clonada",
  "perf.facefusion": "Test de rendimiento con su foto",
};

/** «Auditoría»: append-only history of this Person (hash chain checked by the api). */
function AuditLog({ personId }: { personId: string }) {
  const [rows, setRows] = useState<ConsentAuditRow[] | undefined>();
  const [chainOk, setChainOk] = useState<boolean | undefined>();
  const [open, setOpen] = useState(false);
  const load = async () => {
    setOpen(true);
    try {
      const res = await personsApi.audit(personId);
      setRows(res.rows);
      setChainOk(res.chain.ok);
    } catch (err) {
      toast.error("No se pudo leer la auditoría", { description: errorMessage(err) });
    }
  };
  if (!open)
    return (
      <Button size="xs" variant="ghost" className="self-start" onClick={() => void load()}>
        Ver auditoría
      </Button>
    );
  return (
    <div className="flex flex-col gap-1 text-[11px]" aria-label="Auditoría">
      {chainOk === false ? (
        <ErrorNotice message="La auditoría fue modificada por fuera de Studio (la cadena de hashes no coincide)." />
      ) : null}
      <ul className="max-h-40 overflow-auto rounded-md border p-1">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="flex gap-2">
            <span className="tabular-nums text-muted-foreground">
              {new Date(r.at).toLocaleString("es-AR")}
            </span>
            <span>{AUDIT_ES[r.action] ?? r.action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Ajustes → «Personas»: people whose face or voice may be used, with their consent history. Nothing
 * of this leaves the PC; the files live in storage/consent/ and are only read through the api.
 */
export function PersonsTab() {
  const list = usePersonsStore((s) => s.list);
  const status = usePersonsStore((s) => s.status);
  const error = usePersonsStore((s) => s.error);
  const selectedId = usePersonsStore((s) => s.selectedId);
  const person = usePersonsStore((s) => s.person);
  const [name, setName] = useState("");
  useEffect(() => {
    void usePersonsStore.getState().refresh();
  }, []);
  const create = async () => {
    if (!name.trim()) return;
    const p = await usePersonsStore.getState().create(name.trim());
    if (p) setName("");
  };
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Solo se puede usar la cara o la voz de una Persona con un consentimiento vigente (firmado en
        pantalla o con un documento). Revocarlo bloquea los usos nuevos. Todo queda en esta PC.
      </p>
      <div className="flex gap-2">
        <Input
          placeholder="Nombre de la persona (p. ej. Martín Ruiz, doble de riesgo)"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <Button size="sm" disabled={!name.trim()} onClick={() => void create()}>
          <Plus /> Nueva persona
        </Button>
      </div>
      {status === "error" && error ? <ErrorNotice message={error} /> : null}
      <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-4">
        <ul className="flex flex-col gap-1" aria-label="Personas registradas">
          {status === "ready" && list.length === 0 ? (
            <EmptyState>Todavía no hay Personas registradas.</EmptyState>
          ) : null}
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                aria-pressed={selectedId === p.id}
                onClick={() => void usePersonsStore.getState().select(p.id)}
                className={cn(
                  "flex w-full flex-col items-start gap-1 rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent",
                  selectedId === p.id && "border-primary bg-primary/5",
                )}
              >
                <span className="inline-flex items-center gap-1 font-medium">
                  <UserRound className="size-3.5" /> {p.name}
                </span>
                <span className="flex flex-wrap gap-1">
                  <ConsentBadge label="Rostro" state={p.face} />
                  <ConsentBadge label="Voz" state={p.voice} />
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {p.photos} foto(s) · {p.voiceSamples} muestra(s)
                  {p.expires_at ? ` · vence ${fmtDate(p.expires_at)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div>
          {person ? (
            <PersonDetail key={person.id} person={person} />
          ) : selectedId ? (
            <Spinner />
          ) : (
            <EmptyState>Elegí una Persona o creá una nueva.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
