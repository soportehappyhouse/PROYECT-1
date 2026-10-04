"use client";

import dynamic from "next/dynamic";

/** The dashboard depends on window/localStorage/dockview: render it on the client only. */
const Dashboard = dynamic(() => import("./Dashboard").then((m) => m.Dashboard), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">
      Cargando Studio…
    </div>
  ),
});

export function ClientApp() {
  return <Dashboard />;
}
