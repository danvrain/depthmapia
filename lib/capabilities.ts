export type Capabilities = {
  /** WebCodecs — required. Without it there is no way to decode or encode video. */
  webcodecs: boolean;
  /** OffscreenCanvas in workers — required. */
  offscreenCanvas: boolean;
  /** WebGPU — optional, but the difference between seconds and minutes. */
  webgpu: boolean;
  /** Phones and tablets are out of scope: too slow and memory-constrained. */
  mobile: boolean;
  /** False when the browser simply cannot run the pipeline. */
  supported: boolean;
};

function isMobile(): boolean {
  const uaData = (
    navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData;
  if (typeof uaData?.mobile === "boolean") return uaData.mobile;

  // iPadOS reports a desktop UA, so also treat touch-only Macs as mobile.
  const touchMac =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return touchMac || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } })
    .gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/**
 * Probed once on load so unsupported browsers are told immediately, rather
 * than after downloading tens of megabytes of model weights.
 */
export async function detectCapabilities(): Promise<Capabilities> {
  const webcodecs =
    typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined";
  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const webgpu = await hasWebGPU();

  return {
    webcodecs,
    offscreenCanvas,
    webgpu,
    mobile: isMobile(),
    supported: webcodecs && offscreenCanvas,
  };
}
