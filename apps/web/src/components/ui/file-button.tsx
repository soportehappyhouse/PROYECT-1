"use client";

import { Upload } from "lucide-react";
import { useRef } from "react";
import { Button, type ButtonProps } from "./button";

/**
 * Sprint 6 M2: file picker as a Studio button (the native «Choose File / No file chosen» control
 * is English and looks different on each browser). The hidden input keeps the accessible label.
 */
export function FileButton({
  label,
  accept,
  onFile,
  size = "sm",
  variant = "outline",
  ...rest
}: {
  label: string;
  accept: string;
  onFile: (file: File) => void;
} & Omit<ButtonProps, "onClick" | "children">) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={() => input.current?.click()}
        {...rest}
      >
        <Upload /> {label}
      </Button>
      <input
        ref={input}
        type="file"
        accept={accept}
        aria-label={label}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}
