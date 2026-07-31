/// <reference lib="webworker" />

import {
  pipeline,
  env,
  RawImage,
  type DepthEstimationPipeline,
} from "@huggingface/transformers";
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  NullTarget,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type VideoCodec,
  type VideoEncodingAdditionalOptions,
} from "mediabunny";

import {
  INFERENCE_MAX_SIDE,
  MAX_CLIP_SECONDS,
  MAX_FILE_BYTES,
  MIN_CLIP_SECONDS,
  MODELS,
  OUTPUT_MAX_SIDE,
} from "../lib/constants";
import type { ColorMode, WorkerRequest, WorkerResponse } from "../lib/types";

// Models are fetched from the Hugging Face CDN at runtime, so nothing heavy
// needs to live on the host. Set `env.remoteHost` to a self-hosted mirror if
// you'd rather serve the weights from your own domain.
env.allowLocalModels = false;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

let canceled = false;

/**
 * Tracks how far the pipeline got. Browsers throw very generic messages here —
 * WebKit in particular reports a bare "Type error" — so the phase is usually
 * the only thing that identifies what actually broke.
 */
let phase = "inicio";
const setPhase = (p: string) => {
  phase = p;
};

/* -------------------------------------------------------------------------- */
/* Model loading                                                              */
/* -------------------------------------------------------------------------- */

let cachedKey: string | null = null;
let cachedPipe: DepthEstimationPipeline | null = null;

async function getEstimator(modelKey: keyof typeof MODELS) {
  if (cachedKey === modelKey && cachedPipe) return cachedPipe;

  setPhase("carga del modelo");
  const { id, dtype } = MODELS[modelKey];
  post({
    type: "status",
    stage: "loadingModel",
    message: `Descargando ${MODELS[modelKey].label}…`,
  });

  const progress_callback = (p: {
    status: string;
    file?: string;
    loaded?: number;
    total?: number;
  }) => {
    if (p.status === "progress" && p.total) {
      post({
        type: "modelProgress",
        loaded: p.loaded ?? 0,
        total: p.total,
        file: p.file ?? "",
      });
    }
  };

  // WebGPU is roughly an order of magnitude faster, but is still missing on
  // some browsers — fall back to WASM rather than failing outright.
  let pipe: DepthEstimationPipeline;
  try {
    setPhase("carga del modelo (WebGPU)");
    pipe = await pipeline("depth-estimation", id, {
      device: "webgpu",
      dtype: "fp32",
      progress_callback,
    });
  } catch {
    post({
      type: "status",
      stage: "loadingModel",
      message: "WebGPU no disponible, usando CPU (más lento)…",
    });
    setPhase("carga del modelo (WASM)");
    pipe = await pipeline("depth-estimation", id, {
      device: "wasm",
      dtype,
      progress_callback,
    });
  }

  cachedPipe = pipe;
  cachedKey = modelKey;
  return pipe;
}

/* -------------------------------------------------------------------------- */
/* Colour mapping                                                             */
/* -------------------------------------------------------------------------- */

/** Sampled control points of matplotlib's "inferno" colormap. */
const INFERNO: [number, number, number][] = [
  [0, 0, 4],
  [22, 11, 57],
  [66, 10, 104],
  [106, 23, 110],
  [147, 38, 103],
  [188, 55, 84],
  [221, 81, 58],
  [243, 120, 25],
  [252, 165, 10],
  [246, 215, 70],
  [252, 255, 164],
];

function infernoLut(): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const segments = INFERNO.length - 1;
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * segments;
    const lo = Math.min(Math.floor(x), segments - 1);
    const t = x - lo;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = Math.round(
        INFERNO[lo][c] * (1 - t) + INFERNO[lo + 1][c] * t,
      );
    }
  }
  return lut;
}

const LUT = infernoLut();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** H.264 requires even dimensions; round down to the nearest even number. */
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale) };
}

/** MP4 can carry these; anything else goes into WebM. */
const MP4_CODECS = new Set<VideoCodec>(["avc", "hevc", "av1", "vp9"]);

type Attempt = {
  codec: VideoCodec;
  label: string;
  options: VideoEncodingAdditionalOptions;
};

/**
 * Configurations to try for a codec, in descending order of preference.
 *
 * A codec being available does not mean every profile of it is. Encoders
 * commonly reject the High profile that gets picked by default while happily
 * accepting Main or Baseline, so H.264 gets several explicit profile strings
 * before it is written off — the difference between an MP4 and a VP8 WebM.
 */
function attemptsFor(codec: VideoCodec): Attempt[] {
  const base: Attempt[] = [{ codec, label: `${codec}`, options: {} }];

  if (codec === "avc") {
    base.push(
      { codec, label: "avc/main-4.0", options: { fullCodecString: "avc1.4d0028" } },
      { codec, label: "avc/baseline-4.0", options: { fullCodecString: "avc1.420028" } },
      { codec, label: "avc/baseline-3.1", options: { fullCodecString: "avc1.42001f" } },
      { codec, label: "avc/high-4.0", options: { fullCodecString: "avc1.640028" } },
    );
  }

  // Software encoding is slower but available where hardware paths are not.
  base.push({
    codec,
    label: `${codec}/software`,
    options: { hardwareAcceleration: "prefer-software" },
  });

  return base;
}

/**
 * Picks a codec by actually encoding a throwaway frame with it.
 *
 * `VideoEncoder.isConfigSupported` is optimistic in Safari: it reports codecs
 * as supported that then throw a bare "Type error" the moment the encoder is
 * really configured. Probing costs one frame and tells the truth.
 */
async function pickWorkingCodec(
  width: number,
  height: number,
): Promise<{
  codec: VideoCodec;
  useMp4: boolean;
  options: VideoEncodingAdditionalOptions;
}> {
  const advertised = await getFirstEncodableVideoCodec(
    ["avc", "hevc", "av1", "vp9", "vp8"] as VideoCodec[],
    { width, height },
  );

  // Try what the browser advertises first, then everything else.
  const candidates = [
    ...(advertised ? [advertised] : []),
    ...(["avc", "hevc", "av1", "vp9", "vp8"] as VideoCodec[]),
  ].filter((c, i, all) => all.indexOf(c) === i);

  const probe = new OffscreenCanvas(width, height);
  probe.getContext("2d")!.fillRect(0, 0, width, height);

  const failures: string[] = [];

  for (const attempt of candidates.flatMap(attemptsFor)) {
    const { codec, label, options } = attempt;
    const useMp4 = MP4_CODECS.has(codec);
    let output: Output | null = null;
    try {
      output = new Output({
        format: useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
        target: new NullTarget(),
      });
      const source = new CanvasSource(probe, {
        codec,
        quality: QUALITY_HIGH,
        ...options,
      });
      output.addVideoTrack(source, { frameRate: 30 });
      await output.start();
      await source.add(0, 1 / 30);
      // finalize() flushes the encoder. cancel() abandons it, which hides
      // failures that only surface when the last packets are drained.
      await output.finalize();
      console.info(
        `[DepthMapIA] códec elegido: ${label} (${useMp4 ? "MP4" : "WebM"})`,
        failures.length ? { descartados: failures } : "",
      );
      return { codec, useMp4, options };
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : err}`);
      try {
        await output?.cancel();
      } catch {
        /* the probe already failed; nothing to clean up */
      }
    }
  }

  console.error("[DepthMapIA] ningún códec pudo codificar:", failures);
  throw new Error(
    `Tu navegador no pudo codificar video a ${width}x${height}. Probé ${candidates.join(", ")} y ninguno funcionó.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Main routine                                                               */
/* -------------------------------------------------------------------------- */

async function process(req: Extract<WorkerRequest, { type: "process" }>) {
  const { file, model, colorMode, range, stabilize, invert } = req;

  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `El archivo pesa ${(file.size / 1048576).toFixed(1)} MB y el máximo es 20 MB.`,
    );
  }

  const estimator = await getEstimator(model);
  if (canceled) return;

  setPhase("lectura del contenedor de video");
  post({ type: "status", stage: "reading", message: "Leyendo el video…" });

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("El archivo no contiene una pista de video.");

  const sourceDuration = await input.computeDuration();

  // The trim comes from the UI, so re-clamp it here: the worker must never
  // depend on the caller having got the bounds right.
  const start = Math.min(Math.max(0, range.start), Math.max(0, sourceDuration - MIN_CLIP_SECONDS));
  const end = Math.min(range.end, sourceDuration);
  const duration = end - start;

  if (duration < MIN_CLIP_SECONDS) {
    throw new Error(
      `La selección dura ${duration.toFixed(1)}s y el mínimo es ${MIN_CLIP_SECONDS}s.`,
    );
  }
  if (duration > MAX_CLIP_SECONDS + 0.05) {
    throw new Error(
      `La selección dura ${duration.toFixed(1)}s y el máximo es ${MAX_CLIP_SECONDS}s.`,
    );
  }

  setPhase("análisis de la pista de video");
  // Only a prefix of the packets is scanned: enough for a solid frame rate
  // estimate, but `packetCount` is that sample size, not the real total.
  const stats = await track.computePacketStats(60);
  const fps = stats.averagePacketRate || 30;
  const estimatedFrames = Math.max(1, Math.round(duration * fps));

  // Side-by-side doubles the width, so halve the budget to stay within
  // typical hardware encoder limits.
  const budget = colorMode === "sideBySide" ? OUTPUT_MAX_SIDE / 2 : OUTPUT_MAX_SIDE;
  const frameSize = fitWithin(track.displayWidth, track.displayHeight, budget);
  const infSize = fitWithin(
    track.displayWidth,
    track.displayHeight,
    INFERENCE_MAX_SIDE,
  );

  const canvasWidth =
    colorMode === "sideBySide" ? frameSize.width * 2 : frameSize.width;
  const canvasHeight = frameSize.height;

  // Source frames at output resolution (needed intact for side-by-side).
  const sink = new CanvasSink(track, {
    width: frameSize.width,
    height: frameSize.height,
    fit: "fill",
    poolSize: 2,
  });

  // Downscaled copy handed to the model.
  const infCanvas = new OffscreenCanvas(infSize.width, infSize.height);
  const infCtx = infCanvas.getContext("2d", { willReadFrequently: true })!;

  // Depth is predicted at inference resolution, then upscaled on the GPU.
  const depthCanvas = new OffscreenCanvas(infSize.width, infSize.height);
  const depthCtx = depthCanvas.getContext("2d")!;
  const depthImage = depthCtx.createImageData(infSize.width, infSize.height);

  const outCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const outCtx = outCanvas.getContext("2d")!;

  setPhase("selección de códec");
  const {
    codec,
    useMp4,
    options: codecOptions,
  } = await pickWorkingCodec(canvasWidth, canvasHeight);

  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const source = new CanvasSource(outCanvas, {
    codec,
    quality: QUALITY_HIGH,
    keyFrameInterval: 1,
    ...codecOptions,
  });
  setPhase("apertura del codificador");
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  post({
    type: "status",
    stage: "processing",
    message: "Generando el mapa de profundidad…",
  });

  // Exponential moving average of the depth range. Normalising each frame
  // independently makes the output flicker badly, because the min/max shift
  // frame to frame; smoothing the range removes almost all of it.
  let emaMin = 0;
  let emaMax = 1;
  let hasRange = false;
  const alpha = 0.85;

  let frameIndex = 0;
  let lastEnd = 0;

  for await (const {
    canvas,
    timestamp,
    duration: frameDuration,
  } of sink.canvases(start, end)) {
    if (canceled) {
      await output.cancel();
      return;
    }

    setPhase(`decodificación del frame ${frameIndex + 1}`);
    infCtx.drawImage(canvas, 0, 0, infSize.width, infSize.height);
    setPhase(`inferencia del frame ${frameIndex + 1}`);
    const { predicted_depth } = await estimator(RawImage.fromCanvas(infCanvas));
    const depth = predicted_depth.data as Float32Array;

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < depth.length; i++) {
      const v = depth[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    if (stabilize) {
      if (!hasRange) {
        emaMin = min;
        emaMax = max;
        hasRange = true;
      } else {
        emaMin = alpha * emaMin + (1 - alpha) * min;
        emaMax = alpha * emaMax + (1 - alpha) * max;
      }
      min = emaMin;
      max = emaMax;
    }

    const range = max - min || 1;
    const pixels = depthImage.data;

    for (let i = 0, p = 0; i < depth.length; i++, p += 4) {
      let v = ((depth[i] - min) / range) * 255;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      let g = v | 0;
      if (invert) g = 255 - g;

      if (colorMode === "grayscale" || colorMode === "sideBySide") {
        pixels[p] = g;
        pixels[p + 1] = g;
        pixels[p + 2] = g;
      } else {
        pixels[p] = LUT[g * 3];
        pixels[p + 1] = LUT[g * 3 + 1];
        pixels[p + 2] = LUT[g * 3 + 2];
      }
      pixels[p + 3] = 255;
    }

    setPhase(`dibujado del frame ${frameIndex + 1}`);
    depthCtx.putImageData(depthImage, 0, 0);

    if (colorMode === "sideBySide") {
      outCtx.drawImage(canvas, 0, 0, frameSize.width, frameSize.height);
      outCtx.drawImage(
        depthCanvas,
        frameSize.width,
        0,
        frameSize.width,
        frameSize.height,
      );
    } else {
      outCtx.drawImage(depthCanvas, 0, 0, canvasWidth, canvasHeight);
    }

    setPhase(`codificación del frame ${frameIndex + 1}`);

    // Phone recordings are frequently variable frame rate, and the last frame
    // of a clip can report a zero or missing duration. Feeding that to the
    // encoder throws an opaque error, so fall back to the average frame time.
    // Rebased to the start of the selection, otherwise a clip trimmed from
    // the middle would begin with a gap the length of everything skipped.
    const rebased = timestamp - start;
    const safeTimestamp =
      Number.isFinite(rebased) && rebased >= 0 ? rebased : lastEnd;
    const safeDuration =
      Number.isFinite(frameDuration) && frameDuration > 0
        ? frameDuration
        : 1 / fps;

    await source.add(safeTimestamp, safeDuration);
    lastEnd = safeTimestamp + safeDuration;

    frameIndex++;

    // The opening depth frame doubles as a still for image-to-video models,
    // so publish it right away rather than at the end of the run.
    if (frameIndex === 1) {
      try {
        const still = new OffscreenCanvas(frameSize.width, frameSize.height);
        still
          .getContext("2d")!
          .drawImage(depthCanvas, 0, 0, frameSize.width, frameSize.height);
        post({ type: "still", blob: await still.convertToBlob({ type: "image/png" }) });
      } catch {
        /* the still is a bonus; never let it stop the run */
      }
    }

    // The frame is already encoded at this point, so it is safe to transfer
    // the canvas contents away for the live preview. The preview is purely
    // cosmetic, so never let it abort a run that is otherwise fine — not every
    // browser can transfer an ImageBitmap across the worker boundary.
    let preview: ImageBitmap | undefined;
    if (frameIndex === 1 || frameIndex % 5 === 0) {
      try {
        preview = outCanvas.transferToImageBitmap();
      } catch {
        preview = undefined;
      }
    }

    const frameMsg: WorkerResponse = {
      type: "frame",
      // Timestamps are exact, so progress reflects the real position in the
      // clip instead of a guessed frame total.
      progress: Math.min(1, Math.max(0, lastEnd / duration)),
      frameIndex,
      totalFrames: Math.max(estimatedFrames, frameIndex),
      preview,
    };

    try {
      post(frameMsg, preview ? [preview] : []);
    } catch {
      post({ ...frameMsg, preview: undefined });
    }
  }

  setPhase("cierre del archivo");
  post({ type: "status", stage: "encoding", message: "Cerrando el archivo…" });
  await output.finalize();

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error("No se pudo generar el archivo de salida.");

  post(
    {
      type: "done",
      buffer,
      mimeType: useMp4 ? "video/mp4" : "video/webm",
      extension: useMp4 ? "mp4" : "webm",
      codec,
    },
    [buffer],
  );
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  if (req.type === "cancel") {
    canceled = true;
    return;
  }

  canceled = false;
  phase = "inicio";
  process(req).catch((err: unknown) => {
    // The full object carries the stack, which the message alone does not.
    console.error(`[DepthMapIA] falló en: ${phase}`, err);

    let detail: string;
    if (err instanceof Error) {
      detail = err.message ? `${err.name}: ${err.message}` : err.name;
    } else {
      detail = String(err);
    }

    post({ type: "error", message: `${detail} — falló en: ${phase}` });
  });
});
