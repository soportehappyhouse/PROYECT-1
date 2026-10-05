import type { Metadata } from "next";
import type { ReactNode } from "react";
import "dockview-react/dist/styles/dockview.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Studio",
  description: "Editor de video, motion graphics y voz — local",
};

/**
 * Applies the persisted theme/accent/density before first paint (no flash).
 * Mirrors `useApplyTheme`; reads the same localStorage key as the settings store.
 */
const THEME_BOOTSTRAP = `(()=>{try{var s=JSON.parse(localStorage.getItem("studio.settings.v1")||"{}");var t=s.theme||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";if(s.accent)r.style.setProperty("--user-accent",s.accent);r.dataset.density=s.density||"comfortable";}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
