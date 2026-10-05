import { Construction, Loader2, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone = "default",
  ...props
}: ComponentProps<"span"> & { tone?: "default" | "success" | "warning" | "danger" | "muted" }) {
  const tones = {
    default: "bg-primary/15 text-primary",
    success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    danger: "bg-destructive/15 text-destructive",
    muted: "bg-muted text-muted-foreground",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded bg-muted", className)}
    >
      <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin", className)} aria-hidden />;
}

/** Shown when an endpoint answers 501: the backend module is still being built. */
export function NotImplementedNotice({ what }: { what?: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground"
    >
      <Construction className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium text-foreground">Módulo en desarrollo</p>
        {what ? <p>{what} todavía no está disponible en la API local.</p> : null}
      </div>
    </div>
  );
}

export function ErrorNotice({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="flex-1">
        <p>{message}</p>
        {action}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

export function Section({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: readonly { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex gap-1 rounded-md bg-muted p-0.5", className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            "flex-1 rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
            value === it.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
