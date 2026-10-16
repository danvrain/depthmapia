"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

import { Corners, Tag } from "@/components/hud";

/**
 * Wipe between the original frame and its depth map. The depth sits
 * underneath; the original is clipped to the left of the divider.
 */
export function CompareSlider({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(50);
  const dragging = useRef(false);

  // Sweep in from the right once, so it is obvious the divider moves.
  useEffect(() => {
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const state = { v: 92 };
      gsap.to(state, {
        v: 50,
        duration: 1.3,
        ease: "power3.inOut",
        delay: 0.2,
        onUpdate: () => setSplit(state.v),
      });
    });
    return () => mm.revert();
  }, [before, after]);

  const moveTo = (clientX: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSplit(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
  };

  return (
    <div
      ref={boxRef}
      className="relative aspect-video w-full cursor-ew-resize touch-none select-none overflow-hidden bg-black"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && moveTo(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      // Images are draggable by default; the browser's own drag would hijack
      // the gesture and cancel it after the first move.
      onDragStart={(e) => e.preventDefault()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt="Mapa de profundidad" draggable={false} className="absolute inset-0 size-full object-contain" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={before}
        alt="Frame original"
        draggable={false}
        className="absolute inset-0 size-full object-contain"
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
      />

      <div
        className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 bg-[var(--color-brand)] shadow-[0_0_18px_rgb(68_228_220/0.7)]"
        style={{ left: `${split}%` }}
      >
        <span className="absolute left-1/2 top-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--color-brand)] text-black">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
            <path d="m9 6-6 6 6 6M15 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>

      <Tag className="absolute left-6 top-6">El original</Tag>
      <Tag tone="brand" className="absolute right-6 top-6">
        Profundidad
      </Tag>
      <Corners inset={10} size={12} className="border-white/40" />
    </div>
  );
}
