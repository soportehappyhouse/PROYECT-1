import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PanelProps {
  /** Accessible name; the visible title is the dockview tab. */
  title: string;
  /** Optional toolbar rendered above the scrollable body. */
  toolbar?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Disable the default padding/scroll (timeline, preview manage their own). */
  bare?: boolean;
}

/** Common chrome for every dashboard panel (lives inside a dockview tab). */
export function Panel({ title, toolbar, children, className, bare }: PanelProps) {
  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col bg-background text-sm">
      {toolbar ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
          {toolbar}
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1",
          bare ? "flex flex-col" : "overflow-auto p-[var(--panel-pad)]",
          className,
        )}
      >
        {children}
      </div>
    </section>
  );
}
