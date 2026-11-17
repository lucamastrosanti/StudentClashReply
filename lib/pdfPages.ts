import { loadPdfJs } from "./pdfjs";

/**
 * Turns a PDF into page images.
 *
 * The whole pipeline works on one picture per slide, because that is what a
 * vision model reads best: every PDF page is rasterised once at a readable
 * width and that single raster feeds both the model (full-size JPEG) and the
 * browser rail (small JPEG).
 *
 * A single visual element can also be asked for on its own (`crop`) and that one
 * is rendered again from the vector document at a much higher zoom: a table or
 * a code panel is a few hundred pixels inside the page raster, and upscaling
 * those pixels does not bring the text back. The exact strings of the element
 * are read from the text layer (`textsIn`) so a redrawing model is never asked
 * to guess them.
 */

type CanvasModule = typeof import("@napi-rs/canvas");
type RasterCanvas = import("@napi-rs/canvas").Canvas;
type RasterContext = import("@napi-rs/canvas").SKRSContext2D;

/** A rectangle in fractions of the page: 0 is the left/top edge, 1 the right/bottom. */
export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageImage {
  /** Raster size in pixels. */
  width: number;
  height: number;
  /** Full-size JPEG (data URL) sent to the vision model. */
  snapshot(): Promise<string>;
  /** Compact JPEG (data URL) shown in the slide rail. */
  thumbnail(): Promise<string>;
  /**
   * One element of the page, rendered again from the document at a size the
   * vision model can read, as a JPEG data URL.
   *
   * This is not a crop of the page raster: the page is a vector document, and
   * re-rendering the region at a higher zoom keeps the small type of a table or
   * a code panel crisp. A 1500 px page raster would leave a table's rows at six
   * pixels; the same table rendered alone arrives at a thousand.
   */
  crop(box: PageBox, targetWidth?: number): Promise<string>;
  /**
   * The texts printed inside an area, read from the document's text layer.
   *
   * These are the exact strings, not a model's transcription of them: a figure
   * that is mostly text (a table, a code panel) is redrawn from the real thing.
   * Empty when the text is vector-drawn or part of an image.
   */
  textsIn(box: PageBox): Promise<string[]>;
  /**
   * The area the texts of `box` actually occupy, in fractions of the page.
   *
   * The analysis reports the area of an element from looking at it, and it is
   * approximate; for a table, the text layer knows exactly where the header and
   * the last row are. Null when the area has no text layer (a picture).
   */
  textBoundsIn(box: PageBox): Promise<PageBox | null>;
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
/**
 * One figure is rendered on its own: the width the model reads it at, and the
 * ceiling that keeps a full-width element from becoming a fifteen-megapixel
 * picture that is slow to render and large to send.
 */
const CROP_WIDTH = 1200;
const CROP_QUALITY = 84;
const MAX_CROP_SCALE = 4;
const MAX_CROP_SIDE = 1800;
const MAX_CROP_PIXELS = 2_800_000;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The box a caller gave us, made valid and fully inside the page. */
function safeBox(box: PageBox): PageBox {
  const left = clamp01(box.left);
  const top = clamp01(box.top);

  return {
    left,
    top,
    width: Math.min(clamp01(box.width), 1 - left),
    height: Math.min(clamp01(box.height), 1 - top),
  };
}

interface TextFragment {
  str: string;
  left: number;
  right: number;
  /** Baseline, in the coordinates of the scale-1 viewport. */
  baseline: number;
  height: number;
}

/**
 * The lines of text whose centre falls inside `box`.
 *
 * The text layer is a bag of fragments, not of lines: a single table row
 * arrives as a dozen pieces, and a caption as one. Fragments that share a
 * baseline are put back together in reading order, then filtered by the area
 * the analysis reserved for the figure.
 */
interface TextBlock {
  lines: string[];
  /** Where the lines are, in fractions of the page; null when there are none. */
  bounds: PageBox | null;
}

function textBlockInBox(
  items: unknown[],
  base: { width: number; height: number; transform: number[] },
  box: PageBox,
  compose: (first: number[], second: number[]) => number[],
): TextBlock {
  const fragments: TextFragment[] = [];

  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;

    const item = entry as {
      str?: unknown;
      transform?: unknown;
      width?: unknown;
      height?: unknown;
    };
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    if (!Array.isArray(item.transform) || item.transform.length !== 6) continue;

    const tx = compose(base.transform, item.transform as number[]);
    const height = Math.max(1, Math.hypot(tx[2], tx[3]));
    const left = tx[4];
    const baseline = tx[5];

    fragments.push({
      str: item.str,
      left,
      right: left + Math.max(0, typeof item.width === "number" ? item.width : 0),
      baseline,
      height,
    });
  }

  fragments.sort((first, second) => first.baseline - second.baseline || first.left - second.left);

  const lines: { baseline: number; height: number; parts: TextFragment[] }[] = [];

  for (const fragment of fragments) {
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate.baseline - fragment.baseline) <=
        Math.max(2, Math.min(candidate.height, fragment.height) * 0.45),
    );

    if (line) {
      line.parts.push(fragment);
      line.height = Math.max(line.height, fragment.height);
    } else {
      lines.push({ baseline: fragment.baseline, height: fragment.height, parts: [fragment] });
    }
  }

  const read: string[] = [];
  const margin = 0.015;
  let leftEdge = 1;
  let topEdge = 1;
  let rightEdge = 0;
  let bottomEdge = 0;

  for (const line of lines.sort((first, second) => first.baseline - second.baseline)) {
    const parts = [...line.parts].sort((first, second) => first.left - second.left);
    const left = Math.min(...parts.map((part) => part.left));
    const right = Math.max(...parts.map((part) => part.right));
    const centerX = (left + right) / 2 / Math.max(1, base.width);
    const centerY = (line.baseline - line.height / 2) / Math.max(1, base.height);

    if (centerX < box.left - margin || centerX > box.left + box.width + margin) continue;
    if (centerY < box.top - margin || centerY > box.top + box.height + margin) continue;

    let text = "";
    let previousRight: number | null = null;

    for (const part of parts) {
      if (previousRight !== null) {
        const gap = part.left - previousRight;
        if (gap > 0.18 * line.height) text += " ";
      }

      text += part.str;
      previousRight = Math.max(previousRight ?? Number.NEGATIVE_INFINITY, part.right);
    }

    const clean = text.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) continue;

    leftEdge = Math.min(leftEdge, left / Math.max(1, base.width));
    rightEdge = Math.max(rightEdge, right / Math.max(1, base.width));
    topEdge = Math.min(topEdge, (line.baseline - line.height) / Math.max(1, base.height));
    bottomEdge = Math.max(bottomEdge, line.baseline / Math.max(1, base.height));

    // The strings are capped for the prompt, the bounds are not: a long table
    // still has to contribute its last row to the area it occupies.
    if (read.length < 40 && read[read.length - 1] !== clean) read.push(clean);
  }

  const bounds: PageBox | null =
    rightEdge > leftEdge && bottomEdge > topEdge
      ? {
          left: Math.max(0, leftEdge),
          top: Math.max(0, topEdge),
          width: Math.min(1, rightEdge) - Math.max(0, leftEdge),
          height: Math.min(1, bottomEdge) - Math.max(0, topEdge),
        }
      : null;

  return { lines: read, bounds };
}

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
        let textContent: Promise<{ items: unknown[] }> | null = null;
        const crops = new Map<string, Promise<string>>();
        const blocks = new Map<string, Promise<TextBlock>>();

        /** The page raster, cut down to `box`; the fallback when a re-render fails. */
        const rasterCrop = async (box: PageBox): Promise<string> => {
          const left = Math.max(0, Math.min(raster.width - 1, Math.round(box.left * raster.width)));
          const top = Math.max(0, Math.min(raster.height - 1, Math.round(box.top * raster.height)));
          const sourceWidth = Math.min(
            Math.max(1, Math.round(box.width * raster.width)),
            raster.width - left,
          );
          const sourceHeight = Math.min(
            Math.max(1, Math.round(box.height * raster.height)),
            raster.height - top,
          );
          const width = Math.max(1, Math.min(CROP_WIDTH, sourceWidth * 2));
          const height = Math.max(1, Math.round((sourceHeight * width) / sourceWidth));

          const scaled = canvas.createCanvas(width, height);
          const scaledContext = scaled.getContext("2d") as RasterContext;
          scaledContext.fillStyle = "#ffffff";
          scaledContext.fillRect(0, 0, width, height);
          scaledContext.imageSmoothingEnabled = true;
          scaledContext.drawImage(raster, left, top, sourceWidth, sourceHeight, 0, 0, width, height);

          const jpeg = await scaled.encode("jpeg", CROP_QUALITY);
          return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
        };

        /** The lines and their bounds for one area; parsed once per area. */
        const blockFor = (area: PageBox): Promise<TextBlock> => {
          const key = [
            area.left.toFixed(4),
            area.top.toFixed(4),
            area.width.toFixed(4),
            area.height.toFixed(4),
          ].join(":");
          const cached = blocks.get(key);
          if (cached) return cached;

          const job = (async () => {
            textContent ??= page.getTextContent() as unknown as Promise<{ items: unknown[] }>;
            const content = await textContent;
            const unit = page.getViewport({ scale: 1 });

            return textBlockInBox(
              content.items,
              { width: unit.width, height: unit.height, transform: unit.transform },
              area,
              (first, second) => pdfjs.Util.transform(first, second),
            );
          })().catch((error: unknown) => {
            console.warn(
              `Page ${pageNumber} text layer unavailable (${
                error instanceof Error ? error.message : "unknown error"
              }).`,
            );

            return { lines: [], bounds: null };
          });

          blocks.set(key, job);
          return job;
        };

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

          async crop(box: PageBox, targetWidth = CROP_WIDTH): Promise<string> {
            const area = safeBox(box);
            if (area.width < 0.005 || area.height < 0.005) return rasterCrop(area);

            const key = [
              area.left.toFixed(4),
              area.top.toFixed(4),
              area.width.toFixed(4),
              area.height.toFixed(4),
              Math.round(targetWidth),
            ].join(":");
            const cached = crops.get(key);
            if (cached) return cached;

            const job = (async () => {
              // Render the region at the zoom that makes it `targetWidth` wide,
              // with a ceiling on both the zoom and the pixels it produces.
              const unit = page.getViewport({ scale: 1 });
              const regionWidth = Math.max(1, area.width * unit.width);
              let cropScale = Math.min(MAX_CROP_SCALE, Math.max(1, targetWidth / regionWidth));
              let viewport = page.getViewport({ scale: cropScale });
              let width = Math.max(1, Math.round(area.width * viewport.width));
              let height = Math.max(1, Math.round(area.height * viewport.height));
              const fit = Math.min(
                1,
                MAX_CROP_SIDE / Math.max(width, height),
                Math.sqrt(MAX_CROP_PIXELS / Math.max(1, width * height)),
              );

              if (fit < 1) {
                cropScale *= fit;
                viewport = page.getViewport({ scale: cropScale });
                width = Math.max(1, Math.round(area.width * viewport.width));
                height = Math.max(1, Math.round(area.height * viewport.height));
              }

              // The region is brought to the origin of its own canvas: the page
              // is still rendered as a whole, and the canvas cuts it down.
              const shifted = page.getViewport({
                scale: cropScale,
                offsetX: -area.left * viewport.width,
                offsetY: -area.top * viewport.height,
              });
              const target = canvas.createCanvas(width, height);
              const targetContext = target.getContext("2d") as RasterContext;

              targetContext.fillStyle = "#ffffff";
              targetContext.fillRect(0, 0, width, height);
              await page.render({
                canvas: null,
                canvasContext: targetContext as unknown as CanvasRenderingContext2D,
                viewport: shifted,
              }).promise;

              const jpeg = await target.encode("jpeg", CROP_QUALITY);
              return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
            })().catch(async (error: unknown) => {
              console.warn(
                `Page ${pageNumber} crop fell back to the page raster (${
                  error instanceof Error ? error.message : "unknown error"
                }).`,
              );

              return rasterCrop(area);
            });

            crops.set(key, job);
            return job;
          },

          async textsIn(box: PageBox): Promise<string[]> {
            return (await blockFor(safeBox(box))).lines;
          },

          async textBoundsIn(box: PageBox): Promise<PageBox | null> {
            return (await blockFor(safeBox(box))).bounds;
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
