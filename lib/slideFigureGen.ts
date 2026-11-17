import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

import type { PlacedFigure } from "./slideLayout";
import { boxToRect, figureTexts } from "./slideFigures";
import type { ReviewIssue, SlideFigure, SlideRect, SlideReview } from "./slideFigures";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./slideTheme";

/**
 * Recreates the visual elements of a slide, the way a small studio would.
 *
 * Three roles, three calls: one model looks at the crop of the original slide
 * and writes down what is in it; the strongest model turns that description
 * into SVG; and when the drawing comes back, a third pair of eyes compares it
 * with the original and either accepts it or sends it back with the list of
 * what is wrong, which is how the drawing gets redone. At the end of the slide
 * the same kind of review looks at the finished page against the original, so
 * a problem that only shows up once the text sits next to the artwork is caught
 * too. Every judgement is fail-open: a call that fails, times out or answers
 * nonsense never loses a drawing that was already made.
 *
 * The answer is SVG, which rasterises at any size, so the artwork is drawn in
 * the area the layout reserved for it. Every answer is measured before it is
 * used: it is rasterised, its ink is cropped out of the canvas and fitted to
 * that area, and a drawing that came out empty is thrown away and asked again
 * instead of being pasted on the slide as an invisible or half-cut picture.
 */

type CanvasModule = typeof import("@napi-rs/canvas");
type RasterCanvas = import("@napi-rs/canvas").Canvas;
type RasterContext = import("@napi-rs/canvas").SKRSContext2D;
type RasterImage = import("@napi-rs/canvas").Image;
type ReasoningEffort = import("openai/resources/shared").ReasoningEffort;

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** Reads the crops, writes the briefs and judges the results. */
const VISION_MODEL = "deepseek-flash";
/** Writes the drawings: the strongest model available. */
const DRAW_MODEL = "deepseek-v4-pro";
const REQUEST_TIMEOUT_MS = 180_000;
/**
 * Reasoning is paid out of the same budget as the answer: with a small cap the
 * model spends every token thinking and returns an empty message, which is how
 * a figure used to end up as a blank panel. The cap has to leave room for both.
 */
const MAX_ANSWER_TOKENS = 16_000;
/** The brief is a page of plain text: it needs less room than the drawing. */
const MAX_BRIEF_TOKENS = 8_000;
/**
 * A verdict is a few lines of JSON, but the model reasons before it writes them
 * and both come out of the same budget: too small a cap truncates the answer in
 * the middle of the object, which loses a verdict that was already decided.
 */
const MAX_VERDICT_TOKENS = 12_000;
/**
 * A verdict is a short call and must never outlive the slide's slice: the
 * drawing is already on the canvas, so waiting for it is optional.
 */
const VERDICT_TIMEOUT_MS = 75_000;
/**
 * How hard each call is asked to think.
 *
 * Reading a crop and drawing at `low` is what keeps one figure inside a minute,
 * and a minute per round is what makes the repair loop affordable: the drawing
 * is only a first draft, and the fidelity comes from the verdicts that follow
 * it. The two judgements — a single drawing, and then the whole slide — are
 * where thinking pays: a wrong verdict costs a whole new drawing, and a verdict
 * that misses a problem leaves the problem on the slide.
 */
const BRIEF_EFFORT: ReasoningEffort = "low";
const DRAW_EFFORT: ReasoningEffort = "low";
const CRITIC_EFFORT: ReasoningEffort = "medium";
const REVIEW_EFFORT: ReasoningEffort = "medium";
/** A drawing the critic scores at least this much is accepted as it is. */
const ACCEPT_SCORE = 7;
/** The first drawing plus at most two repairs, each one judged again. */
const MAX_DRAW_ROUNDS = 3;
/** A verdict is one short answer: without this much room left, it is skipped. */
const CRITIC_RESERVE_MS = 30_000;
/** The finished slide is judged only when this much of the budget is left. */
const REVIEW_RESERVE_MS = 70_000;
/** Redrawing the figures the judge named needs about this much time. */
const REPAIR_RESERVE_MS = 60_000;
/**
 * A repair round is a drawing and the verdict on it: one started with less than
 * this left would be cut off before it could be judged, and lost.
 */
const ROUND_RESERVE_MS = 45_000;
/** Anything larger is a runaway answer, not a drawing. */
const MAX_SVG_CHARS = 120_000;
/**
 * A drawing is quoted back to the model when it is repaired. Beyond this the
 * prompt grows more than the repair is worth: the drawing is redone instead.
 */
const MAX_PREVIOUS_SVG_CHARS = 80_000;
/** Two calls at a time: enough to hide the latency, gentle on rate limits. */
const CONCURRENCY = 2;
/** Bounded cache: the same figure redrawn twice is the same picture. */
const CACHE_LIMIT = 120;
/** The drawing is rasterised at twice the size it is shown at: small type stays crisp. */
const RASTER_SCALE = 2;
/** A drawing whose ink covers less than this is a blank canvas, not a figure. */
const MIN_INK_SHARE = 0.002;
/** Room left around the ink when it is cropped out of the raster. */
const INK_PADDING = 2;
/**
 * The pair of calls costs about a minute; when the run has less time than this
 * left, the vision model draws straight from the crop instead.
 */
const SLOW_PATH_RESERVE_MS = 90_000;
/** Two asks of the vision model: enough to survive one empty or useless answer. */
const VISION_ATTEMPTS = 2;
/** Width the drawing is scaled to before it is shown to the critic. */
const PAIR_WIDTH = 720;

const SYSTEM_PROMPT = [
  "You are a technical illustrator.",
  "You redraw one visual element of a slide as self-contained SVG code that reproduces exactly what you are told.",
  "You never add a title, a frame, a caption, a shadow or anything that is not in the element you are given.",
].join(" ");

const BRIEF_SYSTEM_PROMPT = [
  "You are a technical illustrator.",
  "You look at one element of a slide and you write down what is in it, precisely enough for another illustrator to redraw it without ever seeing it.",
  "You describe shapes, positions, proportions, colours and texts; you never describe the rest of the slide.",
].join(" ");

/**
 * The judgement of one drawing.
 *
 * The critic sees two images in this order — the element on the original slide,
 * then the drawing — and answers the same small JSON object every time, so a
 * verdict can be acted on without another model in between.
 */
const CRITIC_SYSTEM_PROMPT = [
  "You are an exacting art director.",
  "You compare a redrawn element with the element it was copied from, and you say whether it can go on the slide.",
  "You are not polite and you are not creative: you look for what is missing, what is wrong, what was invented and what is unreadable, and you answer in JSON only.",
].join(" ");

/** The judgement of the finished slide, against the slide it came from. */
const REVIEW_SYSTEM_PROMPT = [
  "You are an exacting proofreader of rebuilt slides.",
  "You compare a rebuilt slide with the original slide it was rebuilt from and you say what is still wrong.",
  "The design is different on purpose — new template, new background, new typeface — so you never report that; you report missing, wrong, truncated, overlapping or invented content, and redrawn elements that do not look like the original.",
  "You answer in JSON only.",
].join(" ");

function quoted(values: string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/** The texts of a figure, with the document's own strings when they exist. */
function textsOf(figure: SlideFigure): string {
  const texts = figureTexts(figure);

  return texts.length > 0 ? quoted(texts) : "none";
}

/** How the texts are introduced: the document's are not a guess. */
function textsLabel(figure: SlideFigure): string {
  return figure.verbatim && figure.verbatim.length > 0
    ? "Texts printed inside it, verbatim from the document, in reading order"
    : "Texts printed inside it, in reading order";
}

function paletteOf(figure: SlideFigure, fallback: string): string {
  return figure.palette.length > 0 ? figure.palette.join(", ") : fallback;
}

function kindOf(figure: SlideFigure): string {
  return figure.kind.replace(/-/g, " ");
}

/**
 * What the illustrator is asked to look at and write down.
 *
 * The image carries the layout; the words have to carry it too, because the
 * model that draws never sees the picture.
 */
function buildBriefPrompt(
  figure: SlideFigure,
  title: string,
  width: number,
  height: number,
): string {
  const labels = textsOf(figure);

  return [
    `This is the crop of one visual element of a slide: ${kindOf(figure)}.`,
    title ? `The slide is titled ${JSON.stringify(title)}.` : "",
    `Someone will redraw this element from your words alone, as a picture ${width} px wide and ${height} px high, and will never see it.`,
    "",
    "Write down what that illustrator needs:",
    "- how much of its area the drawing uses, and where it sits inside it;",
    "- every shape, box, bar, line, arrow, symbol and icon, with its position and size as a percentage of the area;",
    "- the colour of each of them, as hex;",
    "- every text, exactly as printed, with its position, size, weight, alignment and colour;",
    "- what overlaps what, and which part is on top.",
    "",
    `What the slide analysis said about it: ${figure.description}`,
    `${textsLabel(figure)}: ${labels}`,
    ...(figure.verbatim && figure.verbatim.length > 0
      ? ["Those texts come from the document itself: write them exactly, do not re-read or correct them."]
      : []),
    `Dominant colours: ${paletteOf(figure, "as you see them")}`,
    "",
    "Answer in plain text, at most 400 words: no preamble, no conclusion, no comment on the slide.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The rules both models are held to when they write the drawing. */
function drawRules(width: number, height: number): string[] {
  return [
    "RULES",
    `- The drawing is ${width}×${height} px, on a transparent background.`,
    `- Answer with <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"> … </svg> and nothing else: no markdown fence, no comment, no explanation.`,
    "- The crop is the whole area, including the empty space around the element: keep the element where it is and at the size it has, and do not enlarge it to fill the canvas.",
    "- Nothing is cut: every shape and every text stays at least 8 px inside the canvas.",
    "- Draw in layers, in this order: the background of the element, then its shapes, then its texts.",
    "- Nothing covers a text: every label sits on a clean area and is not overlapped by a bar, a line or a picture.",
    "- Text sizes follow the original: a caption stays small, a title stays large, and every text keeps the space it needs.",
    "- Plain SVG 1.1 only: <g>, <defs>, <linearGradient>, <rect>, <path>, <line>, <polygon>, <polyline>, <circle>, <ellipse>, <text>.",
    "- No <script>, no <foreignObject>, no <image>, no CSS class, no @import, no external font.",
    '- Text: <text> elements with font-family="Arial" and a font-size large enough to read.',
    "- Keep every text exactly as printed: do not translate it, shorten it, correct it or drop it.",
    "- Reproduce numbering and bullets exactly as printed: keep line numbers, do not renumber, and keep blank lines blank.",
    "- Respect the layout of the element: what is above stays above, what is on the right stays on the right.",
  ];
}

/** What a reviewer said about a drawing that has to be redone. */
export interface FigureRepair {
  /** One short sentence per real problem, most important first. */
  problems: string[];
  /** What has to change, in the reviewer's words. */
  instructions: string;
  /**
   * The drawing the verdict was about, when it is small enough to quote back.
   *
   * A repair that sees the previous version edits it; a repair that does not
   * sees only the complaint and starts again from a fresh, unrelated guess.
   */
  previous?: string;
}

/**
 * The request to draw.
 *
 * With a brief, the model works from the words of the illustrator and the crop
 * is only there to check them; without one, it works from the crop alone.
 *
 * With a repair, the drawing has already been made and rejected: the verdict is
 * quoted back and the model starts again from scratch with it in front of it,
 * the same way a person would after a colleague marked up the first version.
 */
function buildDrawPrompt(
  figure: SlideFigure,
  title: string,
  width: number,
  height: number,
  brief: string | null,
  repair: FigureRepair | null = null,
): string {
  const labels = textsOf(figure);

  return [
    repair
      ? `Redraw one visual element of a slide — ${kindOf(figure)} — as a single SVG document, fixing what was wrong with your previous attempt.`
      : `Redraw one visual element of a slide — ${kindOf(figure)} — as a single SVG document.`,
    brief
      ? "The image is the crop of that element and the description below is what someone wrote after looking at it."
      : "The image is the crop of that element: reproduce it exactly.",
    title ? `The slide is titled ${JSON.stringify(title)}.` : "",
    "",
    ...(brief ? ["DESCRIPTION OF THE ELEMENT", "<<<", brief, ">>>", ""] : []),
    ...(repair
      ? [
          "REVIEW OF YOUR PREVIOUS DRAWING",
          "It was compared with the image and rejected.",
          ...repair.problems.map((problem) => `- ${problem}`),
          repair.instructions ? `What to change: ${repair.instructions}` : "",
          repair.previous
            ? "YOUR PREVIOUS SVG"
            : "Draw the element again from the beginning and fix every one of these; keep what was already right.",
          ...(repair.previous
            ? [
                "<<<",
                repair.previous,
                ">>>",
                "Return the complete corrected document. Keep every part that was right exactly as it is; change only what these problems require.",
              ]
            : []),
          "",
        ]
      : []),
    `${textsLabel(figure)}: ${labels}`,
    ...(figure.verbatim && figure.verbatim.length > 0
      ? [
          "Those strings are exact, taken from the document: use them as they are even if the description says otherwise.",
        ]
      : []),
    `Dominant colours: ${paletteOf(figure, "the colours you see")}`,
    "",
    ...drawRules(width, height),
    brief ? "" : "- Reproduce the element only: no slide title, no bullet list, no page furniture.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The request to judge one drawing.
 *
 * The two images are labelled in the text, in the order they are sent: the
 * model has to know which one is the original and which one is the copy, or it
 * compares the copy with itself and approves everything.
 */
function buildCritiquePrompt(
  figure: SlideFigure,
  width: number,
  height: number,
  round: number,
): string {
  const labels = textsOf(figure);

  return [
    `Two images follow. IMAGE 1 is ${kindOf(figure)} as it appears on the original slide. IMAGE 2 is the drawing sent to you for approval, which will fill ${width}×${height} px on the rebuilt slide.`,
    `Both images are ${PAIR_WIDTH} px wide and show the same area at the same scale: a difference in size or position between them is a real difference in the drawing, not a difference of framing. A hairline of margin around the drawing is not a problem.`,
    "Compare them as a reader of the slide would: same idea, same shapes, same texts, same proportions, same colours, same reading order.",
    "",
    "Look for, in this order:",
    "- texts that are missing, misspelled, translated, shortened or invented;",
    "- shapes, arrows, bars, icons or people that are missing, extra or in the wrong place;",
    "- proportions that do not match: what fills half of IMAGE 1 must fill half of IMAGE 2;",
    "- anything cut at the edge, overlapping a text, unreadable or drawn in the wrong colour;",
    "- the overall likeness: would someone comparing the two pictures say they show the same element?",
    "",
    `The element is ${kindOf(figure)}. What the slide analysis said about it: ${figure.description}`,
    `${textsLabel(figure)}: ${labels}`,
    `Dominant colours: ${paletteOf(figure, "as they appear in IMAGE 1")}`,
    round > 1
      ? "This is a repaired drawing: check that the previous problems are gone and that nothing new was broken."
      : "",
    "",
    "Answer with JSON only, no markdown fence, in exactly this shape:",
    '{"score": 0, "verdict": "ok", "problems": [], "instructions": ""}',
    "- score: 0-10, how close IMAGE 2 is to IMAGE 1 (10 = indistinguishable);",
    '- verdict: "ok" only if you would accept IMAGE 2 on the slide as it is, otherwise "fix";',
    "- problems: one short sentence per real problem, most important first; empty when there is none;",
    "- instructions: at most two sentences telling the illustrator what to change, addressed to them; empty when the verdict is ok.",
    "Judge only the element: the background of the slide, the title and the rest of the slide are not part of the comparison.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The request to judge the finished slide against the slide it came from. */
function buildReviewPrompt(figures: string[], title: string): string {
  return [
    "Two images follow. IMAGE 1 is a slide of the original document. IMAGE 2 is the same slide, rebuilt from a transcription of IMAGE 1.",
    "The rebuild uses another template, another background and another typeface: that is deliberate and is never a problem.",
    "",
    "Check that IMAGE 2 keeps the message of IMAGE 1:",
    "- every text that carries the message is there, complete, spelled the same and readable;",
    "- no text is cut, squeezed to a few pixels, overlapped by a picture, or repeated;",
    "- nothing was invented: no bullet, number, title or sentence that IMAGE 1 does not have;",
    ...(figures.length > 0
      ? [
          `- the ${figures.length === 1 ? "redrawn element looks" : "redrawn elements look"} like the original ${figures.length === 1 ? "one" : "ones"}: same content, same proportions, same texts inside.`,
          "The redrawn elements, in reading order, in case you have to name one:",
          ...figures.map((entry, position) => `${position + 1}. ${entry}`),
        ]
      : []),
    title ? `The slide is titled ${JSON.stringify(title)}.` : "",
    "",
    "Answer with JSON only, no markdown fence, in exactly this shape:",
    '{"ok": true, "score": 0, "issues": []}',
    "- ok: true only if IMAGE 2 could be handed to the audience without being fixed;",
    "- score: 0-10, how faithfully IMAGE 2 reproduces the content of IMAGE 1;",
    "- issues: one object per real problem, most important first; empty when there is none:",
    '  {"target": "figure", "figure": 1, "problem": "short sentence", "fix": "short instruction"}',
    '  target is "figure" for a redrawn element, "text" for the transcription, "layout" for anything else;',
    "  figure is the number of the redrawn element from the list above, and is left out for text and layout.",
    "Report at most four issues, and only real ones: a rebuild that is faithful but looks different is ok.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

const client = apiKey
  ? new OpenAI({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    })
  : null;

export function isFigureModelConfigured(): boolean {
  return client !== null;
}

export type FigureArtwork = Map<string, RasterCanvas>;

let canvasPromise: Promise<CanvasModule> | null = null;

function loadCanvas(): Promise<CanvasModule> {
  canvasPromise ??= import("@napi-rs/canvas").catch((error: unknown) => {
    throw new Error(
      `Figure rendering is unavailable: @napi-rs/canvas could not be loaded (${
        error instanceof Error ? error.message : "unknown error"
      }).`,
    );
  });

  return canvasPromise;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Where one element sits on the original slide, in design pixels.
 *
 * This is the whole point of the crop: `box` is a fraction of the slide, while
 * the layout's `rect` is the same element *after* it has been moved inside the
 * template's frame. Cropping the source with the placed rect cuts the element
 * off by the frame margin — and every drawing is then made from the wrong
 * picture, so no amount of review can save it.
 */
export function figureSourceRect(figure: SlideFigure): SlideRect {
  return boxToRect(figure.box, { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
}

/**
 * Cuts the picture of one element out of the slide raster.
 *
 * `rect` is the element on the original slide, not on the rebuilt one. The crop
 * is scaled up to a size the model can read: a figure that is a third of a
 * thumbnail would otherwise be a handful of blurry pixels.
 */
export async function cropToDataUrl(
  canvas: CanvasModule,
  source: RasterImage,
  rect: SlideRect,
): Promise<string> {
  const scaleX = source.width / SLIDE_WIDTH;
  const scaleY = source.height / SLIDE_HEIGHT;

  const sourceX = clamp(Math.round(rect.x * scaleX), 0, Math.max(0, source.width - 1));
  const sourceY = clamp(Math.round(rect.y * scaleY), 0, Math.max(0, source.height - 1));
  const sourceWidth = clamp(Math.round(rect.width * scaleX), 1, source.width - sourceX);
  const sourceHeight = clamp(Math.round(rect.height * scaleY), 1, source.height - sourceY);

  const width = clamp(Math.round(sourceWidth * 1.6), 360, 1200);
  const height = Math.max(120, Math.round((sourceHeight * width) / sourceWidth));

  const raster = canvas.createCanvas(width, height);
  const context = raster.getContext("2d") as RasterContext;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.drawImage(
    source,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );

  const jpeg = await raster.encode("jpeg", 84);

  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * Encodes a canvas for the vision model.
 *
 * The slide is judged from a downscaled copy: the model needs to read the page,
 * not every pixel, and a smaller picture is both faster and cheaper to send.
 */
async function toDataUrl(image: RasterCanvas, maxWidth: number): Promise<string> {
  const scale = Math.min(1, maxWidth / image.width);
  const canvas = await loadCanvas();

  const target =
    scale < 1
      ? canvas.createCanvas(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        )
      : image;

  if (target !== image) {
    const context = target.getContext("2d") as RasterContext;
    context.imageSmoothingEnabled = true;
    context.drawImage(image, 0, 0, target.width, target.height);
  }

  const jpeg = await target.encode("jpeg", 84);

  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * The picture the critic will see: exactly `width` px wide, whatever it was.
 *
 * The original and the drawing used to arrive at different sizes and with
 * different margins, so the critic spent its judgement on the framing and
 * reported proportions that were not wrong. Two copies of the same area, at the
 * same width, leave it only the drawing to judge.
 */
async function pairImage(
  canvas: CanvasModule,
  source: RasterCanvas | string,
  width: number,
): Promise<string | null> {
  const image =
    typeof source === "string" ? await canvas.loadImage(source).catch(() => null) : source;
  if (!image) return null;

  const height = Math.max(1, Math.round((image.height * width) / Math.max(1, image.width)));
  const target = canvas.createCanvas(width, height);
  const context = target.getContext("2d") as RasterContext;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.drawImage(image, 0, 0, width, height);

  const jpeg = await target.encode("jpeg", 86);
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** A string reduced to letters and digits, for comparing printed text. */
function textFingerprint(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The text a drawing contains, with markup and entities out of the way. */
function drawnText(svg: string): string {
  return textFingerprint(
    svg
      .replace(/<title[\s\S]*?<\/title>/gi, " ")
      .replace(/<desc[\s\S]*?<\/desc>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  );
}

/**
 * The strings of the document that never made it into the drawing.
 *
 * This is not the model's opinion: the strings come from the PDF's own text
 * layer and the drawing is searched as text, so a table cell that was silently
 * dropped is caught even when the critic is happy with the picture.
 */
function missingTexts(svg: string, texts: string[]): string[] {
  const haystack = drawnText(svg);
  if (!haystack) return texts.slice(0, 4);

  const missing: string[] = [];

  for (const text of texts) {
    // A line is checked word by word: a table row may legitimately be drawn one
    // column at a time, and requiring the whole row in reading order would
    // reject a drawing that has every cell.
    const words = text
      .split(/\s+/)
      .map(textFingerprint)
      .filter((word) => word.length >= 2);

    if (words.length > 0 && words.some((word) => !haystack.includes(word))) {
      missing.push(text);
    }

    if (missing.length >= 4) break;
  }

  return missing;
}

/**
 * The JSON object inside an answer, whatever the model wrapped it in.
 *
 * Verdicts are small and the instruction says "JSON only", but a fence, a
 * sentence before it or a trailing comma still happen: this reads what is there
 * instead of throwing a good verdict away.
 */
function extractJson(answer: string): Record<string, unknown> | null {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");

  if (start === -1 || end <= start) return null;

  const text = answer.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");

  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** A score the model wrote, clamped to 0-10 so one odd answer cannot win. */
function asScore(value: unknown): number {
  const score = typeof value === "number" ? value : Number.parseFloat(asText(value));

  return Number.isFinite(score) ? clamp(score, 0, 10) : 0;
}

function asTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    const single = asText(value);

    return single ? [single.slice(0, 400)] : [];
  }

  return value
    .map(asText)
    .filter((entry) => entry !== "")
    .slice(0, limit)
    .map((entry) => entry.slice(0, 400));
}

/** The answer cut down to its SVG document, or null when there is none. */
function extractSvg(answer: string): string | null {
  const fenced = /```[a-zA-Z]*\s*\n([\s\S]*?)\n?```/.exec(answer);
  const text = (fenced ? fenced[1] : answer).trim();
  const start = text.indexOf("<svg");
  const end = text.lastIndexOf("</svg>");

  if (start === -1 || end <= start) return null;

  const svg = text
    .slice(start, end + 6)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");

  return svg && svg.length <= MAX_SVG_CHARS ? svg : null;
}

/** A number an attribute of the root element carries, if it carries one. */
function attributeNumber(tag: string, attribute: string): number | null {
  const match = new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;

  const value = Number.parseFloat(match[2] ?? match[3] ?? "");

  return Number.isFinite(value) && value > 0 ? value : null;
}

function viewBoxOf(tag: string): [number, number, number, number] | null {
  const match = /viewBox\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
  if (!match) return null;

  const parts = (match[2] ?? match[3] ?? "").trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;

  const [x, y, width, height] = parts;

  return width > 0 && height > 0 ? [x, y, width, height] : null;
}

interface SvgFrame {
  /** The document, with the size it is about to be rasterised at. */
  markup: string;
  width: number;
  height: number;
}

/**
 * Puts the drawing on a canvas that can be rasterised at a readable size.
 *
 * The coordinate space the model drew in is kept: rewriting its viewBox to the
 * size of the box cut away everything it had put outside, which is how a figure
 * used to come out as a strip of stray lines in a corner. When the model wrote
 * no viewBox, the width and height of its root element say the same thing.
 */
function frameSvg(svg: string, width: number, height: number): SvgFrame | null {
  const opening = /<svg[^>]*>/i.exec(svg);
  if (!opening) return null;

  const box = viewBoxOf(opening[0]);
  const boxWidth = box ? box[2] : (attributeNumber(opening[0], "width") ?? width);
  const boxHeight = box ? box[3] : (attributeNumber(opening[0], "height") ?? height);
  const boxX = box ? box[0] : 0;
  const boxY = box ? box[1] : 0;

  // A little room around the drawing: labels often sit right on the edge. It
  // is deliberately small — the frame is fitted to the area reserved on the
  // slide, so every point added here shrinks the drawing inside that area.
  const viewWidth = boxWidth * 1.02;
  const viewHeight = boxHeight * 1.02;
  const viewX = boxX - boxWidth * 0.01;
  const viewY = boxY - boxHeight * 0.01;

  let rasterWidth = Math.round(clamp(width * RASTER_SCALE, 240, 1600));
  let rasterHeight = Math.round((rasterWidth * viewHeight) / viewWidth);

  if (rasterHeight > 1600) {
    rasterHeight = 1600;
    rasterWidth = Math.round((rasterHeight * viewWidth) / viewHeight);
  }

  const round = (value: number) => Math.round(value * 1000) / 1000;
  const root =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${rasterWidth}" height="${rasterHeight}"` +
    ` viewBox="${round(viewX)} ${round(viewY)} ${round(viewWidth)} ${round(viewHeight)}">`;

  return {
    markup: svg.replace(/<svg[^>]*>/i, root),
    width: Math.max(1, rasterWidth),
    height: Math.max(1, rasterHeight),
  };
}

interface InkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Transparent and white are paper, not drawing: the slide already has a background. */
function isInk(red: number, green: number, blue: number, alpha: number): boolean {
  if (alpha < 24) return false;

  return !(red > 244 && green > 244 && blue > 244);
}

/** The box the drawing really fills inside its raster. */
function inkBounds(context: RasterContext, width: number, height: number): InkBox | null {
  const { data } = context.getImageData(0, 0, width, height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (!isInk(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) continue;

      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0 || bottom < 0) return null;

  const x = Math.max(0, left - INK_PADDING);
  const y = Math.max(0, top - INK_PADDING);

  return {
    x,
    y,
    width: Math.min(width - x, right - left + 1 + INK_PADDING * 2),
    height: Math.min(height - y, bottom - top + 1 + INK_PADDING * 2),
  };
}

/**
 * Turns the answer into the picture that is drawn on the slide.
 *
 * The drawing is rasterised and its ink is measured, so an answer that came out
 * blank or microscopic is rejected here instead of being pasted on the slide as
 * an empty rectangle. The whole frame is then fitted to the area the layout
 * reserved: the model's composition — position, proportions, empty space — is
 * kept, whatever coordinate space it chose to draw in.
 */
async function rasterise(
  canvas: CanvasModule,
  figure: SlideFigure,
  svg: string,
  rect: SlideRect,
): Promise<RasterCanvas | null> {
  const frame = frameSvg(svg, rect.width, rect.height);
  if (!frame) return null;

  let image: RasterImage;

  try {
    image = await canvas.loadImage(Buffer.from(frame.markup, "utf8"));
  } catch (error) {
    console.warn(
      `Figure ${figure.id} produced an unreadable SVG:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const raster = canvas.createCanvas(frame.width, frame.height);
  const context = raster.getContext("2d") as RasterContext;
  context.drawImage(image, 0, 0, frame.width, frame.height);

  const ink = inkBounds(context, frame.width, frame.height);
  if (!ink) {
    console.warn(`Figure ${figure.id} was drawn empty: the SVG has no visible ink.`);
    return null;
  }

  const share = (ink.width * ink.height) / (frame.width * frame.height);
  if (share < MIN_INK_SHARE) {
    console.warn(`Figure ${figure.id} was drawn too small to be a figure (${Math.round(share * 1000) / 10}% ink).`);
    return null;
  }

  const scale = Math.min(RASTER_SCALE, 1400 / Math.max(rect.width, 1));
  const fitted = canvas.createCanvas(
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale)),
  );
  const fittedContext = fitted.getContext("2d") as RasterContext;
  fittedContext.imageSmoothingEnabled = true;

  // The whole frame is fitted, not the ink alone: an element that sits on the
  // left of its area with empty space on the right must stay there. Cutting
  // the ink out and centring it turned a table with a wide margin into a
  // full-width table, which is exactly what the critic then rejected.
  //
  // The fit preserves the drawing's own aspect ratio. The prompt asks for a
  // canvas of exactly the size it is given, and it normally gets one; when it
  // does not, a letterbox is honest and a stretch is not.
  const ratio = Math.min(fitted.width / raster.width, fitted.height / raster.height);
  const drawWidth = raster.width * ratio;
  const drawHeight = raster.height * ratio;

  fittedContext.drawImage(
    raster,
    (fitted.width - drawWidth) / 2,
    (fitted.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );

  return fitted;
}

interface AskOptions {
  model: string;
  system: string;
  parts: ChatCompletionContentPart[];
  maxTokens: number;
  /** How hard the model is asked to think before answering. */
  effort: ReasoningEffort;
  /** Bound on the call; the verdicts are short and must not outlive the budget. */
  timeoutMs?: number;
  /** Attempts after a failed call; a verdict is worth less than a drawing. */
  retries?: number;
  /** What the call is for, so the log says which figure gave up. */
  what: string;
}

/** One call to one of the two models; null when the answer is unusable. */
async function ask(options: AskOptions): Promise<string | null> {
  if (!client) return null;

  // A verdict is short and must not outlive the budget it was asked inside, so
  // it gets a tighter clock and no retries of its own.
  const limits = {
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.retries === undefined ? {} : { maxRetries: options.retries }),
  };

  try {
    const completion = await client.chat.completions.create(
      {
        model: options.model,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.parts },
        ],
        max_tokens: options.maxTokens,
        reasoning_effort: options.effort,
      },
      limits,
    );

    const choice = completion.choices[0];
    const message = choice?.message as
      | { content?: string | null; reasoning_content?: string }
      | undefined;
    const content = message?.content?.trim();

    if (!content) {
      console.warn(
        `${options.what}: ${options.model} returned nothing (finish reason: ${
          choice?.finish_reason ?? "unknown"
        }).`,
      );
      return null;
    }

    if (choice?.finish_reason === "length") {
      console.warn(
        `${options.what}: ${options.model} answer cut at ${options.maxTokens} tokens — it may be incomplete.`,
      );
    }

    return content;
  } catch (error) {
    console.warn(
      `${options.what}: ${options.model} failed — ${
        error instanceof Error ? error.message : "unknown error"
      }.`,
    );
    return null;
  }
}

/** What the illustrator saw, in words the drawing model can work from. */
async function readBrief(
  figure: SlideFigure,
  title: string,
  rect: SlideRect,
  crop: string,
): Promise<string | null> {
  const brief = await ask({
    model: VISION_MODEL,
    system: BRIEF_SYSTEM_PROMPT,
    maxTokens: MAX_BRIEF_TOKENS,
    effort: BRIEF_EFFORT,
    what: `Figure ${figure.id} brief`,
    parts: [
      {
        type: "text",
        text: buildBriefPrompt(figure, title, Math.round(rect.width), Math.round(rect.height)),
      },
      { type: "image_url", image_url: { url: crop } },
    ],
  });

  return brief ? brief.slice(0, 4_000) : null;
}

/** The drawing itself: SVG code, or null when the model wrote none. */
async function askDrawing(
  figure: SlideFigure,
  title: string,
  rect: SlideRect,
  brief: string | null,
  crop: string | null,
  repair: FigureRepair | null,
  what: string,
): Promise<string | null> {
  const parts: ChatCompletionContentPart[] = [
    {
      type: "text",
      text: buildDrawPrompt(
        figure,
        title,
        Math.round(rect.width),
        Math.round(rect.height),
        brief,
        repair,
      ),
    },
  ];

  // The crop goes with both requests: the old slide is the ground truth, and
  // the model is expected to look at it even when it has a brief.
  if (crop) parts.push({ type: "image_url", image_url: { url: crop } });

  const answer = await ask({
    model: brief ? DRAW_MODEL : VISION_MODEL,
    system: SYSTEM_PROMPT,
    parts,
    maxTokens: MAX_ANSWER_TOKENS,
    effort: brief ? DRAW_EFFORT : BRIEF_EFFORT,
    what,
  });

  return answer ? extractSvg(answer) : null;
}

/** What the art director said about one drawing. */
interface FigureVerdict {
  /** 0-10 likeness, where 10 is indistinguishable from the original. */
  score: number;
  problems: string[];
  instructions: string;
}

/**
 * Compares a drawing with the element it was copied from.
 *
 * The two pictures travel together, labelled in the text: the original first,
 * the drawing second. The critic is free to answer nonsense — the call is
 * wrapped so that anything but a usable verdict means "no verdict", and the
 * drawing is kept rather than thrown away on the strength of a failed call.
 */
async function critiqueFigure(
  canvas: CanvasModule,
  figure: SlideFigure,
  rect: SlideRect,
  crop: string,
  drawing: RasterCanvas,
  round: number,
): Promise<FigureVerdict | null> {
  const [origin, copy] = await Promise.all([
    pairImage(canvas, crop, PAIR_WIDTH),
    pairImage(canvas, drawing, PAIR_WIDTH),
  ]);

  // Without both pictures at the same size there is nothing to compare: the
  // drawing is kept and the review is skipped rather than made up.
  if (!origin || !copy) return null;

  const answer = await ask({
    model: VISION_MODEL,
    system: CRITIC_SYSTEM_PROMPT,
    maxTokens: MAX_VERDICT_TOKENS,
    effort: CRITIC_EFFORT,
    timeoutMs: VERDICT_TIMEOUT_MS,
    retries: 0,
    what: `Figure ${figure.id} review (round ${round})`,
    parts: [
      { type: "text", text: buildCritiquePrompt(figure, Math.round(rect.width), Math.round(rect.height), round) },
      { type: "text", text: "IMAGE 1 — the element on the original slide:" },
      { type: "image_url", image_url: { url: origin } },
      { type: "text", text: "IMAGE 2 — the drawing you are judging:" },
      { type: "image_url", image_url: { url: copy } },
    ],
  });

  if (!answer) return null;

  const verdict = extractJson(answer);
  const read = verdict
    ? {
        score: asScore(verdict.score),
        problems: asTextList(verdict.problems, 4),
        instructions: asText(verdict.instructions).slice(0, 500),
      }
    : looseVerdict(answer);

  if (!read) {
    console.warn(`Figure ${figure.id} review: no verdict in the answer (${answer.slice(0, 120)}).`);
    return null;
  }

  return read;
}

/**
 * The verdict read out of an answer that was cut off before its closing brace.
 *
 * The score is written before the problems, so a truncated answer still says
 * whether the drawing passed; without this a drawing the critic had already
 * rejected would be kept, because the call "failed".
 */
function looseVerdict(answer: string): FigureVerdict | null {
  const raw = /"score"\s*:\s*"?(-?\d+(?:\.\d+)?)/.exec(answer)?.[1];
  if (raw === undefined) return null;

  const tail = answer.slice(Math.max(0, answer.indexOf('"problems"')));

  return {
    score: asScore(raw),
    problems: [...tail.matchAll(/"((?:[^"\\]|\\.){6,300})"/g)]
      .map((match) => match[1].replace(/\\"/g, '"').trim())
      .filter((entry) => !/^(problems|instructions|score|verdict)$/i.test(entry))
      .slice(0, 4),
    instructions: (
      /"instructions"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(answer)?.[1] ?? ""
    ).slice(0, 500),
  };
}

/** The same, for the verdict on a whole slide. */
function looseReview(answer: string): { ok: boolean; score: number } | null {
  const rawOk = /"ok"\s*:\s*(true|false)/i.exec(answer)?.[1];
  const rawScore = /"score"\s*:\s*"?(-?\d+(?:\.\d+)?)/.exec(answer)?.[1];
  if (rawOk === undefined && rawScore === undefined) return null;

  const score = rawScore === undefined ? 0 : asScore(rawScore);

  return { ok: rawOk === undefined ? score >= ACCEPT_SCORE : rawOk.toLowerCase() === "true", score };
}

/**
 * One figure, drawn the way a small studio would draw it.
 *
 * The illustrator writes down what the crop contains, the draughtsman turns the
 * brief into SVG, the art director compares the drawing with the original, and
 * a drawing that does not pass is drawn again with the verdict in front of it.
 * The loop is bounded twice — by rounds and by the clock — and it keeps the
 * drawing that scored best, so a repair that comes out worse never replaces a
 * picture that was already acceptable.
 *
 * The last resort is the vision model on its own: same critique, but it draws
 * straight from the crop when there is no longer time for two models.
 */
async function recreate(
  canvas: CanvasModule,
  figure: SlideFigure,
  rect: SlideRect,
  crop: string | null,
  title: string,
  deadline: number,
  handed: FigureRepair | null,
): Promise<RasterCanvas | null> {
  const brief =
    crop && Date.now() + SLOW_PATH_RESERVE_MS < deadline
      ? await readBrief(figure, title, rect, crop)
      : null;

  // The document's own strings, when the figure has one: a drawing that drops
  // them is rejected even if the art director liked the picture.
  const expected = figure.verbatim && figure.verbatim.length > 0 ? figure.verbatim : [];
  let best: { picture: RasterCanvas; score: number; missing: number } | null = null;
  let repair = handed;
  const rounds = brief ? MAX_DRAW_ROUNDS : VISION_ATTEMPTS;
  let round = 0;

  while (round < rounds) {
    round += 1;
    // The first round always runs; the ones after it are repairs, and one that
    // cannot be drawn and judged before the deadline is worse than none.
    if (round > 1 && Date.now() + (brief ? ROUND_RESERVE_MS : 0) > deadline) break;

    // Once the pair no longer fits in the time left, the vision model draws on
    // its own: a rough figure on the slide is worth more than a missing one.
    const useBrief = brief && Date.now() + SLOW_PATH_RESERVE_MS < deadline ? brief : null;

    const svg = await askDrawing(
      figure,
      title,
      rect,
      useBrief,
      crop,
      repair,
      `Figure ${figure.id} drawing (round ${round})`,
    );
    if (!svg) continue;

    const missing = expected.length > 0 ? missingTexts(svg, expected) : [];
    if (missing.length > 0) {
      console.warn(
        `Figure ${figure.id} round ${round} dropped ${missing.length} text(s) from the document: ${missing.join(" | ")}.`,
      );
    }

    const picture = await rasterise(canvas, figure, svg, rect);
    if (!picture) continue;

    // Without the crop there is nothing to compare against, and without time
    // for a verdict the drawing is simply taken.
    if (!crop || Date.now() + CRITIC_RESERVE_MS >= deadline) return picture;

    const verdict = await critiqueFigure(canvas, figure, rect, crop, picture, round);
    if (!verdict) return picture;

    // A drawing that keeps the document's texts is always preferred over one
    // that scores a little higher but silently lost a cell.
    const candidate = { picture, score: verdict.score, missing: missing.length };
    if (
      !best ||
      candidate.missing < best.missing ||
      (candidate.missing === best.missing && candidate.score > best.score)
    ) {
      best = candidate;
    }

    if (verdict.score >= ACCEPT_SCORE && verdict.problems.length === 0 && missing.length === 0) {
      return picture;
    }

    console.warn(
      `Figure ${figure.id} round ${round} sent back (${verdict.score}/10): ${
        verdict.problems.join(" ") || (missing.length > 0 ? "texts missing" : "no detail")
      }`,
    );

    const problems = [
      ...verdict.problems,
      ...(missing.length > 0
        ? [
            `The drawing is missing these texts from the document: ${missing
              .map((text) => JSON.stringify(text))
              .join(", ")}.`,
          ]
        : []),
    ].slice(0, 4);

    repair = {
      problems:
        problems.length > 0 ? problems : ["The drawing does not match the original closely enough."],
      instructions: verdict.instructions,
      // The verdict was about this document: quoting it back turns the next
      // round into a correction instead of a fresh guess.
      ...(svg.length <= MAX_PREVIOUS_SVG_CHARS ? { previous: svg } : {}),
    };
  }

  return best?.picture ?? null;
}

/** What the reviewer needs to judge a rebuilt slide. */
export interface SlideReviewInput {
  /** Picture of the original slide, the one the figures were cropped from. */
  origin: string;
  /** The rebuilt slide, at the design size. */
  composed: RasterCanvas;
  /** The figures placed on it, in reading order. */
  placed: PlacedFigure[];
  /** Title of the slide, as it was printed on the rebuild. */
  title: string;
  /** Epoch ms after which the review is not worth starting. */
  deadline?: number;
}

/** The redrawn elements, listed for the reviewer in the order it will see them. */
function figureCatalogue(placed: PlacedFigure[]): string[] {
  return placed.map(({ figure }) => {
    const description = figure.description.replace(/\s+/g, " ").trim();

    return `${figure.position} · ${kindOf(figure)}: ${description.slice(0, 140)}`;
  });
}

/**
 * Judges the finished slide against the slide it was rebuilt from.
 *
 * This is the check no single figure can make: how the artwork and the
 * transcription sit together, whether the text is all there and readable,
 * whether something was invented. Returns null when there is no reviewer, no
 * original picture or no time left — the caller then reports the slide as it is.
 */
export async function reviewSlide(input: SlideReviewInput): Promise<SlideReview | null> {
  if (!client) return null;
  if (Date.now() + REVIEW_RESERVE_MS >= (input.deadline ?? Date.now() + DEFAULT_BUDGET_MS)) {
    return null;
  }

  const catalogue = figureCatalogue(input.placed);
  const answer = await ask({
    model: VISION_MODEL,
    system: REVIEW_SYSTEM_PROMPT,
    maxTokens: MAX_VERDICT_TOKENS,
    effort: REVIEW_EFFORT,
    timeoutMs: VERDICT_TIMEOUT_MS,
    retries: 0,
    what: `Slide review (${input.title || "untitled"})`,
    parts: [
      { type: "text", text: buildReviewPrompt(catalogue, input.title) },
      { type: "text", text: "IMAGE 1 — the original slide:" },
      { type: "image_url", image_url: { url: input.origin } },
      { type: "text", text: "IMAGE 2 — the rebuilt slide:" },
      { type: "image_url", image_url: { url: await toDataUrl(input.composed, 1400) } },
    ],
  });

  if (!answer) return null;

  const verdict = extractJson(answer);
  if (!verdict) {
    const loose = looseReview(answer);

    if (!loose) {
      console.warn(`Slide review: no verdict in the answer (${answer.slice(0, 120)}).`);
      return null;
    }

    return { ...loose, issues: [], repaired: 0 };
  }

  return {
    ok: verdict.ok === true,
    score: asScore(verdict.score),
    issues: parseIssues(verdict.issues, input.placed),
    repaired: 0,
  };
}

/** The issues of a verdict, with the figure numbers turned into figure ids. */
function parseIssues(value: unknown, placed: PlacedFigure[]): ReviewIssue[] {
  if (!Array.isArray(value)) return [];

  const issues: ReviewIssue[] = [];

  for (const entry of value.slice(0, 4)) {
    if (typeof entry !== "object" || entry === null) continue;

    const issue = entry as Record<string, unknown>;
    const problem = asText(issue.problem);
    if (!problem) continue;

    const rawTarget = asText(issue.target).toLowerCase();
    const target =
      rawTarget === "figure" || rawTarget === "text" || rawTarget === "layout"
        ? rawTarget
        : "layout";
    const index = Math.round(asScore(issue.figure)) - 1;
    const figure =
      target === "figure" && index >= 0 && index < placed.length
        ? placed[index].figure.id
        : undefined;

    issues.push({
      target,
      ...(figure ? { figure } : {}),
      problem: problem.slice(0, 300),
      fix: asText(issue.fix).slice(0, 300),
    });
  }

  return issues;
}

/**
 * The figures a review asked to redraw, as the repairs the drafter understands.
 *
 * Only an issue that names a figure can become a repair: the transcription is
 * not rewritten here, so a problem with the text is reported instead of fixed.
 */
export function figureRepairs(review: SlideReview): Map<string, FigureRepair> {
  const repairs = new Map<string, FigureRepair>();

  for (const issue of review.issues) {
    if (issue.target !== "figure" || !issue.figure) continue;

    const previous = repairs.get(issue.figure);

    repairs.set(issue.figure, {
      problems: [...(previous?.problems ?? []), issue.problem].slice(0, 3),
      instructions: [previous?.instructions, issue.fix].filter(Boolean).join(" ").slice(0, 500),
    });
  }

  return repairs;
}

/**
 * How long the whole slide may spend on its figures when the caller set no
 * deadline of its own: the routes that draw slides are cut off at 300 s.
 */
const DEFAULT_BUDGET_MS = 240_000;

/**
 * The deadline one slide may use, out of a budget shared by the whole deck.
 *
 * Each slide gets a fair slice of what is left, so a deck of twelve cannot
 * spend the whole budget on its first figures and leave the rest as panels; a
 * slide that finishes early hands its unused time to the ones after it.
 */
export function slideDeadline(budgetEndsAt: number, slidesLeft: number): number {
  const now = Date.now();
  const left = Math.max(0, budgetEndsAt - now);

  return Math.min(budgetEndsAt, now + left / Math.max(1, slidesLeft));
}

/**
 * Whether there is still time to redraw the figures a review sent back.
 *
 * Asked before a second paint of the same slide: a repair loop that starts with
 * a minute left would run into the timeout of the request, and a slide on time
 * is worth more than a better picture of it that never arrives.
 */
export function canRepairFigures(deadline?: number): boolean {
  return Date.now() + REPAIR_RESERVE_MS < (deadline ?? Date.now() + DEFAULT_BUDGET_MS);
}

const cache = new Map<string, Promise<RasterCanvas | null>>();

/**
 * Identity of a drawing.
 *
 * A repair is part of the identity: a figure redrawn from a verdict is a
 * different picture from the one it replaces, and must not be served from the
 * cache of the drawing that was rejected.
 */
function fingerprint(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function cacheKey(
  figure: SlideFigure,
  rect: SlideRect,
  repair: FigureRepair | null,
  crop: string | null,
): string {
  return [
    figure.id,
    // A length is not an identity: two elements of two documents can easily
    // share it, and then one is served the other's drawing.
    fingerprint(`${figure.description}\n${figureTexts(figure).join("\n")}`),
    Math.round(figure.box.left * 1000),
    Math.round(figure.box.top * 1000),
    Math.round(figure.box.width * 1000),
    Math.round(figure.box.height * 1000),
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
    fingerprint(crop ?? ""),
    repair
      ? `r:${repair.problems.join("|").slice(0, 120)}:${repair.instructions.slice(0, 120)}:${
          repair.previous ? fingerprint(repair.previous) : ""
        }`
      : "",
  ].join(":");
}

/** Keeps the cache bounded, dropping the oldest drawing first. */
function remember(key: string, job: Promise<RasterCanvas | null>): Promise<RasterCanvas | null> {
  cache.set(key, job);

  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return job;
}

export interface FigureArtworkOptions {
  /** Title of the slide: context for the models, never drawn. */
  title?: string;
  /** Epoch ms after which no new slow drawing is started. */
  deadline?: number;
  /**
   * Figures the review of the slide sent back, with what has to change. Each
   * one is drawn again from the verdict instead of being served from the cache.
   */
  repairs?: Map<string, FigureRepair>;
  /**
   * High-resolution picture of each figure, keyed by figure id, rendered from
   * the document during the analysis. Without one, the figure is cut out of the
   * slide thumbnail, where a table is a handful of unreadable pixels.
   */
  crops?: Record<string, string>;
}

/**
 * The original element, used when the model could not draw it.
 *
 * It is not a redrawing, but it is the truth: the crop comes from the document
 * itself, and a readable piece of the source slide is worth more than the empty
 * panel a failed drawing would leave.
 */
export async function cropPicture(
  canvas: CanvasModule,
  crop: string,
  rect: SlideRect,
): Promise<RasterCanvas | null> {
  try {
    const base64 = crop.replace(/^data:[^,]*,/, "");
    const image = await canvas.loadImage(Buffer.from(base64, "base64"));
    const scale = Math.min(RASTER_SCALE, 1400 / Math.max(rect.width, 1));
    const raster = canvas.createCanvas(
      Math.max(1, Math.round(rect.width * scale)),
      Math.max(1, Math.round(rect.height * scale)),
    );
    const context = raster.getContext("2d") as RasterContext;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, raster.width, raster.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(image, 0, 0, raster.width, raster.height);

    return raster;
  } catch (error) {
    console.warn(
      `Crop fallback failed (${error instanceof Error ? error.message : "unknown error"}).`,
    );
    return null;
  }
}

/**
 * Draws every figure of one slide and returns the pictures that made it.
 *
 * Figures are drawn a few at a time, because the models are the slow part of a
 * rebuild and the slides are painted one after the other. A figure whose
 * drawing failed falls back to its own crop, so the element is on the slide
 * whatever the models answered.
 */
export async function figureArtwork(
  placed: PlacedFigure[],
  source?: string,
  options: FigureArtworkOptions = {},
): Promise<FigureArtwork> {
  const artwork: FigureArtwork = new Map();
  if (placed.length === 0 || !client) return artwork;

  const canvas = await loadCanvas();
  const painter = source ? await canvas.loadImage(source).catch(() => null) : null;
  const title = options.title?.trim() ?? "";
  const deadline = options.deadline ?? Date.now() + DEFAULT_BUDGET_MS;

  for (let start = 0; start < placed.length; start += CONCURRENCY) {
    const batch = placed.slice(start, start + CONCURRENCY);

    const drawn = await Promise.all(
      batch.map(async ({ figure, rect }) => {
        const repair = options.repairs?.get(figure.id) ?? null;
        // The element on the original slide, not the placed rect: `rect` lives
        // inside the template's frame and would crop the picture off by its
        // margins.
        const sourceRect = figureSourceRect(figure);
        const crop =
          options.crops?.[figure.id] ??
          (painter ? await cropToDataUrl(canvas, painter, sourceRect) : null);
        const key = cacheKey(figure, rect, repair, crop);
        const cached = cache.get(key);
        let picture: RasterCanvas | null;

        if (cached) {
          picture = await cached;
        } else {
          // Anything that goes wrong while drawing is a missing drawing, not a
          // failed rebuild: the figure falls back to its crop like the others.
          const job = recreate(canvas, figure, rect, crop, title, deadline, repair).catch(
            (error: unknown) => {
              console.warn(
                `Figure ${figure.id} could not be drawn (${
                  error instanceof Error ? error.message : "unknown error"
                }); falling back to its crop.`,
              );

              return null;
            },
          );

          remember(key, job);
          picture = await job;
        }

        return {
          id: figure.id,
          // A drawing that never arrived would leave the element empty: the
          // crop is the document's own picture and it is always there.
          picture: picture ?? (crop ? await cropPicture(canvas, crop, rect) : null),
        };
      }),
    );

    for (const { id, picture } of drawn) {
      if (picture) artwork.set(id, picture);
    }
  }

  return artwork;
}
