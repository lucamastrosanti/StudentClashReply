import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  /**
   * Both packages must be loaded by Node itself instead of being bundled:
   * pdf.js resolves its worker and its rasterizer relatively to its own file,
   * and @napi-rs/canvas is a native addon that cannot be bundled.
   */
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
