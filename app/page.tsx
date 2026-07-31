"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CompatBanner } from "@/components/CompatBanner";
import { Dropzone } from "@/components/Dropzone";
import { TrimBar } from "@/components/TrimBar";
import { detectCapabilities, type Capabilities } from "@/lib/capabilities";
import {
  DEFAULT_MODEL,
  MAX_CLIP_SECONDS,
  MAX_FILE_BYTES,
  MAX_SOURCE_SECONDS,
  MODELS,
  formatBytes,
  type ModelKey,
} from "@/lib/constants";
import type {
  ColorMode,
  Range,
  Stage,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/types";

type Result = { url: string; extension: string; bytes: number };

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

  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [range, setRange] = useState<Range>({ start: 0, end: MAX_CLIP_SECONDS });
  const [stage, setStage] = useState<Stage>("idle");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [download, setDownload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const [model, setModel] = useState<ModelKey>(DEFAULT_MODEL);
  const [colorMode, setColorMode] = useState<ColorMode>("grayscale");
  const [stabilize, setStabilize] = useState(true);
  const [invert, setInvert] = useState(false);

  const busy = stage === "loadingModel" || stage === "processing" || stage === "encoding";
  const blocked = caps !== null && !caps.supported;

  useEffect(() => {
    detectCapabilities().then(setCaps);
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
        // The total is derived from duration x frame rate, so it is close but
        // not exact — hence the tilde.
        setStatus(`Frame ${msg.frameIndex} de ~${msg.totalFrames}`);
        if (msg.preview) {
          const canvas = previewRef.current;
          if (canvas) {
            canvas.width = msg.preview.width;
            canvas.height = msg.preview.height;
            canvas.getContext("2d")?.drawImage(msg.preview, 0, 0);
          }
          msg.preview.close();
        }
      } else if (msg.type === "done") {
        const blob = new Blob([msg.buffer], { type: msg.mimeType });
        setResult({
          url: URL.createObjectURL(blob),
          extension: msg.extension,
          bytes: blob.size,
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
    setStage("loadingModel");
    setStatus("Preparando el modelo…");
    const req: WorkerRequest = {
      type: "process",
      file,
      model,
      colorMode,
      range,
      stabilize,
      invert,
    };
    workerRef.current.postMessage(req);
  }, [file, model, colorMode, range, stabilize, invert, reset]);

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: "cancel" } satisfies WorkerRequest);
    setStage("idle");
    setStatus("Cancelado");
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-14">
      <header className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">
          Depth<span className="text-[var(--color-accent)]">MapIA</span>
        </h1>
        <p className="max-w-xl text-white/60">
          Sube un video, recorta los {MAX_CLIP_SECONDS} segundos que te interesan
          y descárgalos convertidos en mapa de profundidad. Todo corre en tu
          navegador — el archivo nunca se sube a ningún servidor.
        </p>
      </header>

      <CompatBanner caps={caps} />

      <Dropzone
        onFile={handleFile}
        disabled={busy || blocked}
        maxBytes={MAX_FILE_BYTES}
      />

      {file && (
        <p className="text-sm text-white/60">
          <span className="text-white/90">{file.name}</span> ·{" "}
          {formatBytes(file.size)}
          {duration !== null && ` · ${duration.toFixed(1)}s`}
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <p className="font-medium break-words">{error}</p>
          <p className="mt-1 text-xs text-red-200/60">
            Abre la consola del navegador para ver el detalle completo.
          </p>
        </div>
      )}

      {file && duration !== null && (
        <TrimBar
          file={file}
          duration={duration}
          value={range}
          onChange={setRange}
          disabled={busy}
        />
      )}

      <section className="grid gap-5 rounded-2xl border border-[var(--color-edge)] bg-[var(--color-panel)]/60 p-5">
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium text-white/80">Modelo</span>
          <select
            value={model}
            disabled={busy}
            onChange={(e) => setModel(e.target.value as ModelKey)}
            className="rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 outline-none focus:border-[var(--color-accent)]"
          >
            {Object.entries(MODELS).map(([key, m]) => (
              <option key={key} value={key}>
                {m.label} — {m.note}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium text-white/80">Salida</span>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["grayscale", "Escala de grises"],
                ["inferno", "Colormap inferno"],
                ["sideBySide", "Original + depth"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => setColorMode(value)}
                className={[
                  "rounded-lg border px-3 py-2 transition",
                  colorMode === value
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15 text-white"
                    : "border-[var(--color-edge)] text-white/70 hover:border-white/30",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={stabilize}
              disabled={busy}
              onChange={(e) => setStabilize(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
            />
            <span className="text-white/80">Estabilizar (evita parpadeo)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={invert}
              disabled={busy}
              onChange={(e) => setInvert(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
            />
            <span className="text-white/80">Invertir (cerca = negro)</span>
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={!file || busy || blocked}
          className="rounded-xl bg-[var(--color-accent)] px-5 py-3 font-medium text-[#04070f] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Procesando…" : "Generar mapa de profundidad"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={cancel}
            className="rounded-xl border border-[var(--color-edge)] px-5 py-3 text-white/70 transition hover:border-white/30"
          >
            Cancelar
          </button>
        )}
      </div>

      {(busy || stage === "done") && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm text-white/60">
            <span>{status}</span>
            <span>
              {Math.round(
                (stage === "loadingModel" ? download : progress) * 100,
              )}
              %
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
              style={{
                width: `${(stage === "loadingModel" ? download : progress) * 100}%`,
              }}
            />
          </div>
          <canvas
            ref={previewRef}
            className="w-full rounded-xl border border-[var(--color-edge)] bg-black"
          />
        </section>
      )}

      {result && (
        <a
          href={result.url}
          download={`depthmap-${file?.name?.replace(/\.[^.]+$/, "") ?? "video"}.${result.extension}`}
          className="rounded-xl bg-emerald-400 px-5 py-3 text-center font-medium text-[#04120c] transition hover:brightness-110"
        >
          Descargar video ({formatBytes(result.bytes)})
        </a>
      )}

      <footer className="mt-6 text-xs text-white/35">
        Procesado localmente con Depth Anything V2 vía transformers.js y WebGPU.
        Los pesos del modelo se descargan una vez y quedan en la caché del
        navegador.
      </footer>
    </main>
  );
}
