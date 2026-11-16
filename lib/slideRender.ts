import type { SlideModel } from "./slideMarkdown";
import { parseSlideMarkdown } from "./slideMarkdown";
import type { FigureRepair } from "./slideFigureGen";
import { canRepairFigures, figureArtwork, figureRepairs, reviewSlide } from "./slideFigureGen";
import type { SlideFigure, SlideReview } from "./slideFigures";
import type { PlacedFigure } from "./slideLayout";
import { drawLayout, placeFigures, planSlide, TIGHT_FIGURE_BUDGET } from "./slideLayout";
import {
  drawSlideBackground,
  resolveFonts,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
} from "./slideTheme";

/**
 * Draws one transcribed slide on the template and returns a JPEG.
 *
 * Rendering always happens at the design size; smaller exports are produced by
 * downscaling, so the preview and the PDF are the very same picture.
 *
 * When the slide had visual elements, each one is redrawn by the vision model
 * from the crop of the original slide and placed back where it was. The
 * finished slide is then judged against the original: when the judge names a
 * figure, that figure is drawn once more from the verdict and the slide is
 * painted again, so what comes out is the version that was actually approved.
 */

type CanvasModule = typeof import("@napi-rs/canvas");
type RasterCanvas = import("@napi-rs/canvas").Canvas;
type RasterContext = import("@napi-rs/canvas").SKRSContext2D;

let canvasPromise: Promise<CanvasModule> | null = null;

function loadCanvas(): Promise<CanvasModule> {
  canvasPromise ??= import("@napi-rs/canvas").catch((error: unknown) => {
    throw new Error(
      `Slide rendering is unavailable: @napi-rs/canvas could not be loaded (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    );
  });

  return canvasPromise;
}

export interface RenderedSlide {
  jpeg: Buffer;
  width: number;
  height: number;
  /** Content blocks laid out on the slide. */
  blocks: number;
  /** Figures redrawn from the original slide and placed on it. */
  figures: number;
  /** True when even the smallest type did not make the content fit. */
  clipped: boolean;
  /** The judge's verdict on the finished slide, when it had the time to judge. */
  review?: SlideReview;
}

export interface RenderOptions {
  /** 1-based slide number, used when the transcription has no title. */
  index: number;
  /** Export width in pixels; the design width is the default. */
  width?: number;
  /** JPEG quality, 0-100. */
  quality?: number;
  /** Visual elements of the original slide, with the area each one occupied. */
  figures?: SlideFigure[];
  /** Picture of the original slide, the reference the figures are redrawn from. */
  source?: string;
  /** Figures the judge sent back, with what has to change. */
  repairs?: Map<string, FigureRepair>;
  /**
   * Epoch ms after which no new figure is started. A whole deck is one request,
   * and the slowest part of it is redrawing the figures.
   */
  deadline?: number;
}

/** Paints the template, the figures and the content; returns the full-size raster. */
export async function paintSlide(
  markdown: string,
  options: Pick<RenderOptions, "index" | "figures" | "source" | "deadline" | "repairs">,
): Promise<{
  raster: RasterCanvas;
  model: SlideModel;
  figures: number;
  clipped: boolean;
  /** The figures as they were placed, in reading order. */
  placed: PlacedFigure[];
  /** Title of the slide, as it was printed on the rebuild. */
  title: string;
}> {
  const canvas = await loadCanvas();
  resolveFonts(canvas);

  const raster = canvas.createCanvas(SLIDE_WIDTH, SLIDE_HEIGHT);
  const context = raster.getContext("2d") as RasterContext;

  drawSlideBackground(context);

  const model = parseSlideMarkdown(markdown);
  const requested = options.figures ?? [];
  const placed = placeFigures(requested);
  const title = model.title
    .map((run) => run.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  // The figures are redrawn first: the text is planned around the area they
  // keep, so a picture on the left pushes the transcription to the right.
  const artwork = await figureArtwork(placed, options.source, {
    title,
    deadline: options.deadline,
    repairs: options.repairs,
  });
  const withArtwork = (entries: typeof placed) =>
    entries.map((entry) => ({ ...entry, image: artwork.get(entry.figure.id) }));

  let figures = withArtwork(placed);

  let layout = planSlide(context, model, `Slide ${options.index}`, figures);

  // Dense text wins over big pictures: the figures stay where they were but
  // take less room, so the transcription keeps every line instead of being cut.
  if (layout.clipped && figures.length > 0) {
    const tighter = withArtwork(placeFigures(requested, TIGHT_FIGURE_BUDGET));
    const retry = planSlide(context, model, `Slide ${options.index}`, tighter);

    if (!retry.clipped) {
      figures = tighter;
      layout = retry;
    }
  }

  drawLayout(context, layout);

  return {
    raster,
    model,
    figures: artwork.size,
    clipped: layout.clipped,
    placed,
    title,
  };
}

/** Renders one slide to a JPEG, optionally downscaled. */
export async function renderSlide(
  markdown: string,
  options: RenderOptions,
): Promise<RenderedSlide> {
  const canvas = await loadCanvas();
  const width = options.width ?? SLIDE_WIDTH;
  const quality = options.quality ?? 86;

  let painted = await paintSlide(markdown, options);
  let review: SlideReview | null = null;

  // A figure that survived its own review can still sit badly next to the text,
  // and the transcription itself can come out cut or doubled. The judge looks at
  // the finished page against the original; when it names figures, those are
  // drawn once more from what it said and the page is painted again.
  if (options.source && painted.figures > 0) {
    review = await reviewSlide({
      origin: options.source,
      composed: painted.raster,
      placed: painted.placed,
      title: painted.title,
      deadline: options.deadline,
    });

    const repairs = review && !review.ok ? figureRepairs(review) : new Map<string, FigureRepair>();

    if (review && repairs.size > 0 && canRepairFigures(options.deadline)) {
      const again = await paintSlide(markdown, { ...options, repairs });

      // A repair that loses artwork is not an improvement: the page is kept only
      // when it comes back with at least the pictures the first one had.
      if (again.figures >= painted.figures) {
        painted = again;

        const confirmed = await reviewSlide({
          origin: options.source,
          composed: painted.raster,
          placed: painted.placed,
          title: painted.title,
          deadline: options.deadline,
        });

        if (confirmed) review = { ...confirmed, repaired: repairs.size };
        else review = { ...review, repaired: repairs.size };
      }
    }
  }

  let encoded = painted.raster;

  if (width !== encoded.width) {
    const scaled = canvas.createCanvas(width, Math.round((encoded.height * width) / encoded.width));
    const context = scaled.getContext("2d") as RasterContext;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, scaled.width, scaled.height);
    context.drawImage(encoded, 0, 0, scaled.width, scaled.height);
    encoded = scaled;
  }

  return {
    jpeg: await encoded.encode("jpeg", quality),
    width: encoded.width,
    height: encoded.height,
    blocks: painted.model.blocks,
    figures: painted.figures,
    clipped: painted.clipped,
    ...(review ? { review } : {}),
  };
}
