/** Hard limits enforced on every uploaded video. */
export const MAX_DURATION_SECONDS = 15;
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Longest side fed to the depth model. Depth Anything V2 works at 518x518
 * internally, so going above this costs time without adding detail.
 */
export const INFERENCE_MAX_SIDE = 518;

/** Longest side of the exported video. Frames above this are scaled down. */
export const OUTPUT_MAX_SIDE = 1280;

export const MODELS = {
  "depth-anything-v2-small": {
    id: "onnx-community/depth-anything-v2-small",
    label: "Depth Anything V2 Small",
    note: "Recomendado — 25M parámetros, mejor calidad/velocidad",
    dtype: "q8",
  },
  "depth-anything-v2-base": {
    id: "onnx-community/depth-anything-v2-base",
    label: "Depth Anything V2 Base",
    note: "Más detalle, ~3x más lento y descarga más pesada",
    dtype: "q8",
  },
  "depth-anything-v1-small": {
    id: "Xenova/depth-anything-small-hf",
    label: "Depth Anything V1 Small",
    note: "Alternativa si V2 falla al cargar",
    dtype: "q8",
  },
} as const;

export type ModelKey = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelKey = "depth-anything-v2-small";

export const ACCEPTED_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
