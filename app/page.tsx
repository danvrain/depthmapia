"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import gsap from "gsap";

import { CompatBanner } from "@/components/CompatBanner";
import { Dropzone } from "@/components/Dropzone";
import { Segmented } from "@/components/Segmented";
import { TrimBar } from "@/components/TrimBar";
import { detectCapabilities, type Capabilities } from "@/lib/capabilities";
import { fetchVideoCount, recordVideo } from "@/lib/counter";
import { baseName, downloadBlob } from "@/lib/download";
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

  // Masked headline reveal, then the supporting copy.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap
        .timeline({ defaults: { ease: "power4.out" } })
        .from(hero.querySelectorAll("[data-hero-line]"), {
          yPercent: 115,
          duration: 1.2,
          stagger: 0.1,
        })
        .from(
          hero.querySelectorAll("[data-hero-fade]"),
          { opacity: 0, y: 18, duration: 1, stagger: 0.08 },
          "-=0.85",
        );
    });
    return () => mm.revert();
  }, []);

  // The steps strip animates in as it scrolls into view.
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
          y: 28,
          duration: 0.9,
          stagger: 0.12,
          ease: "power3.out",
          scrollTrigger: { trigger: "[data-steps]", start: "top 85%" },
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

  const [view, setView] = useState<"3d" | "flat">("3d");

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

  const pct = Math.round((stage === "loadingModel" ? download : progress) * 100);

  return (
    <main className="relative">
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
        className="relative isolate flex min-h-[94svh] flex-col overflow-hidden"
      >
        <DepthHero paused={busy} className="absolute inset-0 -z-10" />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_72%_62%,rgb(255_199_150/0.09),transparent)]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-56 bg-gradient-to-b from-transparent to-[var(--color-ink)]" />
        {/* Keeps the copy legible where the relief passes underneath it. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-full bg-gradient-to-r from-[var(--color-ink)]/90 via-[var(--color-ink)]/60 to-transparent md:w-[62%] md:via-[var(--color-ink)]/75" />

        <nav
          data-hero-fade
          className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-6"
        >
          <span className="flex items-center gap-2.5 text-[15px] font-medium tracking-tight">
            <span className="size-2.5 rounded-full bg-gradient-to-br from-white to-white/10 ring-1 ring-white/30" />
            DepthMapIA
          </span>
          {videoCount !== null && (
            <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-[11px] tracking-wide text-white/55 backdrop-blur">
              <span className="text-white/90 tabular-nums">
                {shownCount.toLocaleString("es")}
              </span>{" "}
              {videoCount === 1 ? "video generado" : "videos generados"}
            </span>
          )}
        </nav>

        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-5 pb-28">
          <p
            data-hero-fade
            className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/45"
          >
            Mapas de profundidad · en tu navegador
          </p>
          <h1 className="mt-6 text-[clamp(2.8rem,7.6vw,6rem)] font-semibold leading-[0.92] tracking-[-0.045em]">
            <span className="block overflow-hidden pb-[0.06em]">
              <span data-hero-line className="block">
                Cualquier video,
              </span>
            </span>
            <span className="block overflow-hidden pb-[0.06em]">
              <span data-hero-line className="block text-white/35">
                en profundidad.
              </span>
            </span>
          </h1>
          <p
            data-hero-fade
            className="mt-7 max-w-md text-[15px] leading-relaxed text-white/55"
          >
            Sube un clip, recorta hasta {MAX_CLIP_SECONDS} segundos y descárgalo
            como mapa de profundidad. Sin registro ni créditos — y el archivo
            nunca sale de tu computadora.
          </p>
          <div data-hero-fade className="mt-10 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              disabled={busy || blocked}
              className="group inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-black transition hover:bg-white/85 disabled:opacity-40"
            >
              Elegir video
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="transition-transform duration-300 group-hover:translate-x-0.5"
                aria-hidden
              >
                <path d="M5 12h14m-6-6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <a
              href="#como-funciona"
              className="rounded-full border border-white/15 px-6 py-3 text-sm text-white/70 transition hover:border-white/35 hover:text-white"
            >
              Cómo funciona
            </a>
          </div>

          <dl
            data-hero-fade
            className="mt-16 grid max-w-lg grid-cols-3 gap-6 border-t border-white/10 pt-6"
          >
            {(
              [
                ["Gratis", "sin registro ni créditos"],
                ["Local", "tu video no se sube"],
                [`${MAX_CLIP_SECONDS} s`, "por clip, recortable"],
              ] as const
            ).map(([value, label]) => (
              <div key={value}>
                <dt className="text-lg font-medium tracking-tight">{value}</dt>
                <dd className="mt-1 text-xs leading-snug text-white/40">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* --- how it works ------------------------------------------------- */}
      <section id="como-funciona" className="mx-auto w-full max-w-6xl scroll-mt-10 px-5">
        <div
          data-steps
          className="grid divide-y divide-[var(--color-edge)] overflow-hidden rounded-3xl border border-[var(--color-edge)] sm:grid-cols-3 sm:divide-x sm:divide-y-0"
        >
        {(
          [
            ["01", "Sube y recorta", "Cualquier video de hasta 25 MB. Eliges el tramo y capturas el frame que quieras."],
            ["02", "Se procesa en tu GPU", "Depth Anything V2 corre en tu navegador. Sin colas, sin servidores, sin esperar a nadie."],
            ["03", "Descarga o míralo en 3D", "Video, secuencia PNG sin pérdida o el relieve en 3D para comprobarlo antes de usarlo."],
          ] as const
        ).map(([n, title, body]) => (
          <div key={n} data-step className="flex flex-col gap-3 p-7">
            <span className="font-mono text-[11px] text-white/35">{n}</span>
            <h3 className="text-[17px] font-medium tracking-tight">{title}</h3>
            <p className="text-sm leading-relaxed text-white/45">{body}</p>
          </div>
        ))}
        </div>
      </section>

      {/* --- studio ------------------------------------------------------- */}
      <section
        id="estudio"
        ref={studioRef}
        className="mx-auto w-full max-w-6xl scroll-mt-6 px-5 pb-28 pt-24"
      >
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/35">
              Estudio
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.03em]">
              {file ? file.name : "Empieza con un video"}
            </h2>
            {file && (
              <p className="mt-1.5 text-sm text-white/45">
                {formatBytes(file.size)}
                {duration !== null && ` · ${duration.toFixed(1)} s`}
              </p>
            )}
          </div>
          {file && (
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              disabled={busy}
              className="rounded-full border border-white/15 px-4 py-2 text-sm text-white/70 transition hover:border-white/35 hover:text-white disabled:opacity-40"
            >
              Cambiar video
            </button>
          )}
        </div>

        <div className="flex flex-col gap-4 empty:hidden">
          <CompatBanner caps={caps} />
          {error && (
            <div className="rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
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
                className="flex flex-col gap-4 rounded-3xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm text-white/70">{status}</span>
                  <span className="font-mono text-sm tabular-nums text-white/90">
                    {pct}%
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-white transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <canvas
                  ref={previewRef}
                  className="aspect-video w-full rounded-2xl bg-black object-contain"
                />
              </div>
            )}

            {result && (
              <div
                data-reveal
                className="flex flex-col gap-5 rounded-3xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-lg font-medium tracking-tight">Listo</p>
                    <p className="text-xs text-white/45">
                      {result.extension === "zip"
                        ? "Secuencia PNG · sin pérdida"
                        : `${result.extension === "mp4" ? "MP4" : "WebM"} · ${
                            (result.codec && CODEC_LABELS[result.codec]) ??
                            result.codec
                          }`}{" "}
                      · {formatBytes(result.bytes)}
                    </p>
                  </div>
                  {viewerSource && (
                    <Segmented
                      label="Vista"
                      value={view}
                      onChange={setView}
                      options={[
                        ["3d", "Relieve 3D"],
                        ["flat", "Plano"],
                      ]}
                    />
                  )}
                </div>

                {viewerSource && view === "3d" ? (
                  <Depth3DViewer
                    src={viewerSource.src}
                    kind={viewerSource.kind}
                    layout={viewerSource.layout}
                    invert={result.invert}
                  />
                ) : result.extension !== "zip" ? (
                  <video
                    src={result.url}
                    controls
                    loop
                    muted
                    autoPlay
                    playsInline
                    className="aspect-video w-full rounded-2xl bg-black"
                  />
                ) : (
                  still && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={still.url}
                      alt="Primer frame del mapa de profundidad"
                      className="aspect-video w-full rounded-2xl bg-black object-contain"
                    />
                  )
                )}

                <div className="flex flex-wrap gap-3">
                  <a
                    href={result.url}
                    download={`${baseName(file?.name ?? "video")}-depthmap.${result.extension}`}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-black transition hover:bg-white/85"
                  >
                    Descargar {result.extension.toUpperCase()}
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
                      className="rounded-full border border-white/15 px-5 py-3 text-sm text-white/75 transition hover:border-white/35 hover:text-white"
                    >
                      Primer frame (PNG)
                    </button>
                  )}
                </div>

                {result.extension === "webm" && (
                  <div className="flex flex-col gap-2 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs text-amber-100/85">
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
            className="flex flex-col gap-6 rounded-3xl border border-[var(--color-edge)] bg-[var(--color-panel)] p-5 lg:sticky lg:top-6"
          >
            <Field label="Modelo">
              <select
                value={model}
                disabled={busy}
                onChange={(e) => setModel(e.target.value as ModelKey)}
                className="w-full rounded-xl border border-[var(--color-edge)] bg-white/[0.02] px-3 py-2.5 text-[13px] outline-none transition focus:border-white/30"
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
                <p className="rounded-xl border border-amber-300/25 bg-amber-300/[0.07] px-3 py-2 text-xs text-amber-100/85">
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

            <div className="h-px bg-[var(--color-edge)]" />

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
                className="rounded-full bg-white px-5 py-3 text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {busy ? "Procesando…" : "Generar profundidad"}
              </button>
              {busy && (
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/70 transition hover:border-white/35"
                >
                  Cancelar
                </button>
              )}
              {!file && (
                <p className="text-center text-xs text-white/35">
                  Elige un video para empezar.
                </p>
              )}
            </div>
          </aside>
        </div>
      </section>

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-[var(--color-edge)] px-5 py-8 text-xs text-white/35">
        <span>DepthMapIA</span>
        <span>
          Depth Anything V2 vía transformers.js y WebGPU. Los pesos del modelo
          quedan en la caché de tu navegador.
        </span>
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
      <span className="text-[13px] font-medium text-white/80">{label}</span>
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
        <span className="block text-[13px] font-medium text-white/80">{label}</span>
        <span className="block text-xs text-white/40">{hint}</span>
      </span>
      <span
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
          checked ? "bg-white" : "bg-white/15"
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
