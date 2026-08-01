/** Longest clip that can be processed, measured after trimming. */
export const MAX_CLIP_SECONDS = 15;

/**
 * Longest source video accepted. Longer videos are still refused, but well
 * above the clip limit so there is something worth trimming.
 */
export const MAX_SOURCE_SECONDS = 10 * 60;

/** Shortest selection that still makes sense to process. */
export const MIN_CLIP_SECONDS = 0.5;

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Longest side fed to the depth model. Depth Anything V2 works at 518x518
 * internally, so going above this costs time without adding detail.
 */
export const INFERENCE_MAX_SIDE = 518;

/** Longest side of the exported video. Frames above this are scaled down. */
export const OUTPUT_MAX_SIDE = 1280;

/**
 * Licences differ per model and are not stated in the upstream repository's
 * LICENSE file, which is Apache-2.0 and covers only the code. The weights are
 * licensed separately, and only the Small variants permit commercial use.
 */
export const MODELS = {
  "depth-anything-v2-small": {
    id: "onnx-community/depth-anything-v2-small",
    label: "Depth Anything V2 Small",
    note: "Recomendado — 25M parámetros, mejor calidad/velocidad",
    dtype: "q8",
    license: "Apache-2.0",
    commercial: true,
  },
  "depth-anything-v2-base": {
    id: "onnx-community/depth-anything-v2-base",
    label: "Depth Anything V2 Base",
    note: "Más detalle, ~3x más lento y descarga más pesada",
    dtype: "q8",
    license: "CC-BY-NC-4.0",
    commercial: false,
  },
  "depth-anything-v1-small": {
    id: "Xenova/depth-anything-small-hf",
    label: "Depth Anything V1 Small",
    note: "Alternativa si V2 falla al cargar",
    dtype: "q8",
    license: "Apache-2.0",
    commercial: true,
  },
} as const;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "depth-anything-v2-small";

export const QUALITY_LEVELS = {
  high: { label: "Alta", note: "archivo mínimo, puede bandear" },
  veryHigh: { label: "Muy alta", note: "equilibrada" },
  max: { label: "Máxima", note: "recomendado — bitrate fijo, sin bandeo" },
} as const;

export type QualityKey = keyof typeof QUALITY_LEVELS;

/**
 * Depth maps are smooth and compress to almost nothing under constant-quality
 * encoding, which is exactly where banding appears — and banded depth is
 * quantised depth, which degrades anything consuming it downstream.
 */
export const DEFAULT_QUALITY: QualityKey = "max";

export const SMOOTHING_LEVELS = {
  off: { label: "Desactivado", alpha: 0 },
  soft: { label: "Suave", alpha: 0.4 },
  strong: { label: "Fuerte", alpha: 0.65 },
} as const;

export type SmoothingKey = keyof typeof SMOOTHING_LEVELS;
export const DEFAULT_SMOOTHING: SmoothingKey = "soft";

export const ACCEPTED_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
