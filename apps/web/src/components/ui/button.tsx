"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { displayKeys, type ShortcutActionId } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { Tooltip } from "./tooltip";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3",
        xs: "h-6 gap-1 rounded px-2 text-xs [&_svg]:size-3.5",
        lg: "h-10 px-6",
        icon: "size-9",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /**
   * Hover/focus tooltip (feedback 9). Icon buttons default to their aria-label / title, so every
   * toolbar icon explains itself; `false` disables it.
   */
  tooltip?: string | false;
  /** Shortcut shown in the tooltip, read live from the shortcut settings: "Cortar (S)". */
  shortcut?: ShortcutActionId;
}

/** "Label (Keys)" for a tooltip. */
export function tooltipText(
  label: string | undefined,
  keys: string | undefined,
): string | undefined {
  if (!label) return undefined;
  return keys ? `${label} (${displayKeys(keys)})` : label;
}

export function Button({ className, variant, size, tooltip, shortcut, ...props }: ButtonProps) {
  const keys = useSettingsStore((s) => (shortcut ? s.shortcuts[shortcut] : undefined));
  const isIcon = size === "icon" || size === "icon-sm";
  const label =
    tooltip === false
      ? undefined
      : (tooltip ?? (isIcon || shortcut ? (props.title ?? props["aria-label"]) : undefined));
  const text = tooltipText(label, keys);
  const button = (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
      // The custom tooltip replaces the native one (no double bubble).
      title={text ? undefined : props.title}
    />
  );
  return text ? <Tooltip content={text}>{button}</Tooltip> : button;
}

export { buttonVariants };
