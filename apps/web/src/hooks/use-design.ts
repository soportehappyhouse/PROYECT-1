"use client";

import type { BrandKit, BrandKitUpdate, MotionStillRequest } from "@studio/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { showPanel } from "@/components/dashboard/dock-controller";
import { errorMessage } from "@/lib/api";
import { designApi } from "@/lib/api-design";
import { useDesignTokensStore } from "@/stores/design-tokens-store";
import { useProjectStore } from "@/stores/project-store";

/** Debounce of the still preview (contract: 400 ms). */
export const STILL_DEBOUNCE_MS = 400;

export interface BrandKitState {
  kit: BrandKit | undefined;
  error: string | undefined;
  saving: boolean;
  reload: () => void;
  save: (patch: BrandKitUpdate) => Promise<BrandKit | undefined>;
  setLocal: (kit: BrandKit) => void;
}

/** The single brand kit (GET/PUT /api/brand-kit). */
export function useBrandKit(): BrandKitState {
  const [kit, setKit] = useState<BrandKit>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    designApi
      .brandKit()
      .then((k) => {
        if (!alive) return;
        setKit(k);
        setError(undefined);
        useDesignTokensStore.getState().setTokens(k.tokens);
      })
      .catch((err: unknown) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [nonce]);
  const save = useCallback(async (patch: BrandKitUpdate) => {
    setSaving(true);
    try {
      const next = await designApi.saveBrandKit(patch);
      setKit(next);
      useDesignTokensStore.getState().setTokens(next.tokens);
      setError(undefined);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setSaving(false);
    }
  }, []);
  return { kit, error, saving, reload: () => setNonce((n) => n + 1), save, setLocal: setKit };
}

export type StillRequest = Partial<MotionStillRequest> &
  Pick<MotionStillRequest, "template" | "width" | "height">;

export interface StillState {
  url: string | undefined;
  loading: boolean;
  error: string | undefined;
}

/**
 * PNG preview of a template frame (POST /api/motion/still) after STILL_DEBOUNCE_MS without
 * changes; the api caches by hash, so going back to a previous value is instant. `null` = off.
 */
export function useStillPreview(req: StillRequest | null, delay = STILL_DEBOUNCE_MS): StillState {
  const [state, setState] = useState<StillState>({
    url: undefined,
    loading: false,
    error: undefined,
  });
  const key = req ? JSON.stringify(req) : "";
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      setState((s) => ({ ...s, loading: true }));
      designApi
        .still(JSON.parse(key) as StillRequest, ctrl.signal)
        .then((url) => {
          if (last.current) URL.revokeObjectURL(last.current);
          last.current = url;
          setState({ url, loading: false, error: undefined });
        })
        .catch((err: unknown) => {
          if ((err as Error).name === "AbortError") return;
          setState((s) => ({ ...s, loading: false, error: errorMessage(err) }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key, delay]);
  useEffect(
    () => () => {
      if (last.current) URL.revokeObjectURL(last.current);
    },
    [],
  );
  return state;
}

/** Select a clip and bring Propiedades to the front (motion form inside). */
export function openClipInInspector(clipId: string): void {
  useProjectStore.getState().selectClip(clipId);
  showPanel("inspector");
}

/**
 * Sprint 6 M2 (H13): double-click on any element with `data-clip-id` (timeline clips) calls
 * `open(clipId)` — the dashboard opens it in Propiedades.
 */
export function useClipDoubleClick(open: (clipId: string) => void): void {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const onDbl = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-clip-id]");
      const id = el?.getAttribute("data-clip-id");
      if (id) ref.current(id);
    };
    document.addEventListener("dblclick", onDbl);
    return () => document.removeEventListener("dblclick", onDbl);
  }, []);
}
