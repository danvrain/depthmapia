import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: `next build` emits a plain `out/` folder that can be
  // uploaded straight into public_html on cPanel. No Node runtime required.
  output: "export",
  images: { unoptimized: true },
  // cPanel usually serves from a subfolder or with directory-style URLs.
  trailingSlash: true,
  webpack: (config) => {
    // transformers.js pulls in Node-only modules that must be stubbed out
    // for the browser/worker bundles.
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node": false,
      sharp: false,
    };
    return config;
  },
};

export default nextConfig;
