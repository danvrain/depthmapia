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
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from "mediabunny";

import {
  INFERENCE_MAX_SIDE,
  MAX_DURATION_SECONDS,
  MAX_FILE_BYTES,
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

/* -------------------------------------------------------------------------- */
/* Model loading                                                              */
/* -------------------------------------------------------------------------- */

let cachedKey: string | null = null;
let cachedPipe: DepthEstimationPipeline | null = null;

async function getEstimator(modelKey: keyof typeof MODELS) {
  if (cachedKey === modelKey && cachedPipe) return cachedPipe;

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

/* -------------------------------------------------------------------------- */
/* Main routine                                                               */
/* -------------------------------------------------------------------------- */

async function process(req: Extract<WorkerRequest, { type: "process" }>) {
  const { file, model, colorMode, stabilize, invert } = req;

  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `El archivo pesa ${(file.size / 1048576).toFixed(1)} MB y el máximo es 20 MB.`,
    );
  }

  const estimator = await getEstimator(model);
  if (canceled) return;

  post({ type: "status", stage: "reading", message: "Leyendo el video…" });

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });

  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("El archivo no contiene una pista de video.");

  const duration = await input.computeDuration();
  if (duration > MAX_DURATION_SECONDS + 0.05) {
    throw new Error(
      `El video dura ${duration.toFixed(1)}s y el máximo es ${MAX_DURATION_SECONDS}s.`,
    );
  }

  const stats = await track.computePacketStats(60);
  const totalFrames = Math.max(1, stats.packetCount);
  const fps = stats.averagePacketRate || 30;

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

  const codec = await getFirstEncodableVideoCodec(
    ["avc", "vp9", "av1", "vp8"] as VideoCodec[],
    { width: canvasWidth, height: canvasHeight },
  );
  if (!codec) {
    throw new Error(
      "Tu navegador no puede codificar video. Prueba con Chrome o Edge actualizado.",
    );
  }

  const useMp4 = codec === "avc" || codec === "av1" || codec === "vp9";
  const output = new Output({
    format: useMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const source = new CanvasSource(outCanvas, {
    codec,
    quality: QUALITY_HIGH,
    keyFrameInterval: 1,
  });
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

  for await (const { canvas, timestamp, duration: frameDuration } of sink.canvases()) {
    if (canceled) {
      await output.cancel();
      return;
    }

    infCtx.drawImage(canvas, 0, 0, infSize.width, infSize.height);
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

    await source.add(timestamp, frameDuration);

    frameIndex++;
    // The frame is already encoded at this point, so it is safe to transfer
    // the canvas contents away for the live preview.
    const shouldPreview = frameIndex === 1 || frameIndex % 5 === 0;
    const preview = shouldPreview ? outCanvas.transferToImageBitmap() : undefined;

    post(
      {
        type: "frame",
        progress: Math.min(1, frameIndex / totalFrames),
        frameIndex,
        totalFrames,
        preview,
      },
      preview ? [preview] : [],
    );
  }

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
  process(req).catch((err: unknown) => {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  });
});
