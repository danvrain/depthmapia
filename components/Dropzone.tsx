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
        "group relative flex aspect-video cursor-pointer flex-col items-center justify-center gap-4 overflow-hidden rounded-3xl border px-6 text-center transition-colors duration-300",
        dragging
          ? "border-white/40 bg-white/[0.06]"
          : "border-[var(--color-edge)] bg-[var(--color-panel)] hover:border-white/25",
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
      <span className="flex size-14 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] transition-transform duration-300 group-hover:-translate-y-1">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <path d="M12 16V4m0 0L8 8m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 15v3a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-3" strokeLinecap="round" />
        </svg>
      </span>
      <div className="flex flex-col gap-1.5">
        <p className="text-lg font-medium tracking-tight">
          {dragging ? "Suelta el video" : "Arrastra tu video aquí"}
        </p>
        <p className="text-sm text-white/45">
          o haz clic para elegirlo · MP4, MOV o WebM · hasta{" "}
          {formatBytes(maxBytes)}
        </p>
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/30">
          Recortas {MAX_CLIP_SECONDS}s para procesar
        </p>
      </div>
    </div>
  );
}
