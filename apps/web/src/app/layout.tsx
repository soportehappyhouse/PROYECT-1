import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Studio",
  description: "Editor de video, motion graphics y voz — local",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // TODO(module-a): apply persisted theme class ("dark") before paint to avoid flashes.
  return (
    <html lang="es" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
