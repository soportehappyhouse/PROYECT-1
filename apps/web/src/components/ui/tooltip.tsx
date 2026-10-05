"use client";

import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

const DELAY_MS = 350;

type TriggerProps = {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
};

/**
 * Small hover/focus tooltip (feedback 9): action + shortcut, e.g. "Cortar (S)". Rendered in a
 * portal with fixed positioning so panel overflow never clips it; no dependency (no Radix).
 */
export function Tooltip({
  content,
  children,
  side = "bottom",
}: {
  content: string | undefined;
  children: ReactElement<TriggerProps>;
  side?: "top" | "bottom";
}) {
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number; top: boolean } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!content) return children;

  const show = (el: HTMLElement, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const top = side === "top" || r.bottom + 32 > window.innerHeight;
      setPos({ x: r.left + r.width / 2, y: top ? r.top - 6 : r.bottom + 6, top });
    }, delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPos(undefined);
  };
  const p = children.props;
  const trigger = cloneElement(children, {
    "aria-describedby": pos ? id : p["aria-describedby"],
    onPointerEnter: (e) => {
      p.onPointerEnter?.(e);
      show(e.currentTarget, DELAY_MS);
    },
    onPointerLeave: (e) => {
      p.onPointerLeave?.(e);
      hide();
    },
    onPointerDown: (e) => {
      p.onPointerDown?.(e);
      hide();
    },
    onFocus: (e) => {
      p.onFocus?.(e);
      if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget, 0);
    },
    onBlur: (e) => {
      p.onBlur?.(e);
      hide();
    },
  });
  return (
    <>
      {trigger}
      {pos && typeof document !== "undefined"
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className="pointer-events-none fixed z-[1000] max-w-64 rounded bg-neutral-900 px-2 py-1 text-[11px] whitespace-nowrap text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
              style={{
                left: Math.max(8, Math.min(pos.x, window.innerWidth - 8)),
                top: pos.y,
                transform: `translate(-50%, ${pos.top ? "-100%" : "0"})`,
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
