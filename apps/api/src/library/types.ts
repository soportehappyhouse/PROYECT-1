import type {
  LibraryItem,
  LibraryItemDetails,
  LibraryProvider,
  LibrarySearchQuery,
  Paginated,
} from "@studio/shared";

/** A downloadable remote sound, with the license metadata to store in the library. */
export interface RemoteSound {
  item: LibraryItemDetails;
  /** File extension of the downloaded data (e.g. "mp3"). */
  ext: string;
  download(signal?: AbortSignal): Promise<Buffer>;
}

/** Search/import source for the sound library (local index, Freesound, ...). */
export interface LibraryProviderAdapter {
  id: LibraryProvider;
  enabled(): boolean;
  /** Spanish status label for the dashboard. */
  status(): string;
  search(query: LibrarySearchQuery, signal?: AbortSignal): Promise<Paginated<LibraryItem>>;
  /** Remote providers only. */
  fetch?(remoteId: string, signal?: AbortSignal): Promise<RemoteSound>;
}
