// Serves the static export and keeps a global count of generated videos.
//
// Dependency-free on purpose: it is one small process that replaces the Caddy
// container, so there is nothing to install beyond Node itself.

import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";

const PORT = Number(process.env.PORT) || 8080;
const ROOT = resolve(process.env.STATIC_DIR || "out");

// Point this at a mounted volume. Without one the file lives in the container
// and the count resets on every deploy.
const COUNTER_FILE = resolve(process.env.COUNTER_FILE || "/data/counter.json");

// One increment per address per window. The counter is for display, not
// billing, so this only needs to stop a casual script from inflating it.
const RATE_WINDOW_MS = 10_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

const BASE_HEADERS = {
  // Unlocks SharedArrayBuffer so onnxruntime-web can run multi-threaded WASM.
  // `credentialless` rather than `require-corp` keeps the Hugging Face model
  // download working.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/* -------------------------------------------------------------------------- */
/* Counter                                                                    */
/* -------------------------------------------------------------------------- */

let count = 0;
let persistent = true;
let writing = Promise.resolve();
const lastHit = new Map();

async function loadCount() {
  try {
    const data = JSON.parse(await readFile(COUNTER_FILE, "utf8"));
    count = Number.isFinite(data.videos) ? data.videos : 0;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[counter] could not read:", err.message);
  }
  try {
    await mkdir(dirname(COUNTER_FILE), { recursive: true });
  } catch (err) {
    persistent = false;
    console.warn(
      `[counter] ${dirname(COUNTER_FILE)} is not writable (${err.code}); ` +
        "counting in memory only — it will reset on restart. Mount a volume.",
    );
  }
  console.log(`[counter] starting at ${count}, file: ${COUNTER_FILE}`);
}

function saveCount() {
  if (!persistent) return;
  const snapshot = JSON.stringify({ videos: count });
  // Writes are chained so two increments never race on the same temp file,
  // and the rename keeps a crash from leaving a half-written counter.
  writing = writing.then(async () => {
    const tmp = `${COUNTER_FILE}.tmp`;
    try {
      await writeFile(tmp, snapshot);
      await rename(tmp, COUNTER_FILE);
    } catch (err) {
      console.warn("[counter] could not save:", err.message);
    }
  });
}

function clientAddress(req) {
  // Railway terminates traffic at its proxy, so the socket address is the
  // proxy's; the original client is the first forwarded entry.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": MIME[".json"],
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function handleCounter(req, res) {
  if (req.method === "GET") return sendJson(res, 200, { videos: count });

  if (req.method === "POST") {
    const ip = clientAddress(req);
    const now = Date.now();
    const previous = lastHit.get(ip) ?? 0;
    if (now - previous < RATE_WINDOW_MS) {
      return sendJson(res, 429, { videos: count });
    }
    lastHit.set(ip, now);
    count += 1;
    saveCount();
    return sendJson(res, 200, { videos: count });
  }

  res.writeHead(405, { ...BASE_HEADERS, Allow: "GET, POST" });
  res.end();
}

// Old entries are only useful within the window; drop them so the map does
// not grow with every visitor for the lifetime of the process.
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, at] of lastHit) if (at < cutoff) lastHit.delete(ip);
}, 60_000).unref();

/* -------------------------------------------------------------------------- */
/* Static files                                                               */
/* -------------------------------------------------------------------------- */

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Mirrors the export's layout: exact file, then `dir/index.html`, then `.html`. */
async function resolveStatic(urlPath) {
  const safe = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const base = join(ROOT, safe);
  if (!base.startsWith(ROOT)) return null;
  for (const candidate of [base, join(base, "index.html"), `${base}.html`]) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function serveStatic(req, res, pathname) {
  let file = await resolveStatic(pathname);
  let status = 200;
  if (!file) {
    file = join(ROOT, "404.html");
    status = 404;
    if (!(await isFile(file))) {
      res.writeHead(404, BASE_HEADERS);
      return res.end("Not found");
    }
  }

  const headers = {
    ...BASE_HEADERS,
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    // Hashed build assets never change under the same name.
    "Cache-Control": pathname.startsWith("/_next/static/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

/* -------------------------------------------------------------------------- */

await loadCount();

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname === "/api/videos") return handleCounter(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, BASE_HEADERS);
      return res.end();
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, BASE_HEADERS);
    res.end();
  }
}).listen(PORT, () => console.log(`[server] listening on :${PORT}`));
