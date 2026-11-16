/**
 * Single entry point for pdf.js.
 *
 * The library is imported lazily (it is large) and its worker module is
 * registered on the main thread before any document is opened. In Node there is
 * no Web Worker, so pdf.js falls back to a "fake worker" that dynamically
 * imports `./pdf.worker.mjs` relative to its own module URL. When a route
 * handler is bundled inside `.next/`, that relative path points at a chunk that
 * does not exist and every upload fails with:
 *
 *   Setting up fake worker failed: Cannot find module "...pdf.worker.mjs"
 *
 * pdf.js first looks for `globalThis.pdfjsWorker`, so handing it the worker we
 * import ourselves skips the broken relative import entirely.
 */

export type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfJsPromise: Promise<PdfJsModule> | null = null;

export function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const scope = globalThis as typeof globalThis & { pdfjsWorker?: unknown };

    if (!scope.pdfjsWorker) {
      scope.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    }

    return pdfjs;
  })();

  return pdfJsPromise;
}
