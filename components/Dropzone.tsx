"use client";

import { useCallback, useRef, useState } from "react";
import { Corners } from "@/components/hud";
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
        "group relative flex aspect-video cursor-pointer flex-col items-center justify-center gap-5 overflow-hidden rounded-lg border px-6 text-center transition-colors duration-300",
        dragging
          ? "border-[var(--color-brand)] bg-[var(--color-brand)]/[0.06]"
          : "border-[var(--color-edge)] bg-[var(--color-panel)] hover:border-[var(--color-brand)]/50",
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
      <span aria-hidden className="dot-grid absolute inset-0 opacity-40" />
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-1/2 bg-[radial-gradient(60%_80%_at_50%_0%,rgb(68_228_220/0.14),transparent)]"
      />
      <Corners inset={14} size={16} className="border-white/40 transition-colors group-hover:border-[var(--color-brand)]" />

      <span className="relative flex size-14 items-center justify-center rounded-full bg-[var(--color-brand)] text-black shadow-[0_0_40px_rgb(68_228_220/0.35)] transition-transform duration-300 group-hover:-translate-y-1">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path d="M12 16V4m0 0L8 8m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 15v3a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-3" strokeLinecap="round" />
        </svg>
      </span>
      <div className="relative flex flex-col items-center gap-2">
        <p className="display text-[clamp(1.8rem,4vw,2.8rem)]">
          {dragging ? "Suéltalo" : "Arrastra tu video"}
        </p>
        <p className="text-sm text-white/50">
          o haz clic para elegirlo · MP4, MOV o WebM · hasta{" "}
          {formatBytes(maxBytes)}
        </p>
        <p className="hud mt-1 text-white/30">
          Recortas {MAX_CLIP_SECONDS}s para procesar
        </p>
      </div>
    </div>
  );
}
