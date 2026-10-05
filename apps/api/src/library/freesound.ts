import type { LibraryItem, LibrarySearchQuery, Paginated } from "@studio/shared";
import { HttpError } from "../lib/errors.js";
import type { LibraryProviderAdapter, RemoteSound } from "./types.js";

const API = "https://freesound.org/apiv2";
const FIELDS = "id,name,tags,license,previews,duration,username,url";

interface FreesoundSound {
  id: number;
  name: string;
  tags?: string[];
  license?: string;
  previews?: Record<string, string>;
  duration?: number;
  username?: string;
  url?: string;
}

/** Freesound license URL / label -> SPDX-ish id. */
export function freesoundLicense(raw: string | undefined): string {
  const v = (raw ?? "").toLowerCase();
  if (v.includes("publicdomain/zero") || v.includes("creative commons 0") || v === "cc0")
    return "CC0-1.0";
  const version = /\/(\d\.\d)\/?$/.exec(v)?.[1] ?? (v.includes("3.0") ? "3.0" : "4.0");
  if (v.includes("by-nc") || v.includes("noncommercial")) return `CC-BY-NC-${version}`;
  if (v.includes("sampling+")) return "CC-Sampling-Plus-1.0";
  if (v.includes("/by/") || v.includes("attribution")) return `CC-BY-${version}`;
  return raw ? raw : "unknown";
}

function toItem(s: FreesoundSound): LibraryItem & { author?: string; sourceUrl?: string } {
  const license = freesoundLicense(s.license);
  const preview = s.previews?.["preview-hq-mp3"] ?? s.previews?.["preview-lq-mp3"];
  const author = s.username ?? "desconocido";
  return {
    id: `freesound:${s.id}`,
    kind: "sfx",
    name: s.name,
    ...(preview && { previewUrl: preview }),
    tags: (s.tags ?? []).slice(0, 20),
    ...(s.duration !== undefined && { durationSec: s.duration }),
    provider: "freesound",
    license,
    attribution: `"${s.name}" por ${author} (${s.url ?? `freesound.org/s/${s.id}`}) - ${license}`,
    author,
    ...(s.url && { sourceUrl: s.url }),
  };
}

/** Freesound APIv2 with a token (API key from .env): search + preview download only. */
export class FreesoundProvider implements LibraryProviderAdapter {
  readonly id = "freesound" as const;

  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  enabled(): boolean {
    return Boolean(this.token);
  }

  status(): string {
    return this.enabled() ? "configurado (solo previews)" : "no configurado";
  }

  async #get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    if (!this.token)
      throw new HttpError(409, "PROVIDER_NOT_CONFIGURED", "Freesound: falta FREESOUND_API_KEY");
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Token ${this.token}` },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(502, "PROVIDER_ERROR", `Freesound respondió ${res.status}`);
    return (await res.json()) as T;
  }

  async search(query: LibrarySearchQuery, signal?: AbortSignal): Promise<Paginated<LibraryItem>> {
    const data = await this.#get<{ count: number; results: FreesoundSound[] }>(
      "/search/text/",
      {
        query: query.q,
        fields: FIELDS,
        page: String(query.page),
        page_size: String(Math.min(query.pageSize, 150)),
        sort: query.q ? "score" : "downloads_desc",
      },
      signal,
    );
    return {
      items: data.results.map((s) => {
        const { author: _a, sourceUrl: _s, ...item } = toItem(s);
        return item;
      }),
      total: data.count,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async fetch(remoteId: string, signal?: AbortSignal): Promise<RemoteSound> {
    const id = remoteId.replace(/^freesound:/, "");
    if (!/^\d+$/.test(id))
      throw new HttpError(400, "BAD_REQUEST", `Id de Freesound inválido: ${remoteId}`);
    const sound = await this.#get<FreesoundSound>(`/sounds/${id}/`, { fields: FIELDS }, signal);
    const { previewUrl, ...item } = toItem(sound);
    if (!previewUrl) throw new HttpError(502, "PROVIDER_ERROR", "Freesound no devolvió preview");
    return {
      item: { ...item, source: "freesound" },
      ext: "mp3",
      download: async (sig) => {
        const res = await this.fetchImpl(previewUrl, {
          headers: { Authorization: `Token ${this.token}` },
          signal: sig ?? AbortSignal.timeout(60_000),
        });
        if (!res.ok)
          throw new HttpError(502, "PROVIDER_ERROR", `Descarga de preview falló (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }
}
