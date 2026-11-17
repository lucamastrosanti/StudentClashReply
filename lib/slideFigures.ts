/**
 * Figures as data, not as prose.
 *
 * The vision model does not write a paragraph about the pictures of a slide any
 * more: it reports every visual element with the area it occupies, so the
 * rebuild step can recreate that element from the original picture and place it
 * back exactly where it was. This module is pure (no Node.js imports) because
 * both the server and the browser validate the same objects.
 */

/** A rectangle in fractions of the slide: 0 is the left/top edge, 1 the right/bottom. */
export interface FigureBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One visual element of the source slide (diagram, chart, screenshot, picture, …). */
export interface SlideFigure {
  /** Stable identifier, unique inside the slide. */
  id: string;
  /** Canonical area of the slide, e.g. `middle-left`. */
  position: string;
  /** diagram, chart, screenshot, picture, table, other. */
  kind: string;
  /** Where the element sits, as fractions of the slide. */
  box: FigureBox;
  /** What the element shows, in enough detail to draw it again. */
  description: string;
  /** Texts printed inside the element, in reading order. */
  labels: string[];
  /**
   * The same texts read from the document's own text layer, when it had one.
   *
   * `labels` is a model's transcription of what it saw; this is the document
   * speaking. It is used instead of `labels` for everything that is redrawn or
   * checked, so a table cell is never guessed.
   */
  verbatim?: string[];
  /** Dominant colours the element uses, as `#rrggbb`. */
  palette: string[];
}

/** The texts that must appear in a redrawing: the document's, when known. */
export function figureTexts(figure: SlideFigure): string[] {
  return figure.verbatim && figure.verbatim.length > 0 ? figure.verbatim : figure.labels;
}

/* -------------------------------------------------------------------------- */
/* Review                                                                     */
/* -------------------------------------------------------------------------- */

/** What a review of a rebuilt slide can be about. */
export type ReviewTarget = "figure" | "text" | "layout";

/** One problem the review of a rebuilt slide found. */
export interface ReviewIssue {
  target: ReviewTarget;
  /** Id of the redrawn element the issue is about, when it is about one. */
  figure?: string;
  problem: string;
  /** What should change, in the reviewer's words. */
  fix: string;
}

/** The verdict of the model that compares a rebuilt slide with the original. */
export interface SlideReview {
  /** True when the rebuilt slide could be shown as it is. */
  ok: boolean;
  /** 0-10: how faithfully the content of the original was reproduced. */
  score: number;
  /** Most important first; at most four. */
  issues: ReviewIssue[];
  /** How many figures were redrawn because of this review. */
  repaired: number;
}

/** A rectangle in pixels. */
export interface SlideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** At most this many visual elements are recreated per slide. */
export const MAX_FIGURES = 6;

/**
 * Room kept around a reported box, as a fraction of the box itself.
 *
 * The analysis gives the area of an element from looking at the slide, and it
 * is a little tight: the left edge of a table or the title bar of a panel can
 * fall just outside it. The box is widened before anything is cropped, so the
 * picture sent to the model, the area reserved on the rebuilt slide and the
 * picture the critic compares all show the same thing.
 */
export const FIGURE_BOX_MARGIN = 0.03;

/** The same box, with `margin` of its own size added on every side. */
export function expandBox(box: FigureBox, margin: number = FIGURE_BOX_MARGIN): FigureBox {
  const padX = box.width * margin;
  const padY = box.height * margin;
  const left = Math.max(0, box.left - padX);
  const top = Math.max(0, box.top - padY);
  const right = Math.min(1, box.left + box.width + padX);
  const bottom = Math.min(1, box.top + box.height + padY);

  return { left, top, width: right - left, height: bottom - top };
}

/** The same box, with `margin` of the whole slide added on every side. */
export function inflateBox(box: FigureBox, margin: number): FigureBox {
  const left = Math.max(0, box.left - margin);
  const top = Math.max(0, box.top - margin);

  return {
    left,
    top,
    width: Math.min(1, box.left + box.width + margin) - left,
    height: Math.min(1, box.top + box.height + margin) - top,
  };
}

/** The smallest box that contains both. */
export function unionBoxes(first: FigureBox, second: FigureBox): FigureBox {
  const left = Math.min(first.left, second.left);
  const top = Math.min(first.top, second.top);
  const right = Math.max(first.left + first.width, second.left + second.width);
  const bottom = Math.max(first.top + first.height, second.top + second.height);

  return { left, top, width: right - left, height: bottom - top };
}

/** A box smaller than this is not a figure: it is noise in the model answer. */
const MIN_BOX_SIDE = 0.06;

/** Used when the model named a position but gave no usable coordinates. */
const BOX_BY_POSITION: Record<string, FigureBox> = {
  "top-left": { left: 0.04, top: 0.16, width: 0.44, height: 0.36 },
  "top-center": { left: 0.24, top: 0.16, width: 0.52, height: 0.36 },
  "top-right": { left: 0.52, top: 0.16, width: 0.44, height: 0.36 },
  "middle-left": { left: 0.04, top: 0.24, width: 0.44, height: 0.58 },
  "middle-right": { left: 0.52, top: 0.24, width: 0.44, height: 0.58 },
  "middle-center": { left: 0.28, top: 0.26, width: 0.44, height: 0.5 },
  "bottom-left": { left: 0.04, top: 0.56, width: 0.44, height: 0.34 },
  "bottom-center": { left: 0.24, top: 0.56, width: 0.52, height: 0.34 },
  "bottom-right": { left: 0.52, top: 0.56, width: 0.44, height: 0.34 },
};

const DEFAULT_BOX: FigureBox = BOX_BY_POSITION["middle-right"];

const FIGURE_KINDS = new Set([
  "diagram",
  "chart",
  "screenshot",
  "picture",
  "table",
  "formula",
  "icon",
  "other",
]);

const KIND_SYNONYMS: Record<string, string> = {
  schema: "diagram",
  graph: "chart",
  plot: "chart",
  grafico: "chart",
  diagramma: "diagram",
  figura: "picture",
  image: "picture",
  photo: "picture",
  immagine: "picture",
  foto: "picture",
  screenshot: "screenshot",
  schermata: "screenshot",
  tabella: "table",
  formula: "formula",
  icona: "icon",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts `0.3`, `"0.3"`, `"30%"` and `30`: all mean the same fraction. */
function toFraction(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    return value > 1 ? value / 100 : value;
  }
  if (typeof value !== "string") return null;

  const text = value.trim().replace(",", ".");
  if (!text) return null;

  const percent = text.endsWith("%");
  const parsed = Number.parseFloat(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return percent || parsed > 1 ? parsed / 100 : parsed;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeBox(raw: Record<string, unknown>, position: string): FigureBox {
  const nested = isRecord(raw.box) ? raw.box : raw;
  const read = (key: string): number | null => toFraction(nested[key]);

  let left = read("left") ?? read("x");
  let top = read("top") ?? read("y");
  let width = read("width") ?? read("w");
  let height = read("height") ?? read("h");
  const right = read("right");
  const bottom = read("bottom");

  if (width === null && left !== null && right !== null) width = clamp01(right) - clamp01(left);
  if (height === null && top !== null && bottom !== null) height = clamp01(bottom) - clamp01(top);

  const fallback = BOX_BY_POSITION[position] ?? DEFAULT_BOX;

  left = clamp01(left ?? fallback.left);
  top = clamp01(top ?? fallback.top);
  width = Math.min(clamp01(width ?? fallback.width), 1 - left);
  height = Math.min(clamp01(height ?? fallback.height), 1 - top);

  if (width < MIN_BOX_SIDE || height < MIN_BOX_SIDE) {
    return {
      left: clamp01(Math.min(fallback.left, 1 - fallback.width)),
      top: clamp01(Math.min(fallback.top, 1 - fallback.height)),
      width: fallback.width,
      height: fallback.height,
    };
  }

  return {
    left: clamp01(Math.min(left, 1 - width)),
    top: clamp01(Math.min(top, 1 - height)),
    width,
    height,
  };
}

function positionFromBox(box: FigureBox): string {
  const centerX = box.left + box.width / 2;
  const centerY = box.top + box.height / 2;
  const vertical = centerY < 0.4 ? "top" : centerY > 0.6 ? "bottom" : "middle";
  const horizontal = centerX < 0.4 ? "left" : centerX > 0.6 ? "right" : "center";

  return `${vertical}-${horizontal}`;
}

function normalizePosition(value: unknown, box: FigureBox): string {
  if (typeof value !== "string" || !value.trim()) return positionFromBox(box);

  const position = value
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/[^a-z-]/g, "");

  return position || positionFromBox(box);
}

function normalizeKind(value: unknown): string {
  if (typeof value !== "string") return "diagram";

  const kind = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const canonical = KIND_SYNONYMS[kind] ?? kind;

  return FIGURE_KINDS.has(canonical) ? canonical : "diagram";
}

function normalizeLabels(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[|,;]/)
      : [];

  const labels: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const label = entry.replace(/\s+/g, " ").trim().slice(0, 80);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 12) break;
  }

  return labels;
}

/** The document's own texts: longer than a model's labels, and not guessed. */
function normalizeVerbatim(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;

    const text = entry.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    if (!texts.includes(text)) texts.push(text);
    if (texts.length >= 40) break;
  }

  return texts;
}

function normalizePalette(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[|,;\s]+/)
      : [];

  const colors: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const color = entry.trim();
    if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) continue;
    if (!colors.includes(color.toLowerCase())) colors.push(color.toLowerCase());
    if (colors.length >= 6) break;
  }

  return colors;
}

function normalizeDescription(raw: Record<string, unknown>): string {
  for (const key of ["description", "describe", "details", "detail", "text", "content"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").trim().slice(0, 1200);
    }
  }

  return "";
}


/**
 * Validates whatever arrived from the model or from the browser.
 * Anything unusable is dropped instead of reaching the renderer.
 */
export function normalizeFigures(value: unknown): SlideFigure[] {
  if (!Array.isArray(value)) return [];

  const figures: SlideFigure[] = [];
  const usedIds = new Set<string>();

  value.forEach((entry, index) => {
    if (figures.length >= MAX_FIGURES) return;
    if (!isRecord(entry)) return;

    const description = normalizeDescription(entry);
    if (description.length < 8) return;

    const hintedPosition =
      typeof entry.position === "string"
        ? entry.position.toLowerCase().replace(/[\s_]+/g, "-")
        : "";
    const box = normalizeBox(entry, hintedPosition);
    const position = normalizePosition(entry.position, box);

    const rawId = typeof entry.id === "string" ? entry.id : "";
    let id = rawId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) id = `figura-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);

    figures.push({
      id,
      position,
      kind: normalizeKind(entry.kind ?? entry.type),
      box,
      description,
      labels: normalizeLabels(entry.labels ?? entry.texts),
      verbatim: normalizeVerbatim(entry.verbatim),
      palette: normalizePalette(entry.palette ?? entry.colors),
    });
  });

  return figures;
}

/* -------------------------------------------------------------------------- */
/* Model answer                                                               */
/* -------------------------------------------------------------------------- */

/** Strips a fenced block and any chatter around the JSON array. */
function clearJson(value: string): string {
  const fenced = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```/.exec(value);
  const text = (fenced ? fenced[1] : value).trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");

  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

/**
 * Reads the `<<<FIGURES>>>` block: a JSON array when the model obeyed, a few
 * `position | kind | description` lines when it did not.
 */
export function parseFiguresBlock(section: string): SlideFigure[] {
  const text = section.trim();
  if (!text || /^none\b/i.test(text)) return [];

  const json = clearJson(text);
  if (json.startsWith("[")) {
    try {
      const figures = normalizeFigures(JSON.parse(json.replace(/,\s*([\]}])/g, "$1")));
      if (figures.length > 0) return figures;
    } catch {
      // Fall through: the line format is more forgiving.
    }
  }

  const entries: Record<string, unknown>[] = [];

  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("```") || line === "[" || line === "]") continue;

    line = line
      .replace(/^[-*•·]\s*/, "")
      .replace(/^\{|\},?$/g, "")
      .trim();
    if (!line || /^none\b/i.test(line)) continue;

    const parts = line.split("|").map((part) => part.trim());
    const description = parts.length >= 3 ? parts.slice(2).join(" | ") : parts[parts.length - 1];

    entries.push({
      position: parts.length >= 2 ? parts[0] : "",
      kind: parts.length >= 3 ? parts[1] : "",
      description,
    });
  }

  return normalizeFigures(entries);
}

const LEGACY_POSITION_HINTS: [RegExp, string][] = [
  [/\b(sinistra|left)\b/i, "left"],
  [/\b(destra|right)\b/i, "right"],
  [/\b(alto|superiore|above|top)\b/i, "top"],
  [/\b(basso|inferiore|below|bottom)\b/i, "bottom"],
];

const LEGACY_KIND_HINTS: [RegExp, string][] = [
  [/\b(grafico|chart|plot|istogramma|barre)\b/i, "chart"],
  [/\b(schema|diagram|diagramma|flow)\b/i, "diagram"],
  [/\b(screenshot|schermata|console|terminale)\b/i, "screenshot"],
  [/\b(tabella|table)\b/i, "table"],
];

/**
 * Safety net for a model answer in the old format: the paragraph under
 * "Immagini e layout" becomes one figure instead of being shown as body text.
 */
export function figuresFromLegacyText(text: string): SlideFigure[] {
  const description = text.replace(/\s+/g, " ").trim();
  if (description.length < 8) return [];

  const hints = LEGACY_POSITION_HINTS.filter(([pattern]) => pattern.test(description)).map(
    ([, hint]) => hint,
  );
  const horizontal = hints.find((hint) => hint === "left" || hint === "right");
  const vertical = hints.find((hint) => hint === "top" || hint === "bottom");

  const position =
    vertical && horizontal
      ? `${vertical}-${horizontal}`
      : horizontal
        ? `middle-${horizontal}`
        : vertical
          ? `${vertical}-center`
          : "middle-right";

  const kind = LEGACY_KIND_HINTS.find(([pattern]) => pattern.test(description))?.[1] ?? "diagram";

  return normalizeFigures([
    {
      id: "figura-1",
      position,
      kind,
      description,
      labels: [],
      palette: [],
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                  */
/* -------------------------------------------------------------------------- */

/** Converts a fractional box into pixels inside `frame`, keeping it fully visible. */
export function boxToRect(box: FigureBox, frame: SlideRect): SlideRect {
  const x = frame.x + box.left * frame.width;
  const y = frame.y + box.top * frame.height;
  const width = Math.max(24, box.width * frame.width);
  const height = Math.max(24, box.height * frame.height);

  const visibleWidth = Math.max(24, Math.min(width, frame.x + frame.width - x));
  const visibleHeight = Math.max(24, Math.min(height, frame.y + frame.height - y));

  return {
    x: Math.round(Math.min(x, frame.x + frame.width - visibleWidth)),
    y: Math.round(Math.min(y, frame.y + frame.height - visibleHeight)),
    width: Math.round(visibleWidth),
    height: Math.round(visibleHeight),
  };
}

function overlapArea(left: SlideRect, right: SlideRect): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);

  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The largest rectangle of `frame` that no figure covers.
 *
 * Candidates are the four bands around the reserved areas (left of every
 * figure, right of every figure, above them, below them): that is what makes a
 * picture on the left push the text to the right and a picture at the bottom
 * leave the text at the top.
 */
export function freeAreaFor(frame: SlideRect, taken: SlideRect[]): SlideRect {
  if (taken.length === 0) return frame;

  const minWidth = Math.max(240, frame.width * 0.3);
  const minHeight = Math.max(180, frame.height * 0.24);

  const leftEdge = Math.min(...taken.map((rect) => rect.x));
  const rightEdge = Math.max(...taken.map((rect) => rect.x + rect.width));
  const topEdge = Math.min(...taken.map((rect) => rect.y));
  const bottomEdge = Math.max(...taken.map((rect) => rect.y + rect.height));

  const candidates: SlideRect[] = [
    frame,
    { x: frame.x, y: frame.y, width: leftEdge - frame.x, height: frame.height },
    {
      x: rightEdge,
      y: frame.y,
      width: frame.x + frame.width - rightEdge,
      height: frame.height,
    },
    { x: frame.x, y: frame.y, width: frame.width, height: topEdge - frame.y },
    {
      x: frame.x,
      y: bottomEdge,
      width: frame.width,
      height: frame.y + frame.height - bottomEdge,
    },
  ];

  const usable = candidates
    .map((rect) => ({ rect, area: Math.max(0, rect.width) * Math.max(0, rect.height) }))
    .filter(
      (candidate) =>
        candidate.rect.width >= minWidth &&
        candidate.rect.height >= minHeight &&
        taken.every((rect) => overlapArea(candidate.rect, rect) === 0),
    )
    .sort((left, right) => right.area - left.area);

  if (usable.length > 0) {
    const { x, y, width, height } = usable[0].rect;

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  // A figure covers almost everything: keep the text inside the frame and let
  // the planner's clipping decide, instead of inventing an off-slide column.
  return frame;
}

