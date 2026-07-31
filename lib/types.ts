import type { ModelKey } from "./constants";

export type ColorMode = "grayscale" | "inferno" | "sideBySide";

export type WorkerRequest =
  | {
      type: "process";
      file: File;
      model: ModelKey;
      colorMode: ColorMode;
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
  | { type: "done"; buffer: ArrayBuffer; mimeType: string; extension: string }
  | { type: "error"; message: string };

export type Stage =
  | "idle"
  | "loadingModel"
  | "reading"
  | "processing"
  | "encoding"
  | "done"
  | "error";
