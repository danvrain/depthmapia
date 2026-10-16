import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "DepthMapIA — Mapas de profundidad para tus videos",
  description:
    "Convierte cualquier video en un mapa de profundidad. Gratis, sin registro, y todo se procesa en tu navegador.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="grain min-h-screen antialiased">{children}</body>
    </html>
  );
}
