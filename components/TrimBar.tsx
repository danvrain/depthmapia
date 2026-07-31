"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MAX_CLIP_SECONDS, MIN_CLIP_SECONDS } from "@/lib/constants";
import { baseName, downloadBlob, timeTag } from "@/lib/download";
import type { Range } from "@/lib/types";

const THUMB_COUNT = 12;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * Grabs evenly spaced frames to show under the scrubber. Purely decorative —
 * if a browser refuses to seek or paint the video, the bar still works.
 */
async function buildThumbnails(
  url: string,
  duration: number,
  signal: { canceled: boolean },
): Promise<string[]> {
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.preload = "auto";
  (video as HTMLVideoElement & { playsInline: boolean }).playsInline = true;

  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("no se pudo leer el video"));
  });

  const height = 48;
  const width = Math.max(
    1,
    Math.round((video.videoWidth / video.videoHeight) * height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const thumbs: string[] = [];
  for (let i = 0; i < THUMB_COUNT; i++) {
    if (signal.canceled) break;
    const t = (duration * (i + 0.5)) / THUMB_COUNT;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = Math.min(t, Math.max(0, duration - 0.05));
    });
    ctx.drawImage(video, 0, 0, width, height);
    thumbs.push(canvas.toDataURL("image/jpeg", 0.5));
  }

  video.src = "";
  return thumbs;
}

type DragTarget = "start" | "end" | "band";

export function TrimBar({
  file,
  duration,
  value,
  onChange,
  disabled,
}: {
  file: File;
  duration: number;
  value: Range;
  onChange: (range: Range) => void;
  disabled?: boolean;
}) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [thumbs, setThumbs] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState(value.start);
  const [playing, setPlaying] = useState(false);

  const drag = useRef<{ target: DragTarget; grabOffset: number } | null>(null);
  // Kept in a ref so the pointer handlers always see the live range without
  // being torn down and rebuilt on every move.
  const range = useRef(value);
  range.current = value;

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // Park the video on the first frame of the selection, so the preview and any
  // captured still match what the run will actually start from.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onReady = () => {
      video.currentTime = range.current.start;
    };
    video.addEventListener("loadeddata", onReady);
    return () => video.removeEventListener("loadeddata", onReady);
  }, [url]);

  useEffect(() => {
    const signal = { canceled: false };
    setThumbs([]);
    buildThumbnails(url, duration, signal)
      .then((t) => {
        if (!signal.canceled) setThumbs(t);
      })
      .catch(() => {
        /* decorative only */
      });
    return () => {
      signal.canceled = true;
    };
  }, [url, duration]);

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
    },
    [duration],
  );

  const seek = useCallback((t: number) => {
    setPlayhead(t);
    const video = videoRef.current;
    if (video) video.currentTime = t;
  }, []);

  /* --- dragging --------------------------------------------------------- */

  useEffect(() => {
    if (disabled) return;

    const onMove = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      event.preventDefault();

      const t = timeAt(event.clientX);
      const { start, end } = range.current;

      if (state.target === "start") {
        // Anchored: the handle stops rather than dragging the other end along,
        // so the selection never jumps under the cursor.
        const next = clamp(
          t,
          Math.max(0, end - MAX_CLIP_SECONDS),
          end - MIN_CLIP_SECONDS,
        );
        onChange({ start: next, end });
        seek(next);
      } else if (state.target === "end") {
        const next = clamp(
          t,
          start + MIN_CLIP_SECONDS,
          Math.min(duration, start + MAX_CLIP_SECONDS),
        );
        onChange({ start, end: next });
        seek(next);
      } else {
        const width = end - start;
        const nextStart = clamp(t - state.grabOffset, 0, duration - width);
        onChange({ start: nextStart, end: nextStart + width });
        seek(nextStart);
      }
    };

    const onUp = () => {
      drag.current = null;
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [disabled, duration, onChange, seek, timeAt]);

  const startDrag = (target: DragTarget) => (event: React.PointerEvent) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      target,
      grabOffset: target === "band" ? timeAt(event.clientX) - value.start : 0,
    };
  };

  /* --- playback --------------------------------------------------------- */

  // Preview plays the selection on a loop, so the button reflects the trim.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;

    let raf = 0;
    const tick = () => {
      if (video.currentTime >= range.current.end) {
        video.currentTime = range.current.start;
      }
      setPlayhead(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  /**
   * Exports the frame under the playhead at the video's native resolution,
   * which is higher than the processed output and is what image-to-video
   * models want as a starting still.
   */
  const [capturing, setCapturing] = useState(false);
  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    setCapturing(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(
            blob,
            `${baseName(file.name)}-frame-${timeTag(video.currentTime)}.png`,
          );
        }
        setCapturing(false);
      }, "image/png");
    } catch {
      setCapturing(false);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.pause();
      setPlaying(false);
    } else {
      if (video.currentTime < value.start || video.currentTime >= value.end) {
        video.currentTime = value.start;
      }
      void video.play();
      setPlaying(true);
    }
  };

  const pct = (t: number) => `${(t / duration) * 100}%`;
  const selected = value.end - value.start;
  const atLimit = selected >= MAX_CLIP_SECONDS - 0.05;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-[var(--color-edge)] bg-[var(--color-panel)]/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-white/80">Recorta tu video</h2>
        <span
          className={`rounded-full px-2.5 py-1 text-xs ${
            atLimit
              ? "bg-amber-400/15 text-amber-200"
              : "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          }`}
        >
          {selected.toFixed(1)}s seleccionados
          {atLimit && ` · máximo ${MAX_CLIP_SECONDS}s`}
        </span>
      </div>

      <video
        ref={videoRef}
        src={url}
        muted
        playsInline
        onEnded={() => setPlaying(false)}
        className="max-h-64 w-full rounded-xl bg-black object-contain"
      />

      <div
        ref={trackRef}
        onPointerDown={(e) => !disabled && seek(timeAt(e.clientX))}
        className={`relative h-14 touch-none select-none overflow-hidden rounded-lg bg-black/50 ${
          disabled ? "opacity-50" : ""
        }`}
      >
        <div className="pointer-events-none absolute inset-0 flex">
          {thumbs.map((src, i) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              key={i}
              src={src}
              alt=""
              className="h-full flex-1 object-cover opacity-70"
            />
          ))}
        </div>

        {/* Everything outside the selection is dimmed. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/65"
          style={{ width: pct(value.start) }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/65"
          style={{ width: pct(duration - value.end) }}
        />

        <div
          onPointerDown={startDrag("band")}
          className="absolute inset-y-0 cursor-grab border-y-2 border-[var(--color-accent)] active:cursor-grabbing"
          style={{ left: pct(value.start), width: pct(selected) }}
        />

        {/*
          Both handles sit just inside the selection. Hanging them outside puts
          the left one beyond the track at start = 0, where the track's own
          overflow clipping makes it impossible to grab.
        */}
        {(["start", "end"] as const).map((side) => (
          <div
            key={side}
            onPointerDown={startDrag(side)}
            className="absolute inset-y-0 flex w-3.5 cursor-ew-resize items-center justify-center rounded-sm bg-[var(--color-accent)]"
            style={{
              left: pct(side === "start" ? value.start : value.end),
              transform:
                side === "start" ? "translateX(0)" : "translateX(-100%)",
            }}
          >
            <span className="h-5 w-0.5 rounded bg-black/40" />
          </div>
        ))}

        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
          style={{ left: pct(playhead) }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-white/50">
        <button
          type="button"
          onClick={togglePlay}
          disabled={disabled}
          className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-white/80 transition hover:border-white/30 disabled:opacity-40"
        >
          {playing ? "Pausar" : "Reproducir selección"}
        </button>
        <button
          type="button"
          onClick={captureFrame}
          disabled={disabled || capturing}
          title="Guarda el frame donde está la línea blanca, en PNG y a resolución original"
          className="rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-white/80 transition hover:border-white/30 disabled:opacity-40"
        >
          {capturing ? "Guardando…" : "Capturar frame (PNG)"}
        </button>
        <span>Inicio {formatTime(value.start)}</span>
        <span>Fin {formatTime(value.end)}</span>
        <span className="ml-auto">Duración total {formatTime(duration)}</span>
      </div>
    </section>
  );
}
