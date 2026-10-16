/**
 * Grabs one frame of a local video file as a PNG object URL. Used to pair the
 * original with its depth map in the comparison view. Resolves to `null`
 * rather than throwing, since the comparison is optional.
 */
export function grabFrame(file: File, time: number): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;

    const finish = (result: string | null) => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    video.onerror = () => finish(null);
    video.onloadeddata = () => {
      video.onseeked = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext("2d")!.drawImage(video, 0, 0);
          canvas.toBlob(
            (blob) => finish(blob ? URL.createObjectURL(blob) : null),
            "image/png",
          );
        } catch {
          finish(null);
        }
      };
      // A hair past the start avoids landing on the frame before the trim.
      video.currentTime = Math.min(time + 0.01, Math.max(0, video.duration - 0.05));
    };
    video.src = url;
  });
}
