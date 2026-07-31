/** Strips the extension so generated names stay tied to the source file. */
export function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "") || "video";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Timestamps like 3.25s become "3s25", which is safe in a filename. */
export function timeTag(seconds: number): string {
  const whole = Math.floor(seconds);
  const frac = Math.round((seconds - whole) * 100);
  return `${whole}s${frac.toString().padStart(2, "0")}`;
}
