/**
 * pdf.js ships its worker as plain ESM without type declarations.
 *
 * In Node pdf.js has no real Web Worker and would import this file relatively,
 * which breaks once the route handler is bundled. We import it ourselves and
 * hand it over through `globalThis.pdfjsWorker` (see lib/pdfjs.ts).
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
