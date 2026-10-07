"use client";

import {
  CONSENT_SCOPE_ES,
  CONSENT_TEXT_VERSION,
  renderConsentText,
  type ConsentMethod,
  type ConsentScope,
  type Person,
} from "@studio/shared";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Label, Select } from "@/components/ui/input";
import { Tabs } from "@/components/ui/misc";
import { endOfDayIso, usePersonsStore } from "@/stores/persons-store";
import { SignaturePad, type SignaturePadHandle } from "./SignaturePad";

/**
 * «Registrar consentimiento»: the versioned text with the name and the scope, signed on screen
 * (canvas) or with an attached signed document, optional expiry and the mandatory checkbox.
 */
export function ConsentForm({ person, onDone }: { person: Person; onDone?: () => void }) {
  const [scope, setScope] = useState<ConsentScope>("face");
  const [method, setMethod] = useState<ConsentMethod>("firma en pantalla");
  const [signer, setSigner] = useState(person.name);
  const [expires, setExpires] = useState("");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [read, setRead] = useState(false);
  const [signed, setSigned] = useState(false);
  const pad = useRef<SignaturePadHandle>(null);
  const busy = usePersonsStore((s) => s.busy);
  const text = renderConsentText(person.name, scope);
  // Audit fix 3: the consent covers the photos / samples loaded NOW (later ones need a new one).
  const photos = scope !== "voice" ? person.photos.length : 0;
  const samples = scope !== "face" ? person.voiceSamples.length : 0;
  const missing =
    (scope !== "voice" && photos === 0 ? "fotos" : "") ||
    (scope !== "face" && samples === 0 ? "muestras de voz" : "");
  const ready =
    read && signer.trim().length > 0 && (method === "firma en pantalla" ? signed : !!file) && !busy;

  const submit = async () => {
    const evidence = method === "firma en pantalla" ? await pad.current?.toBlob() : file;
    if (!evidence) return;
    const ok = await usePersonsStore.getState().addConsent({
      scope,
      method,
      signerName: signer.trim(),
      ...(expires && endOfDayIso(expires) && { expiresAt: endOfDayIso(expires) }),
      evidence,
      evidenceName: method === "firma en pantalla" ? "firma.png" : (file?.name ?? "documento.pdf"),
    });
    if (ok) {
      setRead(false);
      pad.current?.clear();
      setFile(undefined);
      onDone?.();
    }
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label="Registrar consentimiento"
    >
      <div className="grid grid-cols-2 gap-2">
        <Label>
          Alcance
          <Select value={scope} onChange={(e) => setScope(e.target.value as ConsentScope)}>
            {(["face", "voice", "both"] as const).map((s) => (
              <option key={s} value={s}>
                {CONSENT_SCOPE_ES[s]}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Vence (opcional)
          <Input
            type="date"
            value={expires}
            min={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setExpires(e.target.value)}
          />
        </Label>
      </div>
      <blockquote
        className="rounded-md bg-muted/60 p-2 text-xs leading-relaxed"
        data-testid="consent-text"
      >
        {text}
        <span className="mt-1 block text-[10px] text-muted-foreground">
          Texto versión {CONSENT_TEXT_VERSION}
        </span>
      </blockquote>
      <p className="text-[11px] text-muted-foreground" data-testid="consent-coverage">
        Cubre {scope !== "voice" ? `${photos} foto${photos === 1 ? "" : "s"}` : ""}
        {scope === "both" ? " y " : ""}
        {scope !== "face" ? `${samples} muestra${samples === 1 ? "" : "s"} de voz` : ""} cargadas
        ahora. Lo que subas después necesita un consentimiento nuevo.
        {missing ? (
          <span className="block text-amber-700 dark:text-amber-400">
            Todavía no hay {missing}: subilas antes de registrar el consentimiento.
          </span>
        ) : null}
      </p>
      <Tabs<ConsentMethod>
        value={method}
        onChange={setMethod}
        items={[
          { value: "firma en pantalla", label: "Firma en pantalla" },
          { value: "documento adjunto", label: "Documento adjunto" },
        ]}
      />
      {method === "firma en pantalla" ? (
        <SignaturePad ref={pad} onChange={(empty) => setSigned(!empty)} />
      ) : (
        <Label>
          Documento firmado (PDF, JPG o PNG, hasta 20 MB)
          <Input
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={(e) => setFile(e.target.files?.[0])}
          />
        </Label>
      )}
      <Label>
        Nombre de quien firma
        <Input value={signer} maxLength={120} onChange={(e) => setSigner(e.target.value)} />
      </Label>
      <label className="flex items-start gap-2 text-xs">
        <Checkbox checked={read} onChange={(e) => setRead(e.target.checked)} />
        <span>Leí este texto con la persona y lo acepta</span>
      </label>
      <div className="flex justify-end">
        <Button size="sm" disabled={!ready} onClick={() => void submit()}>
          Registrar consentimiento
        </Button>
      </div>
    </div>
  );
}
