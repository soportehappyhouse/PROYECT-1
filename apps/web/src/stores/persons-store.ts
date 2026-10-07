import type {
  ConsentMethod,
  ConsentScope,
  LicenceId,
  LicenceStatus,
  Person,
  PersonSummary,
} from "@studio/shared";
import { CONSENT_TEXT_VERSION } from "@studio/shared";
import { toast } from "sonner";
import { create } from "zustand";
import { errorMessage } from "@/lib/api";
import { licencesApi, personsApi } from "@/lib/api-persons";
import { addBreadcrumb } from "./breadcrumbs-store";

/**
 * Sprint 4 M1 «Personas» (Ajustes → Personas) + the on-screen licences. The api is the source of
 * truth (storage/consent/ never reaches the browser except through /api/persons/...): every action
 * re-reads the Person it changed.
 */

export interface NewConsent {
  scope: ConsentScope;
  method: ConsentMethod;
  signerName: string;
  expiresAt?: string;
  evidence: Blob;
  evidenceName: string;
}

interface PersonsState {
  list: PersonSummary[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | undefined;
  selectedId: string | undefined;
  person: Person | undefined;
  busy: string | undefined;
  licences: LicenceStatus[];
  licenceDialog: { open: boolean; licenceId: LicenceId };
  refresh: () => Promise<void>;
  select: (id: string | undefined) => Promise<void>;
  create: (name: string, notes?: string) => Promise<Person | undefined>;
  update: (patch: { name?: string; notes?: string }) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
  uploadPhoto: (file: File) => Promise<boolean>;
  deletePhoto: (photoId: string) => Promise<void>;
  uploadVoice: (file: Blob, name: string) => Promise<boolean>;
  deleteVoice: (sampleId: string) => Promise<void>;
  addConsent: (c: NewConsent) => Promise<boolean>;
  revokeConsent: (consentId: string) => Promise<void>;
  /** «Revocar rostro» | «Revocar voz» | «Revocar todo». */
  revokeScope: (scope: "face" | "voice" | "all") => Promise<void>;
  loadLicences: () => Promise<LicenceStatus[]>;
  acceptLicence: (id: LicenceId) => Promise<boolean>;
  revokeLicence: (id: LicenceId) => Promise<void>;
  openLicence: (id?: LicenceId) => void;
  closeLicence: () => void;
}

/** «Vence el 6/10/2027» etc. — end of the chosen local day as an ISO timestamp. */
export function endOfDayIso(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

export const usePersonsStore = create<PersonsState>()((set, get) => {
  /** Run an action on the selected Person; errors become a toast. */
  async function onPerson<T>(
    label: string,
    fn: (id: string) => Promise<T>,
  ): Promise<T | undefined> {
    const id = get().selectedId;
    if (!id) return undefined;
    set({ busy: label });
    try {
      const out = await fn(id);
      return out;
    } catch (err) {
      toast.error(label, { description: errorMessage(err) });
      return undefined;
    } finally {
      set({ busy: undefined });
    }
  }
  const adopt = (p: Person) => {
    set({ person: p });
    void get().refresh();
  };
  return {
    list: [],
    status: "idle",
    error: undefined,
    selectedId: undefined,
    person: undefined,
    busy: undefined,
    licences: [],
    licenceDialog: { open: false, licenceId: "faceswap" },
    refresh: async () => {
      if (get().status === "idle") set({ status: "loading" });
      try {
        set({ list: await personsApi.list(), status: "ready", error: undefined });
      } catch (err) {
        set({ status: "error", error: errorMessage(err) });
      }
    },
    select: async (id) => {
      set({ selectedId: id, person: undefined });
      if (!id) return;
      try {
        const p = await personsApi.get(id);
        if (get().selectedId === id) set({ person: p });
      } catch (err) {
        toast.error("No se pudo abrir la Persona", { description: errorMessage(err) });
      }
    },
    create: async (name, notes) => {
      try {
        const p = await personsApi.create({ name, ...(notes && { notes }) });
        addBreadcrumb("ui", "Persona creada", { personId: p.id });
        set({ selectedId: p.id, person: p });
        await get().refresh();
        return p;
      } catch (err) {
        toast.error("No se pudo crear la Persona", { description: errorMessage(err) });
        return undefined;
      }
    },
    update: async (patch) => {
      const p = await onPerson("Guardar Persona", (id) => personsApi.patch(id, patch));
      if (p) adopt(p);
    },
    remove: async (id) => {
      try {
        await personsApi.remove(id);
        addBreadcrumb("ui", "Persona borrada", { personId: id });
        if (get().selectedId === id) set({ selectedId: undefined, person: undefined });
        await get().refresh();
        toast.success("Persona borrada", {
          description: "Se borraron sus fotos y muestras; los consentimientos quedaron archivados.",
        });
        return true;
      } catch (err) {
        toast.error("No se pudo borrar la Persona", { description: errorMessage(err) });
        return false;
      }
    },
    uploadPhoto: async (file) => {
      const p = await onPerson("Subir foto", (id) => personsApi.uploadPhoto(id, file, file.name));
      if (!p) return false;
      adopt(p);
      const last = p.photos.at(-1);
      if (last?.faces === null)
        toast.warning("Foto guardada sin contar las caras", {
          description:
            "Falta el paquete «Cambio de cara» (o «Reencuadre») para detectar caras: se verifica al usarla.",
        });
      return true;
    },
    deletePhoto: async (photoId) => {
      const p = await onPerson("Borrar foto", (id) => personsApi.deletePhoto(id, photoId));
      if (p) adopt(p);
    },
    uploadVoice: async (file, name) => {
      const p = await onPerson("Subir muestra de voz", (id) =>
        personsApi.uploadVoice(id, file, name),
      );
      if (p) adopt(p);
      return !!p;
    },
    deleteVoice: async (sampleId) => {
      const p = await onPerson("Borrar muestra", (id) => personsApi.deleteVoice(id, sampleId));
      if (p) adopt(p);
    },
    addConsent: async (c) => {
      const done = await onPerson("Registrar consentimiento", (id) =>
        personsApi.addConsent(id, {
          scope: c.scope,
          method: c.method,
          signerName: c.signerName,
          textVersion: CONSENT_TEXT_VERSION,
          ...(c.expiresAt && { expiresAt: c.expiresAt }),
          evidence: c.evidence,
          evidenceName: c.evidenceName,
        }),
      );
      if (!done) return false;
      addBreadcrumb("ui", "Consentimiento registrado", { personId: done.personId, scope: c.scope });
      await get().select(done.personId);
      await get().refresh();
      toast.success("Consentimiento registrado");
      return true;
    },
    revokeConsent: async (consentId) => {
      const done = await onPerson("Revocar consentimiento", (id) =>
        personsApi.revokeConsent(id, consentId),
      );
      if (!done) return;
      await get().select(done.personId);
      await get().refresh();
      toast.success("Consentimiento revocado", {
        description: "Lo ya generado no se borra, pero no se puede usar para nada nuevo.",
      });
    },
    revokeScope: async (scope) => {
      const p = await onPerson("Revocar consentimiento", (id) => personsApi.revokeScope(id, scope));
      if (!p) return;
      addBreadcrumb("ui", "Consentimiento revocado", { personId: p.id, scope });
      adopt(p);
      toast.success(
        scope === "face" ? "Rostro revocado" : scope === "voice" ? "Voz revocada" : "Todo revocado",
        { description: "Lo ya generado no se borra, pero no se puede usar para nada nuevo." },
      );
    },
    loadLicences: async () => {
      try {
        const licences = await licencesApi.list();
        set({ licences });
        return licences;
      } catch {
        return get().licences;
      }
    },
    acceptLicence: async (id) => {
      const current =
        get().licences.find((l) => l.id === id) ??
        (await get().loadLicences()).find((l) => l.id === id);
      if (!current) return false;
      try {
        await licencesApi.accept(id, current.text_version);
        addBreadcrumb("ui", "Licencia aceptada", { licenceId: id });
        await get().loadLicences();
        toast.success("Licencia aceptada");
        return true;
      } catch (err) {
        toast.error("No se pudo aceptar la licencia", { description: errorMessage(err) });
        return false;
      }
    },
    revokeLicence: async (id) => {
      try {
        await licencesApi.revoke(id);
        await get().loadLicences();
        toast.success("Licencia revocada", {
          description: "El cambio de cara queda bloqueado hasta que la vuelvas a aceptar.",
        });
      } catch (err) {
        toast.error("No se pudo revocar la licencia", { description: errorMessage(err) });
      }
    },
    openLicence: (id = "faceswap") => {
      set({ licenceDialog: { open: true, licenceId: id } });
      void get().loadLicences();
    },
    closeLicence: () => set((s) => ({ licenceDialog: { ...s.licenceDialog, open: false } })),
  };
});
