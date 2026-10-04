"use client";

import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

/** Resolved theme ("light" | "dark") following the "system" option live. */
export function useResolvedTheme(): "light" | "dark" {
  const theme = useSettingsStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

/** Applies theme class, accent color and density to <html>. */
export function useApplyTheme(): "light" | "dark" {
  const resolved = useResolvedTheme();
  const accent = useSettingsStore((s) => s.accent);
  const density = useSettingsStore((s) => s.density);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    root.style.setProperty("--user-accent", accent);
    root.dataset.density = density;
  }, [resolved, accent, density]);
  return resolved;
}
