import { normalizeFigures } from "@/lib/slideFigures";
import { hasSlideContent } from "@/lib/slideMarkdown";
import type { RebuildSlideInput } from "@/lib/types";

/**
 * The rebuild endpoints take the transcriptions the browser already holds, not
 * the uploaded file: analysing and rebuilding are two separate steps, and this
 * one needs nothing but text — plus, for each slide, the figures to redraw and
 * a picture of the original slide to redraw them from.
 */

export const MAX_REBUILD_SLIDES = 60;
const MAX_MARKDOWN_CHARS = 200_000;
/** A slide thumbnail at rail size: well under this. */
const MAX_SOURCE_CHARS = 1_600_000;
/** One figure rendered at 1200 px is a few hundred kilobytes at most. */
const MAX_CROP_CHARS = 1_600_000;
/** Bound on what one slide's figures may add to the request. */
const MAX_CROPS_CHARS = 3_000_000;

const DATA_URL = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/;

export interface RebuildPayload {
  fileName: string;
  /** Transcribed slides, sorted by page number. */
  slides: RebuildSlideInput[];
  /** Pages whose transcription carries no usable content. */
  skipped: number[];
}

export type RebuildParse =
  | { ok: true; payload: RebuildPayload }
  | { ok: false; error: string };

export function parseRebuildPayload(value: unknown): RebuildParse {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "The request body must be a JSON object." };
  }

  const body = value as { fileName?: unknown; slides?: unknown };

  if (!Array.isArray(body.slides)) {
    return { ok: false, error: "No slides were provided." };
  }
  if (body.slides.length === 0) {
    return { ok: false, error: "No slides were provided." };
  }
  if (body.slides.length > MAX_REBUILD_SLIDES) {
    return {
      ok: false,
      error: `Too many slides in one request: the maximum is ${MAX_REBUILD_SLIDES}.`,
    };
  }

  const seen = new Set<number>();
  const slides: RebuildSlideInput[] = [];
  const skipped: number[] = [];

  for (const entry of body.slides) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "Every slide must be an object with index and markdown." };
    }

    const slide = entry as {
      index?: unknown;
      markdown?: unknown;
      figures?: unknown;
      figureCrops?: unknown;
      source?: unknown;
    };
    if (
      typeof slide.index !== "number" ||
      !Number.isInteger(slide.index) ||
      slide.index < 1 ||
      slide.index > 9_999
    ) {
      return { ok: false, error: "A slide has an invalid page number." };
    }
    if (typeof slide.markdown !== "string") {
      return { ok: false, error: "A slide has no Markdown transcription." };
    }
    if (slide.markdown.length > MAX_MARKDOWN_CHARS) {
      return { ok: false, error: `Slide ${slide.index} is too long to rebuild.` };
    }
    if (seen.has(slide.index)) continue;
    seen.add(slide.index);

    if (hasSlideContent(slide.markdown)) {
      const figures = normalizeFigures(slide.figures);

      slides.push({
        index: slide.index,
        markdown: slide.markdown,
        figures,
        figureCrops: readCrops(slide.figureCrops, figures.map((figure) => figure.id)),
        source: readSource(slide.source),
      });
    } else {
      skipped.push(slide.index);
    }
  }

  if (slides.length === 0) {
    return {
      ok: false,
      error: "None of these slides has a transcription, so there is nothing to rebuild.",
    };
  }

  slides.sort((left, right) => left.index - right.index);
  skipped.sort((left, right) => left - right);

  const fileName =
    typeof body.fileName === "string" && body.fileName.trim().length > 0
      ? body.fileName.trim().slice(0, 200)
      : "slides";

  return { ok: true, payload: { fileName, slides, skipped } };
}

/**
 * Reference picture of the original slide.
 *
 * Anything that is not a small base64 image is dropped rather than trusted: it
 * is decoded by the canvas and cropped, so its shape matters.
 */
function readSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_SOURCE_CHARS) return undefined;

  return DATA_URL.test(value.trim()) ? value.trim() : undefined;
}

/**
 * The pictures of the single figures, keyed by figure id.
 *
 * Only the ids that survived `normalizeFigures` are kept: a crop whose figure
 * is gone is a picture of something that will not be drawn. The budget is per
 * slide, so one enormous figure cannot push every other slide out of the
 * request.
 */
function readCrops(value: unknown, figureIds: string[]): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const allowed = new Set(figureIds);
  const crops: Record<string, string> = {};
  let total = 0;

  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(id)) continue;
    if (typeof raw !== "string") continue;

    const crop = raw.trim();
    if (crop.length > MAX_CROP_CHARS || !DATA_URL.test(crop)) continue;
    if (total + crop.length > MAX_CROPS_CHARS) break;

    crops[id] = crop;
    total += crop.length;
  }

  return Object.keys(crops).length > 0 ? crops : undefined;
}

/** `report.pptx` → `report-rebuilt.pdf`; ASCII only, header-safe. */
export function rebuiltFileName(fileName: string, slides: RebuildSlideInput[]): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\-. ]+/g, "")
    .trim()
    .slice(0, 80) || "slides";

  const suffix =
    slides.length === 1 ? `slide-${slides[0].index}` : `${slides.length}-slides`;

  return `${base.replace(/\s+/g, "-")}-rebuilt-${suffix}.pdf`;
}
