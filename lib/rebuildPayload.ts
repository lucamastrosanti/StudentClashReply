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
      slides.push({
        index: slide.index,
        markdown: slide.markdown,
        figures: normalizeFigures(slide.figures),
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
