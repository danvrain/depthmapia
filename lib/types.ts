import type { ModelKey, QualityKey, SmoothingKey } from "./constants";

/** Selected portion of the source video, in seconds. */
export type Range = { start: number; end: number };

export type ColorMode = "grayscale" | "inferno" | "sideBySide";

/**
 * `zip` writes one lossless PNG per frame. It sidesteps video encoding
 * entirely — no codec negotiation, no compression artifacts — at the cost of a
 * far larger download.
 */
export type OutputFormat = "video" | "zip";

export type WorkerRequest =
  | {
      type: "process";
      file: File;
      model: ModelKey;
      colorMode: ColorMode;
      /** Only this slice of the source video is decoded and processed. */
      range: Range;
      outputFormat: OutputFormat;
      /** Encoding fidelity. Depth maps compress extremely well, so the default
       *  quantizer-based setting yields very small files that can band. */
      quality: QualityKey;
      /** Per-pixel temporal blending, which removes frame-to-frame shimmer. */
      smoothing: SmoothingKey;
      /** Smooths depth range across frames to stop the output from flickering. */
      stabilize: boolean;
      /** Invert so that near = black instead of near = white. */
      invert: boolean;
    }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "status"; stage: Stage; message: string }
  | { type: "modelProgress"; loaded: number; total: number; file: string }
  | {
      type: "frame";
      /** 0..1 */
      progress: number;
      frameIndex: number;
      totalFrames: number;
      /** Preview of the current depth frame. */
      preview?: ImageBitmap;
    }
  | {
      /** First depth frame, emitted as soon as it exists so it can be grabbed
       *  without waiting for the whole clip to finish. */
      type: "still";
      blob: Blob;
    }
  | {
      type: "done";
      blob: Blob;
      extension: string;
      /** Which encoder produced the file. Absent for PNG sequences, which do
       *  not go through a video encoder at all. */
      codec?: string;
      /** Every configuration the probe rejected, with the reason. Shown in the
       *  UI rather than only logged, since opening a console is a real hurdle. */
      codecFailures?: string[];
    }
  | { type: "error"; message: string };

export type Stage =
  | "idle"
  | "loadingModel"
  | "reading"
  | "processing"
  | "encoding"
  | "done"
  | "error";
