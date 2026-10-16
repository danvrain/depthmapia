"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import gsap from "gsap";

import { CompareSlider } from "@/components/CompareSlider";
import { CompatBanner } from "@/components/CompatBanner";
import { Dropzone } from "@/components/Dropzone";
import {
  Corners,
  Marquee,
  SectionLabel,
  SegmentBar,
  Slab,
  StoryBar,
  Tag,
  Timecode,
} from "@/components/hud";
import { Segmented } from "@/components/Segmented";
import { TrimBar } from "@/components/TrimBar";
import { detectCapabilities, type Capabilities } from "@/lib/capabilities";
import { fetchVideoCount, recordVideo } from "@/lib/counter";
import { baseName, downloadBlob } from "@/lib/download";
import { grabFrame } from "@/lib/frames";
import {
  DEFAULT_MODEL,
  DEFAULT_MOTION_BLUR,
  DEFAULT_QUALITY,
  DEFAULT_SMOOTHING,
  MAX_CLIP_SECONDS,
  MAX_FILE_BYTES,
  MAX_SOURCE_SECONDS,
  MODELS,
  MOTION_BLUR_LEVELS,
  QUALITY_LEVELS,
  SMOOTHING_LEVELS,
  formatBytes,
  type ModelKey,
  type MotionBlurKey,
  type QualityKey,
  type SmoothingKey,
  ACCEPTED_TYPES,
} from "@/lib/constants";
import type {
  ColorMode,
  OutputFormat,
  Range,
  Stage,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/types";

// three.js is large and only ever runs in the browser, so both scenes load on
// demand instead of weighing down the first paint.
const DepthHero = dynamic(
  () => import("@/components/DepthHero").then((m) => m.DepthHero),
  { ssr: false },
);
const Depth3DViewer = dynamic(
  () => import("@/components/Depth3DViewer").then((m) => m.Depth3DViewer),
  { ssr: false },
);

type Result = {
  url: string;
  blob: Blob;
  extension: string;
  bytes: number;
  codec?: string;
  codecFailures?: string[];
  /** Settings the run used, so the 3D view reads the file correctly even if
   *  the controls have changed since. */
  colorMode: ColorMode;
  invert: boolean;
};

const CODEC_LABELS: Record<string, string> = {
  avc: "H.264",
  hevc: "HEVC / H.265",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
};

/** Reads duration client-side so oversized clips are rejected before any download. */
function readDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No se pudo leer el video. ¿El formato es compatible?"));
    };
    video.src = url;
  });
}

export default function Home() {
  const workerRef = useRef<Worker | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const studioRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const runSettings = useRef<{ colorMode: ColorMode; invert: boolean }>({
    colorMode: "grayscale",
    invert: false,
  });
  // Where the last run started, so the comparison grabs the matching frame.
  const runStart = useRef(0);

  const [caps, setCaps] = useState<Capabilities | null>(null);
  // Null until the server answers, and stays null where there is no server.
  const [videoCount, setVideoCount] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [range, setRange] = useState<Range>({ start: 0, end: MAX_CLIP_SECONDS });
  const [stage, setStage] = useState<Stage>("idle");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [download, setDownload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [still, setStill] = useState<{ blob: Blob; url: string } | null>(null);
  const [original, setOriginal] = useState<string | null>(null);

  const [model, setModel] = useState<ModelKey>(DEFAULT_MODEL);
  const [colorMode, setColorMode] = useState<ColorMode>("grayscale");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("video");
  const [quality, setQuality] = useState<QualityKey>(DEFAULT_QUALITY);
  const [smoothing, setSmoothing] = useState<SmoothingKey>(DEFAULT_SMOOTHING);
  const [motionBlur, setMotionBlur] =
    useState<MotionBlurKey>(DEFAULT_MOTION_BLUR);
  const [stabilize, setStabilize] = useState(true);
  const [invert, setInvert] = useState(false);

  const busy = stage === "loadingModel" || stage === "processing" || stage === "encoding";
  const blocked = caps !== null && !caps.supported;

  useEffect(() => {
    detectCapabilities().then(setCaps);
    fetchVideoCount().then(setVideoCount);
  }, []);

  useEffect(() => {
    const worker = new Worker(
      new URL("../workers/depth.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;

      if (msg.type === "status") {
        setStage(msg.stage);
        setStatus(msg.message);
      } else if (msg.type === "modelProgress") {
        setDownload(msg.total ? msg.loaded / msg.total : 0);
      } else if (msg.type === "frame") {
        setProgress(msg.progress);
        // The grid makes the frame total exact.

        setStatus(`Frame ${msg.frameIndex} de ${msg.totalFrames}`);
        if (msg.preview) {
          const canvas = previewRef.current;
          if (canvas) {
            canvas.width = msg.preview.width;
            canvas.height = msg.preview.height;
            canvas.getContext("2d")?.drawImage(msg.preview, 0, 0);
          }
          msg.preview.close();
        }
      } else if (msg.type === "still") {
        setStill((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { blob: msg.blob, url: URL.createObjectURL(msg.blob) };
        });
      } else if (msg.type === "done") {
        setResult({
          url: URL.createObjectURL(msg.blob),
          blob: msg.blob,
          extension: msg.extension,
          bytes: msg.blob.size,
          codec: msg.codec,
          codecFailures: msg.codecFailures,
          ...runSettings.current,
        });
        recordVideo().then((total) => {
          if (total !== null) setVideoCount(total);
        });
        setProgress(1);
        setStage("done");
        setStatus("Listo");
      } else if (msg.type === "error") {
        setError(msg.message);
        setStage("error");
      }
    };

    return () => worker.terminate();
  }, []);

  const reset = useCallback(() => {
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setStill((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setOriginal((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError(null);
    setProgress(0);
    setDownload(0);
    setStage("idle");
    setStatus("");
  }, []);

  const handleFile = useCallback(
    async (picked: File) => {
      reset();
      setFile(null);
      setDuration(null);

      if (picked.size > MAX_FILE_BYTES) {
        setError(
          `El archivo pesa ${formatBytes(picked.size)} y el máximo es ${formatBytes(MAX_FILE_BYTES)}.`,
        );
        return;
      }

      try {
        const seconds = await readDuration(picked);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          setError("No se pudo determinar la duración del video.");
          return;
        }
        if (seconds > MAX_SOURCE_SECONDS) {
          setError(
            `El video dura ${(seconds / 60).toFixed(1)} min y el máximo es ${MAX_SOURCE_SECONDS / 60} min.`,
          );
          return;
        }
        setDuration(seconds);
        // Start with the longest allowed clip from the beginning.
        setRange({ start: 0, end: Math.min(seconds, MAX_CLIP_SECONDS) });
        setFile(picked);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reset],
  );

  const start = useCallback(() => {
    if (!file || !workerRef.current) return;
    reset();
    runSettings.current = { colorMode, invert };
    runStart.current = range.start;
    setStage("loadingModel");
    setStatus("Preparando el modelo…");
    const req: WorkerRequest = {
      type: "process",
      file,
      model,
      colorMode,
      range,
      outputFormat,
      quality,
      smoothing,
      motionBlur,
      stabilize,
      invert,
    };
    workerRef.current.postMessage(req);
  }, [
    file,
    model,
    colorMode,
    range,
    outputFormat,
    quality,
    smoothing,
    motionBlur,
    stabilize,
    invert,
    reset,
  ]);

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: "cancel" } satisfies WorkerRequest);
    setStage("idle");
    setStatus("Cancelado");
  }, []);

  /* --- motion ----------------------------------------------------------- */

  // Headline lines rise out of their masks, the strike draws across, then
  // the slab punches in — the reel's sequence, in order.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap
        .timeline({ defaults: { ease: "power4.out" } })
        .from(hero.querySelectorAll("[data-hero-line]"), {
          yPercent: 115,
          duration: 1.1,
          stagger: 0.1,
        })
        .from(
          hero.querySelectorAll("[data-strike]"),
          { scaleX: 0, transformOrigin: "left center", duration: 0.55, ease: "power2.inOut" },
          "-=0.35",
        )
        .from(
          hero.querySelectorAll("[data-slab]"),
          { scale: 0.4, rotate: -14, opacity: 0, duration: 0.7, ease: "back.out(1.8)" },
          "-=0.1",
        )
        .from(
          hero.querySelectorAll("[data-hero-fade]"),
          { opacity: 0, y: 16, duration: 0.9, stagger: 0.06 },
          "-=0.45",
        );
    });
    return () => mm.revert();
  }, []);

  // Sections animate in as they scroll into view.
  useEffect(() => {
    let cancelled = false;
    let revert = () => {};
    import("gsap/ScrollTrigger").then(({ ScrollTrigger }) => {
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-step]", {
          opacity: 0,
          y: 36,
          duration: 0.9,
          stagger: 0.12,
          ease: "power3.out",
          scrollTrigger: { trigger: "[data-steps]", start: "top 82%" },
        });
        gsap.from("[data-steps-title]", {
          opacity: 0,
          x: -30,
          duration: 0.9,
          ease: "power3.out",
          scrollTrigger: { trigger: "[data-steps-title]", start: "top 88%" },
        });
      });
      revert = () => mm.revert();
    });
    return () => {
      cancelled = true;
      revert();
    };
  }, []);

  // Loading a video jumps to the studio and brings its panels in.
  useEffect(() => {
    const studio = studioRef.current;
    if (!file || !studio) return;
    studio.scrollIntoView({ behavior: "smooth", block: "start" });
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(studio.querySelectorAll("[data-reveal]"), {
        opacity: 0,
        y: 24,
        duration: 0.8,
        stagger: 0.07,
        ease: "power3.out",
      });
    });
    return () => mm.revert();
  }, [file]);

  // The original frame the run started on, for the before/after wipe.
  useEffect(() => {
    if (!still || !file) return;
    let cancelled = false;
    grabFrame(file, runStart.current).then((url) => {
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      setOriginal((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [still, file]);

  // The site-wide total counts up the first time it arrives.
  const [shownCount, setShownCount] = useState(0);
  useEffect(() => {
    if (videoCount === null) return;
    const counter = { value: shownCount };
    const tween = gsap.to(counter, {
      value: videoCount,
      duration: shownCount === 0 ? 1.4 : 0.6,
      ease: "power2.out",
      onUpdate: () => setShownCount(Math.round(counter.value)),
    });
    return () => {
      tween.kill();
    };
    // Only the target changes the tween; the displayed value is its output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoCount]);

  const [view, setView] = useState<"3d" | "compare" | "flat">("3d");

  // What the 3D view can read. The inferno colormap is not monotonic in
  // brightness, so it cannot be turned back into height.
  const viewerSource =
    result && result.colorMode !== "inferno"
      ? result.extension !== "zip"
        ? {
            src: result.url,
            kind: "video" as const,
            layout:
              result.colorMode === "sideBySide"
                ? ("sideBySide" as const)
                : ("depth" as const),
          }
        : still
          ? { src: still.url, kind: "image" as const, layout: "depth" as const }
          : null
      : null;

  const canCompare = !!(original && still);
  const views = [
    ...(viewerSource ? ([["3d", "Relieve 3D"]] as const) : []),
    ...(canCompare ? ([["compare", "Comparar"]] as const) : []),
    ["flat", result?.extension === "zip" ? "Frame" : "Video"] as const,
  ];
  // Fall back when the preferred view does not exist for this result.
  const activeView = views.some(([key]) => key === view) ? view : views[0][0];

  const pct = Math.round((stage === "loadingModel" ? download : progress) * 100);

  return (
    <main className="relative overflow-x-clip">
      <input
        ref={pickerRef}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) void handleFile(picked);
          // Allow choosing the same file again after an error.
          e.target.value = "";
        }}
      />

      {/* --- hero ------------------------------------------------------- */}
      <section
        ref={heroRef}
        className="relative isolate flex min-h-[100svh] flex-col overflow-hidden"
      >
        <DepthHero paused={busy} className="absolute inset-0 -z-10" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[55%] bg-[radial-gradient(70%_70%_at_50%_0%,rgb(68_228_220/0.16),transparent)]" />
        {/* Keeps the copy legible where the relief passes underneath it. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-full bg-gradient-to-r from-[var(--color-ink)]/90 via-[var(--color-ink)]/55 to-transparent md:w-[60%] md:via-[var(--color-ink)]/70" />
        <div className="dot-grid pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-56 [mask-image:linear-gradient(to_top,black,transparent)]" />
        <Corners inset={14} size={22} className="border-white/25" />

        <header data-hero-fade className="mx-auto w-full max-w-6xl px-6 pt-7">
          <StoryBar segments={7} />
          <div className="mt-4 flex items-center justify-between gap-4">
            <span className="hud flex items-center gap-2.5 text-white/85">
              <span className="size-2 rotate-45 bg-[var(--color-brand)]" />
              DepthMapIA
            </span>
            <span className="hud flex items-center gap-2 text-white/55">
              <span className="rec-dot size-1.5 rounded-full bg-red-500" />
              <span className="hidden sm:inline">Rec</span>
              <Timecode />
              <span className="hidden text-white/30 md:inline">· 25 fps · depth</span>
            </span>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-16">
          <div data-hero-fade className="flex flex-wrap items-center gap-4">
            <SectionLabel n="01">El truco</SectionLabel>
            {videoCount !== null && (
              <Tag tone="dark">
                <span className="text-[var(--color-brand)] tabular-nums">
                  {shownCount.toLocaleString("es")}
                </span>
                {videoCount === 1 ? "video generado" : "videos generados"}
              </Tag>
            )}
          </div>

          <h1 className="display mt-7 whitespace-nowrap text-[clamp(2.5rem,10vw,8.4rem)]">
            <span className="block overflow-hidden pb-[0.04em]">
              <span data-hero-line className="block">
                El truco
              </span>
            </span>
            <span className="block overflow-hidden pb-[0.06em]">
              <span data-hero-line className="relative inline-block text-white/35">
                No es el video…
                <span
                  data-strike
                  aria-hidden
                  className="absolute inset-x-[-0.06em] top-[52%] h-[0.09em] bg-[var(--color-brand)] shadow-[0_0_24px_rgb(68_228_220/0.6)]"
                />
              </span>
            </span>
          </h1>
          <div className="mt-4">
            <span data-slab className="inline-block">
              <Slab className="display whitespace-nowrap text-[clamp(1.85rem,7.4vw,6.2rem)]">
                Es su profundidad.
              </Slab>
            </span>
          </div>

          <p
            data-hero-fade
            className="mt-14 max-w-md text-[15px] leading-relaxed text-white/60"
          >
            Sube un clip, recorta hasta {MAX_CLIP_SECONDS} segundos y conviértelo
            en mapa de profundidad para tus videos con IA. Sin registro, sin
            créditos — y el archivo nunca sale de tu computadora.
          </p>
          <div data-hero-fade className="mt-9 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              disabled={busy || blocked}
              className="group relative inline-flex items-center gap-3 bg-[var(--color-brand)] px-7 py-3.5 text-black shadow-[0_0_40px_rgb(68_228_220/0.35)] transition hover:shadow-[0_0_60px_rgb(68_228_220/0.55)] disabled:opacity-40"
            >
              <span className="display text-xl">Elegir video</span>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                className="transition-transform duration-300 group-hover:translate-x-1"
                aria-hidden
              >
                <path d="M5 12h14m-6-6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <a
              href="#como-funciona"
              className="relative px-6 py-3.5 text-white/75 ring-1 ring-white/20 transition hover:text-white hover:ring-[var(--color-brand)]"
            >
              <span className="hud">Cómo funciona</span>
            </a>
          </div>
        </div>

        <dl
          data-hero-fade
          className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-px border-t border-white/10 px-6 pb-10 pt-6 md:grid-cols-4"
        >
          {(
            [
              ["Gratis", "Sin registro ni créditos"],
              ["Local", "Tu video no se sube"],
              [`${MAX_CLIP_SECONDS} s`, "Por clip, recortable"],
              ["MP4 · PNG · 3D", "Salidas"],
            ] as const
          ).map(([value, label]) => (
            <div key={value} className="py-2">
              <dt className="display text-2xl text-white/90">{value}</dt>
              <dd className="hud mt-1.5 text-[10px] text-white/35">{label}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* --- crossing bands ----------------------------------------------- */}
      <div aria-hidden className="relative z-10 -my-6 select-none py-10">
        <div className="absolute inset-x-[-5%] top-1/2 -translate-y-1/2 rotate-[2.5deg] border-y border-white/10 bg-[var(--color-panel)] py-2.5">
          <Marquee
            speed={30}
            className="display text-2xl text-white/15"
            items={["Depth anything v2", "WebGPU", "Sin servidores", "Sin colas", "Tu GPU", "Sin créditos"]}
          />
        </div>
        <div className="relative -ml-[5%] w-[110%] -rotate-[2deg] bg-[var(--color-brand)] py-3 shadow-[0_0_60px_rgb(68_228_220/0.3)]">
          <Marquee
            speed={55}
            className="display text-3xl text-black"
            items={["Sin registro", "100% local", "Gratis", "MP4", "PNG sin pérdida", "Relieve 3D", "Para videos con IA"]}
          />
        </div>
      </div>

      {/* --- how it works ------------------------------------------------- */}
      <section id="como-funciona" className="mx-auto w-full max-w-6xl scroll-mt-10 px-6 pt-24">
        <div data-steps-title className="flex flex-col gap-5">
          <SectionLabel n="02">Cómo funciona</SectionLabel>
          <h2 className="display text-[clamp(2.6rem,6vw,4.8rem)]">
            Tres pasos.{" "}
            <span className="text-[var(--color-brand)]">Cero servidores.</span>
          </h2>
        </div>
        <div data-steps className="mt-12 grid gap-4 md:grid-cols-3">
          {(
            [
              ["01", "Sube y recorta", "Cualquier video de hasta 25 MB. Eliges el tramo y capturas el frame que quieras.", "Tu archivo"],
              ["02", "Tu GPU lo procesa", "Depth Anything V2 corre en tu navegador. Sin colas, sin servidores, sin esperar a nadie.", "WebGPU"],
              ["03", "Descarga o compáralo", "Video, PNG sin pérdida, relieve 3D o el antes y después, para revisarlo antes de usarlo.", "Listo"],
            ] as const
          ).map(([n, title, body, tag]) => (
            <div
              key={n}
              data-step
              className="group relative flex min-h-64 flex-col overflow-hidden rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-6 transition-colors duration-300 hover:border-[var(--color-brand)]/50"
            >
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-24 bg-[radial-gradient(70%_100%_at_0%_0%,rgb(68_228_220/0.12),transparent)] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              />
              <Corners inset={8} size={10} className="border-white/20 transition-colors group-hover:border-[var(--color-brand)]" />
              <div className="relative flex items-start justify-between">
                <span className="display text-6xl text-transparent [-webkit-text-stroke:1.5px_var(--color-brand)]">
                  {n}
                </span>
                <Tag tone="dark">{tag}</Tag>
              </div>
              <h3 className="display relative mt-auto pt-10 text-[1.9rem]">{title}</h3>
              <p className="relative mt-3 text-sm leading-relaxed text-white/50">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --- studio ------------------------------------------------------- */}
      <section
        id="estudio"
        ref={studioRef}
        className="mx-auto w-full max-w-6xl scroll-mt-6 px-6 pb-28 pt-28"
      >
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-4">
            <SectionLabel n="03">El estudio</SectionLabel>
            <h2 className="display text-[clamp(2.4rem,5vw,4rem)]">
              {file ? "Tu clip" : "Empieza con un video"}
            </h2>
            {file && (
              <p className="hud flex flex-wrap items-center gap-x-3 gap-y-1 text-white/45">
                <span className="max-w-[28ch] truncate normal-case tracking-normal text-sm text-white/80">
                  {file.name}
                </span>
                <span>{formatBytes(file.size)}</span>
                {duration !== null && <span>{duration.toFixed(1)} s</span>}
              </p>
            )}
          </div>
          {file && (
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              disabled={busy}
              className="px-4 py-2.5 text-white/70 ring-1 ring-white/20 transition hover:text-white hover:ring-[var(--color-brand)] disabled:opacity-40"
            >
              <span className="hud">Cambiar video</span>
            </button>
          )}
        </div>

        <div className="flex flex-col gap-4 empty:hidden">
          <CompatBanner caps={caps} />
          {error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              <p className="break-words font-medium">{error}</p>
              <p className="mt-1 text-xs text-red-200/60">
                Abre la consola del navegador para ver el detalle completo.
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* left: the work itself */}
          <div className="flex min-w-0 flex-col gap-6">
            {!file && (
              <div data-reveal>
                <Dropzone
                  onFile={handleFile}
                  disabled={busy || blocked}
                  maxBytes={MAX_FILE_BYTES}
                />
              </div>
            )}

            {busy && (
              <div
                data-reveal
                className="flex flex-col gap-4 rounded-lg border border-[var(--color-brand)]/30 bg-[var(--color-panel)] p-5 shadow-[0_0_60px_rgb(68_228_220/0.06)]"
              >
                <div className="flex items-center justify-between gap-4">
                  <Tag tone="brand">
                    <span className="rec-dot size-1.5 rounded-full bg-black" />
                    {stage === "loadingModel" ? "Cargando modelo" : "Procesando"}
                  </Tag>
                  <span className="display text-3xl tabular-nums text-[var(--color-brand)]">
                    {pct}%
                  </span>
                </div>
                <SegmentBar
                  segments={24}
                  value={stage === "loadingModel" ? download : progress}
                />
                <p className="hud text-white/50">{status}</p>
                <div className="relative overflow-hidden rounded-md bg-black">
                  <canvas
                    ref={previewRef}
                    className="aspect-video w-full object-contain"
                  />
                  <Tag className="absolute left-6 top-6">Vista previa</Tag>
                  <Corners inset={10} size={12} className="border-white/40" />
                </div>
              </div>
            )}

            {result && (
              <div
                data-reveal
                className="flex flex-col gap-5 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Tag tone="brand">Listo</Tag>
                    <p className="hud text-white/45">
                      {result.extension === "zip"
                        ? "PNG · sin pérdida"
                        : `${result.extension === "mp4" ? "MP4" : "WebM"} · ${
                            (result.codec && CODEC_LABELS[result.codec]) ??
                            result.codec
                          }`}{" "}
                      · {formatBytes(result.bytes)}
                    </p>
                  </div>
                  {views.length > 1 && (
                    <Segmented
                      label="Vista"
                      value={activeView}
                      onChange={setView}
                      options={views}
                    />
                  )}
                </div>

                <div className="overflow-hidden rounded-md">
                  {activeView === "3d" && viewerSource ? (
                    <Depth3DViewer
                      src={viewerSource.src}
                      kind={viewerSource.kind}
                      layout={viewerSource.layout}
                      invert={result.invert}
                    />
                  ) : activeView === "compare" && original && still ? (
                    <CompareSlider before={original} after={still.url} />
                  ) : result.extension !== "zip" ? (
                    <video
                      src={result.url}
                      controls
                      loop
                      muted
                      autoPlay
                      playsInline
                      className="aspect-video w-full bg-black"
                    />
                  ) : (
                    still && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={still.url}
                        alt="Primer frame del mapa de profundidad"
                        className="aspect-video w-full bg-black object-contain"
                      />
                    )
                  )}
                </div>

                <div className="flex flex-wrap gap-3">
                  <a
                    href={result.url}
                    download={`${baseName(file?.name ?? "video")}-depthmap.${result.extension}`}
                    className="group inline-flex flex-1 items-center justify-center gap-3 bg-[var(--color-brand)] px-6 py-3.5 text-black shadow-[0_0_40px_rgb(68_228_220/0.3)] transition hover:shadow-[0_0_60px_rgb(68_228_220/0.5)]"
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
                      <path d="M12 4v12m0 0-5-5m5 5 5-5M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="display text-xl">Descargar {result.extension}</span>
                  </a>
                  {still && (
                    <button
                      type="button"
                      onClick={() =>
                        downloadBlob(
                          still.blob,
                          `${baseName(file?.name ?? "video")}-depth-frame.png`,
                        )
                      }
                      className="px-5 py-3.5 text-white/75 ring-1 ring-white/20 transition hover:text-white hover:ring-[var(--color-brand)]"
                    >
                      <span className="hud">Primer frame · PNG</span>
                    </button>
                  )}
                </div>

                {result.extension === "webm" && (
                  <div className="flex flex-col gap-2 rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs text-amber-100/85">
                    <p>
                      Tu navegador solo pudo codificar{" "}
                      {(result.codec && CODEC_LABELS[result.codec]) ?? result.codec},
                      que no funciona bien dentro de un MP4. Renombrar el archivo
                      no lo arreglaría: haría falta recodificar a H.264, y este
                      navegador no puede. Prueba en Chrome o Edge, o usa el
                      formato PNG, que no depende de códecs.
                    </p>
                    {!!result.codecFailures?.length && (
                      <details>
                        <summary className="cursor-pointer select-none text-amber-100/65">
                          Ver por qué se descartó cada códec (
                          {result.codecFailures.length})
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px] text-amber-100/65">
                          {result.codecFailures.map((f, i) => (
                            <li key={i} className="break-words">
                              {f}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}

            {file && duration !== null && !busy && (
              <div data-reveal>
                <TrimBar
                  file={file}
                  duration={duration}
                  value={range}
                  onChange={setRange}
                  disabled={busy}
                />
              </div>
            )}
          </div>

          {/* right: settings */}
          <aside
            data-reveal
            className="relative flex flex-col gap-6 rounded-lg border border-[var(--color-edge)] bg-[var(--color-panel)] p-5 lg:sticky lg:top-6"
          >
            <div className="flex items-center justify-between">
              <span className="hud text-white/80">Ajustes</span>
              <span className="hud text-[var(--color-brand)]">●</span>
            </div>

            <Field label="Modelo">
              <select
                value={model}
                disabled={busy}
                onChange={(e) => setModel(e.target.value as ModelKey)}
                className="w-full rounded-md border border-[var(--color-edge)] bg-white/[0.02] px-3 py-2.5 text-[13px] outline-none transition focus:border-[var(--color-brand)]"
              >
                {Object.entries(MODELS).map(([key, m]) => (
                  <option key={key} value={key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <Hint>
                {MODELS[model].note} · {MODELS[model].license}
              </Hint>
              {!MODELS[model].commercial && (
                <p className="rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-100/85">
                  Solo uso no comercial. Para trabajo comercial usa una variante
                  Small (Apache-2.0).
                </p>
              )}
            </Field>

            <Field label="Formato">
              <Segmented
                label="Formato"
                value={outputFormat}
                onChange={setOutputFormat}
                disabled={busy}
                options={[
                  ["video", "Video"],
                  ["zip", "PNG (ZIP)"],
                ]}
              />
              <Hint>
                {outputFormat === "zip"
                  ? "Un PNG sin pérdida por frame. ~100 MB por cada 15 s."
                  : "MP4 cuando el navegador puede; si no, WebM."}
              </Hint>
            </Field>

            <Field label="Estilo">
              <Segmented
                label="Estilo"
                value={colorMode}
                onChange={setColorMode}
                disabled={busy}
                options={[
                  ["grayscale", "Grises"],
                  ["inferno", "Inferno"],
                  ["sideBySide", "Lado a lado"],
                ]}
              />
            </Field>

            <Field label="Calidad" dimmed={outputFormat === "zip"}>
              <Segmented
                label="Calidad"
                value={quality}
                onChange={setQuality}
                disabled={busy || outputFormat === "zip"}
                options={[
                  ["high", "Alta"],
                  ["veryHigh", "Muy alta"],
                  ["max", "Máxima"],
                ]}
              />
              <Hint>
                {outputFormat === "zip"
                  ? "No aplica: el PNG ya es sin pérdida."
                  : QUALITY_LEVELS[quality].note}
              </Hint>
            </Field>

            <div className="flex items-center gap-3">
              <span className="hud text-white/35">Movimiento</span>
              <span className="h-px flex-1 bg-[var(--color-edge)]" />
            </div>

            <Field label="Suavizado temporal">
              <Segmented
                label="Suavizado temporal"
                value={smoothing}
                onChange={setSmoothing}
                disabled={busy}
                options={[
                  ["off", "No"],
                  ["soft", SMOOTHING_LEVELS.soft.label],
                  ["strong", SMOOTHING_LEVELS.strong.label],
                ]}
              />
              <Hint>Quita la vibración del fondo sin arrastrar lo que se mueve.</Hint>
            </Field>

            <Field label="Desenfoque de movimiento">
              <Segmented
                label="Desenfoque de movimiento"
                value={motionBlur}
                onChange={setMotionBlur}
                disabled={busy}
                options={[
                  ["off", "No"],
                  ["subtle", MOTION_BLUR_LEVELS.subtle.label],
                  ["cinematic", "Cine"],
                ]}
              />
              <Hint>Más fluidez a 25–30 fps, a cambio de bordes más suaves.</Hint>
            </Field>

            <div className="flex flex-col gap-3">
              <Toggle
                label="Estabilizar"
                hint="Evita el parpadeo de brillo"
                checked={stabilize}
                onChange={setStabilize}
                disabled={busy}
              />
              <Toggle
                label="Invertir"
                hint="Cerca = negro"
                checked={invert}
                onChange={setInvert}
                disabled={busy}
              />
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={start}
                disabled={!file || busy || blocked}
                className="bg-[var(--color-brand)] px-5 py-3.5 text-black shadow-[0_0_40px_rgb(68_228_220/0.3)] transition hover:shadow-[0_0_60px_rgb(68_228_220/0.5)] disabled:cursor-not-allowed disabled:opacity-25 disabled:shadow-none"
              >
                <span className="display text-xl">
                  {busy ? "Procesando…" : "Generar profundidad"}
                </span>
              </button>
              {busy && (
                <button
                  type="button"
                  onClick={cancel}
                  className="px-5 py-2.5 text-white/70 ring-1 ring-white/20 transition hover:ring-white/40"
                >
                  <span className="hud">Cancelar</span>
                </button>
              )}
              {!file && (
                <p className="hud text-center text-[10px] text-white/30">
                  Elige un video para empezar
                </p>
              )}
            </div>
          </aside>
        </div>
      </section>

      <footer className="relative overflow-hidden border-t border-[var(--color-edge)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 pb-8 pt-16">
          <p
            aria-hidden
            className="display select-none text-[clamp(4rem,17vw,15rem)] text-transparent [-webkit-text-stroke:1.5px_rgb(68_228_220/0.35)]"
          >
            DepthMapIA
          </p>
          <div className="hud flex flex-wrap items-center justify-between gap-4 text-[10px] text-white/35">
            <span>Depth Anything V2 · transformers.js · WebGPU</span>
            <span>Tu video nunca sale de tu computadora</span>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Field({
  label,
  dimmed,
  children,
}: {
  label: string;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-2 ${dimmed ? "opacity-45" : ""}`}>
      <span className="text-[13px] font-medium text-white/85">{label}</span>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-snug text-white/40">{children}</p>;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between gap-3 text-left disabled:opacity-40"
    >
      <span>
        <span className="block text-[13px] font-medium text-white/85">{label}</span>
        <span className="block text-xs text-white/40">{hint}</span>
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
          checked
            ? "bg-[var(--color-brand)] shadow-[0_0_16px_rgb(68_228_220/0.4)]"
            : "bg-white/15"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full transition-all duration-200 ${
            checked ? "left-[18px] bg-black" : "left-0.5 bg-white/70"
          }`}
        />
      </span>
    </button>
  );
}
