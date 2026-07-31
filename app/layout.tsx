import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DepthMapIA — Mapas de profundidad para tus videos",
  description:
    "Sube un video de hasta 15 segundos y descárgalo convertido en mapa de profundidad. Todo se procesa en tu navegador.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
