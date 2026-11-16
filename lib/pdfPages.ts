import { loadPdfJs } from "./pdfjs";

/**
 * Turns a PDF into page images.
 *
 * The whole pipeline works on one picture per slide, because that is what a
 * vision model reads best: every PDF page is rasterised once at a readable
 * width and that single raster feeds both the model (full-size JPEG) and the
 * browser rail (small JPEG). No text is extracted, no geometry is measured and
 * nothing is cropped.
 */

type CanvasModule = typeof import("@napi-rs/canvas");
type RasterCanvas = import("@napi-rs/canvas").Canvas;
type RasterContext = import("@napi-rs/canvas").SKRSContext2D;

export interface PageImage {
  /** Raster size in pixels. */
  width: number;
  height: number;
  /** Full-size JPEG (data URL) sent to the vision model. */
  snapshot(): Promise<string>;
  /** Compact JPEG (data URL) shown in the slide rail. */
  thumbnail(): Promise<string>;
  dispose(): void;
}

export interface PdfPages {
  pageCount: number;
  page(pageNumber: number): Promise<PageImage | null>;
  close(): Promise<void>;
}

/** 1500 px is the width that was verified to read code and tables correctly. */
const RASTER_WIDTH = 1500;
/** Rendering cost grows quadratically: never upscale beyond this. */
const MAX_RASTER_SCALE = 2.5;
const SNAPSHOT_QUALITY = 80;
const THUMBNAIL_WIDTH = 520;
const THUMBNAIL_QUALITY = 72;

let canvasPromise: Promise<CanvasModule> | null = null;

function loadCanvas(): Promise<CanvasModule> {
  canvasPromise ??= import("@napi-rs/canvas").catch((error: unknown) => {
    throw new Error(
      `Page rendering is unavailable: @napi-rs/canvas could not be loaded (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    );
  });

  return canvasPromise;
}

/** Encodes a scaled copy of the raster as a JPEG data URL. */
async function jpegDataUrl(
  source: RasterCanvas,
  canvas: CanvasModule,
  targetWidth: number,
  quality: number,
): Promise<string> {
  const width = Math.max(1, Math.min(targetWidth, source.width));
  const height = Math.max(1, Math.round((source.height * width) / source.width));

  let encoded: RasterCanvas = source;

  if (width !== source.width) {
    const scaled = canvas.createCanvas(width, height);
    const context = scaled.getContext("2d") as RasterContext;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    encoded = scaled;
  }

  const jpeg = await encoded.encode("jpeg", quality);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** Opens the PDF once and exposes a page-at-a-time raster API. */
export async function openPdfPages(buffer: Buffer): Promise<PdfPages> {
  const canvas = await loadCanvas();
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await loadingTask.promise;

  return {
    pageCount: document.numPages,

    async page(pageNumber: number): Promise<PageImage | null> {
      if (pageNumber < 1 || pageNumber > document.numPages) return null;

      const page = await document.getPage(pageNumber).catch(() => null);
      if (!page) return null;

      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(MAX_RASTER_SCALE, Math.max(1, RASTER_WIDTH / base.width));
        const viewport = page.getViewport({ scale });
        const raster = canvas.createCanvas(
          Math.max(1, Math.ceil(viewport.width)),
          Math.max(1, Math.ceil(viewport.height)),
        );
        const context = raster.getContext("2d") as RasterContext;

        // PDF pages have no alpha: a page background is always paper white.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, raster.width, raster.height);

        await page.render({
          // pdf.js v6 wants a DOM canvas; `canvas: null` keeps the Skia context
          // that was created above as the render target.
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        let snapshotCache: string | null = null;
        let thumbnailCache: string | null = null;

        return {
          width: raster.width,
          height: raster.height,

          async snapshot(): Promise<string> {
            snapshotCache ??= await jpegDataUrl(raster, canvas, RASTER_WIDTH, SNAPSHOT_QUALITY);
            return snapshotCache;
          },

          async thumbnail(): Promise<string> {
            thumbnailCache ??= await jpegDataUrl(raster, canvas, THUMBNAIL_WIDTH, THUMBNAIL_QUALITY);
            return thumbnailCache;
          },

          dispose(): void {
            page.cleanup();
          },
        };
      } catch (error) {
        console.warn(`Page raster for page ${pageNumber} failed:`, error);
        page.cleanup();
        return null;
      }
    },

    async close(): Promise<void> {
      await loadingTask.destroy();
    },
  };
}
