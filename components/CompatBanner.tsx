"use client";

import type { Capabilities } from "@/lib/capabilities";

const styles = {
  error: "border-red-500/40 bg-red-500/10 text-red-100",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-100",
} as const;

export function CompatBanner({ caps }: { caps: Capabilities | null }) {
  if (!caps) return null;

  if (!caps.supported) {
    return (
      <div className={`rounded-xl border px-4 py-3 text-sm ${styles.error}`}>
        <p className="font-medium">Tu navegador no puede ejecutar esta app.</p>
        <p className="mt-1 text-red-100/80">
          Falta soporte de {!caps.webcodecs && "WebCodecs"}
          {!caps.webcodecs && !caps.offscreenCanvas && " y "}
          {!caps.offscreenCanvas && "OffscreenCanvas"}. Usa Chrome, Edge o
          Safari 26 o superior en una computadora de escritorio.
        </p>
      </div>
    );
  }

  if (caps.mobile) {
    return (
      <div className={`rounded-xl border px-4 py-3 text-sm ${styles.warn}`}>
        <p className="font-medium">Esta app está pensada para escritorio.</p>
        <p className="mt-1 text-amber-100/80">
          En teléfonos y tablets el procesamiento puede tardar varios minutos o
          agotar la memoria del navegador. Ábrela en una computadora.
        </p>
      </div>
    );
  }

  if (!caps.webgpu) {
    return (
      <div className={`rounded-xl border px-4 py-3 text-sm ${styles.warn}`}>
        <p className="font-medium">WebGPU no está disponible.</p>
        <p className="mt-1 text-amber-100/80">
          La app funcionará usando el procesador, bastante más lento. Para la
          mejor velocidad usa Chrome o Edge actualizado, o Safari 26 o superior.
        </p>
      </div>
    );
  }

  return null;
}
