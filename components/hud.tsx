"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

/** Camera-viewfinder brackets in the four corners of the parent. */
export function Corners({
  size = 14,
  inset = 0,
  className = "border-white/35",
}: {
  size?: number;
  inset?: number;
  className?: string;
}) {
  const base = `pointer-events-none absolute ${className}`;
  const s = { width: size, height: size };
  return (
    <>
      <span className={`${base} border-l border-t`} style={{ ...s, top: inset, left: inset }} />
      <span className={`${base} border-r border-t`} style={{ ...s, top: inset, right: inset }} />
      <span className={`${base} border-b border-l`} style={{ ...s, bottom: inset, left: inset }} />
      <span className={`${base} border-b border-r`} style={{ ...s, bottom: inset, right: inset }} />
    </>
  );
}

/** A solid caption chip, like the reel's "VIDEO DE STOCK" tag. */
export function Tag({
  children,
  tone = "light",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "light" | "brand" | "dark";
  className?: string;
}) {
  const tones = {
    light: "bg-white text-black",
    brand: "bg-[var(--color-brand)] text-black",
    dark: "bg-black/70 text-white/80 ring-1 ring-white/15 backdrop-blur",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** "02 EL ORIGINAL" — a numbered section marker. */
export function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <p className="hud flex items-center gap-3 text-white/75">
      <span className="text-[var(--color-brand)]">{n}</span>
      <span>{children}</span>
    </p>
  );
}

/**
 * Story-style segmented progress. `value` runs 0..1 across all segments, so
 * the filled length is continuous rather than stepping a segment at a time.
 */
export function SegmentBar({
  segments,
  value,
  className = "",
}: {
  segments: number;
  value: number;
  className?: string;
}) {
  const filled = Math.max(0, Math.min(1, value)) * segments;
  return (
    <div className={`flex gap-1.5 ${className}`} aria-hidden>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className="relative h-[3px] flex-1 overflow-hidden bg-white/15">
          <span
            className="absolute inset-y-0 left-0 bg-[var(--color-brand)] transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(0, Math.min(1, filled - i)) * 100}%` }}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * The slanted turquoise block from the reel ("ES ESTE."): a skewed face with
 * a darker extruded edge underneath, so it reads as a solid slab.
 */
export function Slab({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`relative inline-block -rotate-[3deg] ${className}`}>
      <span
        aria-hidden
        className="absolute inset-0 translate-x-[0.09em] translate-y-[0.11em] -skew-x-6 bg-[var(--color-brand-deep)]"
      />
      <span className="relative block -skew-x-6 bg-[var(--color-brand)] px-[0.22em] pb-[0.06em] pt-[0.12em] text-black shadow-[0_0_60px_rgb(68_228_220/0.35)]">
        <span className="block skew-x-6">{children}</span>
      </span>
    </span>
  );
}

/** An endlessly scrolling band of text. */
export function Marquee({
  items,
  className = "",
  speed = 40,
}: {
  items: string[];
  className?: string;
  /** Pixels per second. */
  speed?: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      // The track holds two copies; shifting by exactly one copy loops seamlessly.
      const distance = track.scrollWidth / 2;
      gsap.fromTo(
        track,
        { x: 0 },
        { x: -distance, duration: distance / speed, ease: "none", repeat: -1 },
      );
    });
    return () => mm.revert();
  }, [speed]);

  const run = (copy: number) =>
    items.map((item, i) => (
      <span key={`${copy}-${i}`} className="flex shrink-0 items-center gap-6 pr-6">
        <span>{item}</span>
        <span aria-hidden className="text-[0.55em]">
          ✦
        </span>
      </span>
    ));

  return (
    <div className={`overflow-hidden ${className}`}>
      <div ref={trackRef} className="flex w-max whitespace-nowrap will-change-transform">
        {run(0)}
        {run(1)}
      </div>
    </div>
  );
}

/** A running SMPTE-style timecode, purely decorative. */
export function Timecode({ fps = 25 }: { fps?: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const pad = (n: number) => String(n).padStart(2, "0");
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      const frames = Math.floor(t * fps);
      el.textContent = `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(
        Math.floor(t) % 60,
      )}:${pad(frames % fps)}`;
    };
    draw();
    if (reduced) return;
    const id = window.setInterval(draw, 1000 / fps);
    return () => window.clearInterval(id);
  }, [fps]);

  return <span ref={ref} className="tabular-nums" />;
}

/**
 * A segmented bar that fills on a loop, like a story in progress. Owns its
 * own state so the animation never re-renders the page around it.
 */
export function StoryBar({
  segments = 6,
  seconds = 18,
  className = "",
}: {
  segments?: number;
  /** Time to fill every segment once. */
  seconds?: number;
  className?: string;
}) {
  const [value, setValue] = useState(0.18);

  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const state = { v: 0 };
      gsap.to(state, {
        v: 1,
        duration: seconds,
        ease: "none",
        repeat: -1,
        onUpdate: () => setValue(state.v),
      });
    });
    return () => mm.revert();
  }, [seconds]);

  return <SegmentBar segments={segments} value={value} className={className} />;
}
