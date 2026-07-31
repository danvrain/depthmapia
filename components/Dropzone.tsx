"use client";

import { useCallback, useRef, useState } from "react";
import { ACCEPTED_TYPES, MAX_CLIP_SECONDS, formatBytes } from "@/lib/constants";

export function Dropzone({
  onFile,
  disabled,
  maxBytes,
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  maxBytes: number;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) handle(e.dataTransfer.files);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      className={[
        "relative flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition",
        dragging
          ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
          : "border-[var(--color-edge)] bg-[var(--color-panel)]/60 hover:border-[var(--color-accent)]/60",
        disabled ? "pointer-events-none opacity-50" : "",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        className="hidden"
        onChange={(e) => handle(e.target.files)}
      />
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-[var(--color-accent)]"
        aria-hidden
      >
        <path d="M12 16V4m0 0L8 8m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 15v3a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-3" strokeLinecap="round" />
      </svg>
      <p className="text-lg font-medium">Arrastra tu video aquí</p>
      <p className="text-sm text-white/50">
        o haz clic para elegirlo · MP4, MOV o WebM · hasta {formatBytes(maxBytes)}
        {" "}· recortas {MAX_CLIP_SECONDS}s para procesar
      </p>
    </div>
  );
}
