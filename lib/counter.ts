/**
 * Global count of generated videos, served by `server/index.mjs`.
 *
 * Every call resolves to `null` rather than throwing when the endpoint is
 * missing — under `next dev` or on static hosting like cPanel — so the page
 * just hides the counter instead of breaking.
 */
const ENDPOINT = "/api/videos";

async function request(method: "GET" | "POST"): Promise<number | null> {
  try {
    const res = await fetch(ENDPOINT, { method, cache: "no-store" });
    // 429 still carries the current total; only the increment was refused.
    if (!res.ok && res.status !== 429) return null;
    const data: unknown = await res.json();
    const videos = (data as { videos?: unknown }).videos;
    return typeof videos === "number" && Number.isFinite(videos) ? videos : null;
  } catch {
    return null;
  }
}

export const fetchVideoCount = () => request("GET");
export const recordVideo = () => request("POST");
