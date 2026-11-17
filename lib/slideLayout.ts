/**
 * Lays out one transcribed slide on the template.
 *
 * The planner is pure: it measures with the very context that will draw, and
 * returns an ordered list of primitives. Keeping planning and drawing apart is
 * what makes it possible to try several type sizes, and one or two columns,
 * before committing to anything.
 */

import type {
  SlideBlock,
  SlideListItem,
  SlideModel,
  SlideRun,
  SlideSection,
} from "./slideMarkdown";
import {
  boxToRect,
  freeAreaFor,
  type FigureBox,
  type SlideFigure,
  type SlideRect,
} from "./slideFigures";
import { COLORS, FONTS, SLIDE_HEIGHT, SLIDE_WIDTH } from "./slideTheme";
import { drawMath, layoutMath } from "./slideMath";

type RasterContext = import("@napi-rs/canvas").SKRSContext2D;
type RasterImage = import("@napi-rs/canvas").Image;
type RasterCanvas = import("@napi-rs/canvas").Canvas;

export type SlideCommand =
  | { kind: "text"; x: number; y: number; text: string; font: string; color: string }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: string;
      stroke?: string;
      radius?: number;
    }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  /** A formula: `y` is its baseline, `x` its left end. */
  | { kind: "math"; x: number; y: number; tex: string; size: number; color: string };

export interface SlideLayout {
  commands: SlideCommand[];
  /** Pictures to draw behind the text, in design pixels. */
  figures: PlacedFigure[];
  /** Area the content may use; anything outside is cut. */
  frame: { x: number; y: number; width: number; height: number };
  /** True when even the smallest type did not make the content fit. */
  clipped: boolean;
  /** Sections that were laid out (headings included). */
  sections: number;
}

/** A picture of the original slide, recreated and positioned on the new one. */
export interface PlacedFigure {
  figure: SlideFigure;
  /** Where it goes, in design pixels. */
  rect: SlideRect;
  /** The recreated artwork; absent when the model could not redraw it. */
  image?: RasterCanvas | RasterImage;
}

/** The frame the template leaves free, in design pixels. */
const FRAME = { left: 140, right: 140, top: 205, bottom: 92 };
const TITLE_SIZE = 64;
const TITLE_LINE = 1.16;
const MAX_TITLE_LINES = 2;
const SECTION_GAP = 32;
const BLOCK_GAP = 20;
const COLUMN_GAP = 62;

/** The whole area the template leaves free: title, text and pictures live here. */
export function figureFrame(): SlideRect {
  return {
    x: FRAME.left,
    y: FRAME.top,
    width: SLIDE_WIDTH - FRAME.left - FRAME.right,
    height: SLIDE_HEIGHT - FRAME.top - FRAME.bottom,
  };
}

/**
 * A picture smaller than this is grown once, before the layout, so the model is
 * not asked to draw a 40-pixel thumbnail; the budget may still shrink it later.
 */
const MIN_FIGURE_SIDE = 130;
/**
 * Share of the frame the pictures may take. The rest is text: without this a
 * model that reports one huge element would leave the transcription nowhere to go.
 */
const FIGURE_BUDGET = 0.52;

/**
 * Second attempt, used when the text does not fit: the pictures keep their
 * place and their proportions, but take less of the frame.
 */
export const TIGHT_FIGURE_BUDGET = 0.3;

/**
 * Positions the figures of one slide where the original slide had them.
 *
 * Coordinates arrive as fractions of the slide and become design pixels here.
 * Two corrections are applied: the pictures share a budget of the frame, and
 * they are shrunk away from each other, so that a model reporting slightly
 * overlapping boxes does not stack two drawings one on top of the other.
 *
 * `topLimit` keeps the pictures under the title: an element that reaches into
 * the top of the original slide is pushed down instead of being drawn over the
 * heading, which is what made the same deck look different from slide to slide.
 */
export function placeFigures(
  figures: SlideFigure[],
  budgetShare: number = FIGURE_BUDGET,
  topLimit: number = FRAME.top,
): PlacedFigure[] {
  const whole = figureFrame();
  const top = Math.max(whole.y, Math.round(topLimit));
  const frame: SlideRect = {
    x: whole.x,
    y: top,
    width: whole.width,
    height: Math.max(1, whole.y + whole.height - top),
  };
  const placed: PlacedFigure[] = [];
  let budget = frame.width * frame.height * budgetShare;

  for (const figure of figures) {
    // The box is read against the whole slide area, so an element keeps its
    // proportion of the page; only what falls inside the free band is used.
    const target = clipTo(keepAspect(boxToRect(figure.box, whole), figure.box), frame);
    let rect = atLeastMinSide(target, frame);
    const area = rect.width * rect.height;

    if (area > budget && area > 0) {
      rect = scaleRect(rect, Math.max(0.45, Math.sqrt(budget / area)));
    }

    rect = separate(rect, placed.map((entry) => entry.rect), frame);
    budget = Math.max(0, budget - rect.width * rect.height);
    placed.push({ figure, rect });
  }

  return placed;
}

/** The part of `rect` that falls inside `frame`, sliding it back when needed. */
function clipTo(rect: SlideRect, frame: SlideRect): SlideRect {
  const width = Math.max(1, Math.min(rect.width, frame.width));
  const height = Math.max(1, Math.min(rect.height, frame.height));
  const x = Math.min(Math.max(rect.x, frame.x), frame.x + frame.width - width);
  const y = Math.min(Math.max(rect.y, frame.y), frame.y + frame.height - height);

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * The same rectangle, with the aspect ratio the element had on the slide.
 *
 * The frame is not the same shape as a slide (1640×783 against 1920×1080), so
 * mapping a fraction of the slide into the frame stretches every picture
 * horizontally: a compact table becomes a wide strip, and the model is then
 * asked to draw a wide strip. Fitting the original aspect inside the reserved
 * area keeps a table a table; the freed space goes back to the text.
 */
function keepAspect(rect: SlideRect, box: FigureBox): SlideRect {
  const sourceWidth = box.width * SLIDE_WIDTH;
  const sourceHeight = box.height * SLIDE_HEIGHT;
  if (sourceWidth <= 0 || sourceHeight <= 0) return rect;

  const aspect = sourceWidth / sourceHeight;
  let width = rect.width;
  let height = width / aspect;

  if (height > rect.height) {
    height = rect.height;
    width = height * aspect;
  }

  return {
    x: Math.round(rect.x + (rect.width - width) / 2),
    y: Math.round(rect.y + (rect.height - height) / 2),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/**
 * Grows a rectangle uniformly until its smaller side reaches the minimum.
 *
 * The floor belongs here, once, and not in `scaleRect`: enforcing it on each
 * dimension separately is what turned a wide, short table into a wide, tall
 * one whenever the layout had to shrink it.
 */
function atLeastMinSide(rect: SlideRect, frame: SlideRect): SlideRect {
  const smaller = Math.min(rect.width, rect.height);
  if (smaller >= MIN_FIGURE_SIDE) return rect;

  const fit = Math.min(frame.width / Math.max(1, rect.width), frame.height / Math.max(1, rect.height));
  const scale = Math.min(MIN_FIGURE_SIDE / Math.max(1, smaller), Math.max(1, fit));
  const width = Math.round(rect.width * scale);
  const height = Math.round(rect.height * scale);

  return {
    x: Math.round(
      Math.max(frame.x, Math.min(rect.x - (width - rect.width) / 2, frame.x + frame.width - width)),
    ),
    y: Math.round(
      Math.max(
        frame.y,
        Math.min(rect.y - (height - rect.height) / 2, frame.y + frame.height - height),
      ),
    ),
    width,
    height,
  };
}

function scaleRect(rect: SlideRect, factor: number): SlideRect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(1, Math.round(rect.width * factor)),
    height: Math.max(1, Math.round(rect.height * factor)),
  };
}

function overlapOf(left: SlideRect, right: SlideRect): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);

  return width > 0 && height > 0 ? width * height : 0;
}

/** Shrinks `rect` until it stops covering an earlier picture, if it can. */
function separate(rect: SlideRect, taken: SlideRect[], frame: SlideRect): SlideRect {
  let current = rect;

  for (let step = 0; step < 5; step += 1) {
    if (taken.every((other) => overlapOf(current, other) === 0)) return current;

    const next = scaleRect(current, 0.82);
    // Shrinking happens around the top-left corner: keep the picture in frame.
    next.x = Math.round(Math.min(next.x, frame.x + frame.width - next.width));
    next.y = Math.round(Math.min(next.y, frame.y + frame.height - next.height));
    current = next;
  }

  return current;
}

interface Metrics {
  body: number;
  bodyLine: number;
  heading: number;
  headingLine: number;
  code: number;
  codeLine: number;
  table: number;
  tableLine: number;
  title: number;
  titleLine: number;
  pad: number;
}

function metricsFor(scale: number): Metrics {
  return {
    body: Math.round(30 * scale),
    bodyLine: Math.round(30 * 1.4 * scale),
    heading: Math.round(32 * scale),
    headingLine: Math.round(32 * 1.3 * scale),
    code: Math.round(20 * scale),
    codeLine: Math.round(20 * 1.5 * scale),
    table: Math.round(22 * scale),
    tableLine: Math.round(22 * 1.4 * scale),
    title: Math.round(TITLE_SIZE * scale),
    titleLine: Math.round(TITLE_SIZE * TITLE_LINE * scale),
    pad: Math.round(18 * scale),
  };
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

function fontFor(size: number, style: RunStyle = {}): string {
  const family = style.mono ? FONTS.mono : FONTS.sans;
  return `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} ${size}px "${family}"`;
}

function runStyle(run: SlideRun): RunStyle {
  if (run.code) return { mono: true };
  if (run.math) return { italic: true };
  return { bold: run.bold, italic: run.italic };
}

interface Token {
  text: string;
  font: string;
  color: string;
  width: number;
  space: boolean;
  /** A formula: how wide it is and how far it reaches from the baseline. */
  math?: { tex: string; size: number; ascent: number; descent: number };
}

function measure(context: RasterContext, token: Omit<Token, "width" | "math">): number {
  context.font = token.font;
  return context.measureText(token.text).width;
}

/** Runs → word and space tokens, already measured. */
function tokenize(context: RasterContext, runs: SlideRun[], size: number, color: string): Token[] {
  const tokens: Token[] = [];

  runs.forEach((run, runIndex) => {
    if (run.tex) {
      const layout = layoutMath(context, run.tex, size);
      tokens.push({
        text: run.text,
        font: fontFor(size, runStyle(run)),
        color,
        width: layout.width,
        space: false,
        math: { tex: run.tex, size, ascent: layout.ascent, descent: layout.descent },
      });
      return;
    }

    const font = fontFor(run.code ? Math.round(size * 0.92) : size, runStyle(run));
    const runColor = run.code ? COLORS.steel : color;
    const parts = run.text.split(/(\s+)/);

    for (const part of parts) {
      if (part.length === 0) continue;

      if (/^\s+$/.test(part)) {
        const token = { text: " ", font, color: runColor, space: true };
        tokens.push({ ...token, width: measure(context, token) });
        continue;
      }

      const token = { text: part, font, color: runColor, space: false };
      tokens.push({ ...token, width: measure(context, token) });
    }

    const next = runs[runIndex + 1];
    if (
      next &&
      !next.tex &&
      !/\s$/.test(run.text) &&
      !/^\s/.test(next.text) &&
      /[\w.,;:!?)\]}%]$/.test(run.text) &&
      /^[\w([{"']/.test(next.text)
    ) {
      const token = { text: " ", font, color: runColor, space: true };
      tokens.push({ ...token, width: measure(context, token) });
    }
  });

  return tokens;
}

/** Greedy wrap on the measured tokens; spaces never start a line. */
function wrapTokens(tokens: Token[], maxWidth: number): Token[][] {
  const lines: Token[][] = [];
  let line: Token[] = [];
  let pending: Token[] = [];
  let width = 0;

  const flushLine = (): void => {
    while (line.length > 0 && line[line.length - 1].space) line.pop();
    lines.push(line);
    line = [];
    pending = [];
    width = 0;
  };

  for (const token of tokens) {
    if (token.space) {
      if (line.length > 0) pending.push(token);
      continue;
    }

    const gap = pending.reduce((total, space) => total + space.width, 0);
    if (line.length > 0 && width + gap + token.width > maxWidth) flushLine();

    for (const space of pending) {
      line.push(space);
      width += space.width;
    }
    pending = [];

    line.push(token);
    width += token.width;
  }

  if (line.length > 0) flushLine();
  return lines;
}

/**
 * Text commands for wrapped lines starting at (x, y).
 *
 * A line that carries a formula is taller than a line of text: the fraction
 * reaches above the text's own ascent, so the line is pushed down by that much
 * and the next one starts below the deepest formula. The formulas and the words
 * share the same baseline, which is what makes `x = \frac{a}{b}` read as one
 * sentence instead of a picture glued next to a word.
 */
function textCommands(
  context: RasterContext,
  lines: Token[][],
  x: number,
  y: number,
  lineHeight: number,
  size: number,
): { commands: SlideCommand[]; height: number } {
  const commands: SlideCommand[] = [];

  context.font = fontFor(size);
  const probe = context.measureText("Hxgy");
  const textAscent = probe.actualBoundingBoxAscent > 0 ? probe.actualBoundingBoxAscent : size * 0.74;
  const textDescent = probe.actualBoundingBoxDescent > 0 ? probe.actualBoundingBoxDescent : size * 0.22;

  let cursor = y;

  for (const line of lines) {
    let above = 0;
    let below = 0;

    for (const token of line) {
      if (!token.math) continue;
      above = Math.max(above, token.math.ascent - textAscent);
      below = Math.max(below, token.math.descent - textDescent);
    }

    const top = cursor + above;
    let column = x;

    for (const token of line) {
      if (token.math) {
        commands.push({
          kind: "math",
          x: column,
          y: top + textAscent,
          tex: token.math.tex,
          size: token.math.size,
          color: token.color,
        });
      } else {
        commands.push({
          kind: "text",
          x: column,
          y: top,
          text: token.text,
          font: token.font,
          color: token.color,
        });
      }
      column += token.width;
    }

    cursor += lineHeight + above + below;
  }

  return { commands, height: cursor - y };
}

function ellipsize(context: RasterContext, text: string, font: string, maxWidth: number): string {
  context.font = font;
  if (context.measureText(text).width <= maxWidth) return text;

  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}…`;
}

interface Planned {
  commands: SlideCommand[];
  height: number;
}

function planParagraph(
  context: RasterContext,
  runs: SlideRun[],
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
  color: string,
): Planned {
  const tokens = tokenize(context, runs, metrics.body, color);
  const lines = wrapTokens(tokens, width);
  const text = textCommands(context, lines, x, y, metrics.bodyLine, metrics.body);

  return { commands: text.commands, height: text.height };
}

/**
 * A display formula, centred in the column it belongs to.
 *
 * It is set a little larger than the body text (the source slides do the same)
 * and shrunk only when it would not fit the column, so a long expression never
 * runs under a picture or off the slide.
 */
function planFormula(
  context: RasterContext,
  tex: string,
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  let size = Math.max(14, Math.round(metrics.body * 1.12));
  let formula = layoutMath(context, tex, size);

  while (formula.width > width && size > 13) {
    size = Math.max(13, size - 2);
    formula = layoutMath(context, tex, size);
  }

  const padding = Math.round(size * 0.3);
  const left = x + Math.max(0, (width - formula.width) / 2);

  return {
    commands: [
      {
        kind: "math",
        x: left,
        y: y + padding + formula.ascent,
        tex,
        size,
        color: COLORS.ink,
      },
    ],
    height: formula.ascent + formula.descent + padding * 2,
  };
}


function planList(
  context: RasterContext,
  items: SlideListItem[],
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  const commands: SlideCommand[] = [];
  const step = Math.max(1, metrics.body);
  const levelIndent = Math.round(step * 0.95);
  const markerFont = fontFor(metrics.body);
  const gap = Math.round(step * 0.32);
  let cursor = y;

  for (const item of items) {
    const marker = item.marker ?? (item.level === 0 ? "•" : "–");
    const left = x + item.level * levelIndent;
    context.font = markerFont;
    const markerWidth = Math.max(
      context.measureText(marker).width,
      context.measureText("•").width,
    );

    commands.push({
      kind: "text",
      x: left,
      y: cursor - Math.round(step * 0.06),
      text: marker,
      font: markerFont,
      color: item.level === 0 ? COLORS.steel : COLORS.faint,
    });

    const textX = left + markerWidth + Math.round(step * 0.45);
    const plan = planParagraph(
      context,
      item.runs,
      textX,
      cursor,
      width - (textX - x),
      metrics,
      COLORS.ink,
    );

    commands.push(...plan.commands);
    cursor += Math.max(plan.height, metrics.bodyLine) + gap;
  }

  return { commands, height: Math.max(0, cursor - y - gap) };
}

function planCode(
  context: RasterContext,
  block: Extract<SlideBlock, { type: "code" }>,
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  const pad = metrics.pad;
  const monoFont = fontFor(metrics.code, { mono: true });
  const labelFont = fontFor(Math.round(metrics.code * 0.76), { bold: true });
  const innerWidth = width - pad * 2;
  const rows: string[] = [];

  const source = block.lines.length > 0 ? block.lines : [""];
  for (const line of source) {
    rows.push(...wrapCodeLine(context, line.replace(/\t/g, "    "), monoFont, innerWidth));
  }

  const language = block.language.trim();
  const labelHeight = language ? Math.round(metrics.codeLine * 1.1) : 0;
  const height = pad * 2 + labelHeight + rows.length * metrics.codeLine;
  const commands: SlideCommand[] = [
    { kind: "rect", x, y, width, height, fill: COLORS.code, radius: Math.round(pad * 0.8) },
  ];

  if (language) {
    commands.push({
      kind: "text",
      x: x + pad,
      y: y + Math.round(pad * 0.72),
      text: language.toUpperCase(),
      font: labelFont,
      color: "#8fb8d8",
    });
  }

  const firstLine = y + pad + labelHeight;
  rows.forEach((row, index) => {
    if (row.length === 0) return;
    commands.push({
      kind: "text",
      x: x + pad,
      y: firstLine + index * metrics.codeLine,
      text: row,
      font: monoFont,
      color: COLORS.codeText,
    });
  });

  return { commands, height };
}

function wrapCodeLine(
  context: RasterContext,
  line: string,
  font: string,
  maxWidth: number,
): string[] {
  context.font = font;
  if (line.length === 0 || context.measureText(line).width <= maxWidth) return [line];

  const rows: string[] = [];
  let current = "";

  for (const char of line) {
    if (current.length > 0 && context.measureText(current + char).width > maxWidth) {
      rows.push(current);
      current = `  ${char}`;
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) rows.push(current);
  return rows;
}

function wrapText(
  context: RasterContext,
  text: string,
  font: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  context.font = font;
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const rows: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (context.measureText(candidate).width <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }

    rows.push(current);
    current = word;
    if (rows.length === maxLines) break;
  }

  if (rows.length < maxLines && current.length > 0) rows.push(current);

  const used = rows.join(" ");
  if (rows.length === maxLines && used.length < text.length) {
    rows[maxLines - 1] = ellipsize(context, rows[maxLines - 1], font, maxWidth);
  }

  return rows.length > 0 ? rows : [""];
}


function planTable(
  context: RasterContext,
  block: Extract<SlideBlock, { type: "table" }>,
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const padX = Math.round(metrics.table * 0.7);
  const padY = Math.round(metrics.table * 0.5);
  const bodyFont = fontFor(metrics.table);
  const headerFont = fontFor(metrics.table, { bold: true });

  const natural = new Array<number>(columns).fill(0);
  const widen = (cells: string[], font: string): void => {
    context.font = font;
    for (let column = 0; column < columns; column += 1) {
      const text = cells[column] ?? "";
      natural[column] = Math.max(natural[column], context.measureText(text).width);
    }
  };

  widen(block.header, headerFont);
  for (const row of block.rows) widen(row, bodyFont);

  const gutter = padX * 2;
  const minColumn = Math.round(metrics.table * 2.6) + gutter;
  const naturalWidths = natural.map((value) => Math.ceil(value) + gutter);
  const totalNatural = naturalWidths.reduce((total, value) => total + value, 0);

  let widths: number[];

  if (totalNatural <= width) {
    // Spare room is shared by the columns in proportion: the table fills the
    // frame instead of floating in the middle of it.
    const spare = width - totalNatural;
    widths = naturalWidths.map((value) => value + (spare * value) / totalNatural);
  } else {
    const shrinkable = naturalWidths.map((value) => Math.max(0, value - minColumn));
    const shrinkTotal = shrinkable.reduce((total, value) => total + value, 0) || 1;
    const factor = Math.min(1, (totalNatural - width) / shrinkTotal);
    widths = naturalWidths.map((value, index) => value - shrinkable[index] * factor);
  }

  // Normalise to exactly the available width, whatever the rounding did.
  const normaliser = widths.reduce((total, value) => total + value, 0) || 1;
  widths = widths.map((value) => Math.round((value * width) / normaliser));
  widths[widths.length - 1] += width - widths.reduce((total, value) => total + value, 0);

  const rows: { cells: string[][]; header: boolean }[] = [
    {
      cells: widths.map((cellWidth, column) =>
        wrapText(context, block.header[column] ?? "", headerFont, cellWidth - padX * 2, 2),
      ),
      header: true,
    },
    ...block.rows.map((row) => ({
      cells: widths.map((cellWidth, column) =>
        wrapText(context, row[column] ?? "", bodyFont, cellWidth - padX * 2, 3),
      ),
      header: false,
    })),
  ];

  const heights = rows.map((row) => {
    const lines = Math.max(1, ...row.cells.map((cell) => cell.length));
    return lines * metrics.tableLine + padY * 2;
  });

  const commands: SlideCommand[] = [];
  let cursor = y;

  rows.forEach((row, rowIndex) => {
    const rowHeight = heights[rowIndex];
    const font = row.header ? headerFont : bodyFont;

    commands.push({
      kind: "rect",
      x,
      y: cursor,
      width,
      height: rowHeight,
      fill: row.header ? "#e4eef8" : COLORS.white,
    });

    let cellX = x;
    row.cells.forEach((cell, column) => {
      const cellWidth = widths[column];
      const blockHeight = cell.length * metrics.tableLine;
      const textY = cursor + (rowHeight - blockHeight) / 2;

      cell.forEach((line, lineIndex) => {
        if (line.length === 0) return;
        commands.push({
          kind: "text",
          x: cellX + padX,
          y: textY + lineIndex * metrics.tableLine,
          text: ellipsize(context, line, font, cellWidth - padX * 2),
          font,
          color: row.header ? COLORS.navy : COLORS.ink,
        });
      });

      cellX += cellWidth;
      if (column < row.cells.length - 1) {
        commands.push({
          kind: "line",
          x1: cellX,
          y1: cursor,
          x2: cellX,
          y2: cursor + rowHeight,
          color: COLORS.panelBorder,
          width: 1,
        });
      }
    });

    cursor += rowHeight;
    commands.push({
      kind: "line",
      x1: x,
      y1: cursor,
      x2: x + width,
      y2: cursor,
      color: COLORS.panelBorder,
      width: 1,
    });
  });

  const totalWidth = widths.reduce((total, value) => total + value, 0);
  commands.push({
    kind: "rect",
    x,
    y,
    width: Math.min(width, totalWidth),
    height: cursor - y,
    stroke: COLORS.panelBorder,
  });

  return { commands, height: cursor - y };
}

function planQuote(
  context: RasterContext,
  runs: SlideRun[],
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  const pad = Math.round(metrics.pad * 0.9);
  const bar = Math.max(4, Math.round(metrics.body * 0.26));
  const inset = Math.round(pad * 0.4);
  const text = planParagraph(
    context,
    runs,
    x + pad + bar + inset,
    y + pad,
    width - pad * 2 - bar - inset,
    metrics,
    COLORS.muted,
  );
  const height = text.height + pad * 2;

  return {
    height,
    commands: [
      { kind: "rect", x, y, width, height, fill: COLORS.panel, radius: Math.round(pad * 0.7) },
      { kind: "rect", x, y, width: bar, height, fill: COLORS.lightBlue, radius: bar / 2 },
      ...text.commands,
    ],
  };
}

function planFigure(
  context: RasterContext,
  runs: SlideRun[],
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  const pad = Math.round(metrics.pad * 0.9);
  const labelHeight = Math.round(metrics.body * 0.95);
  const text = planParagraph(
    context,
    runs,
    x + pad,
    y + pad + labelHeight,
    width - pad * 2,
    metrics,
    COLORS.ink,
  );
  const height = text.height + pad * 2 + labelHeight;

  return {
    height,
    commands: [
      {
        kind: "rect",
        x,
        y,
        width,
        height,
        fill: COLORS.panel,
        stroke: COLORS.panelBorder,
        radius: Math.round(pad * 0.7),
      },
      {
        kind: "text",
        x: x + pad,
        y: y + pad,
        text: "FIGURA",
        font: fontFor(Math.round(metrics.body * 0.66), { bold: true }),
        color: COLORS.steel,
      },
      ...text.commands,
    ],
  };
}

function planRule(x: number, y: number, width: number): Planned {
  return {
    height: 10,
    commands: [{ kind: "line", x1: x, y1: y, x2: x + width, y2: y, color: COLORS.panelBorder, width: 2 }],
  };
}

function planBlock(
  context: RasterContext,
  block: SlideBlock,
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
): Planned {
  switch (block.type) {
    case "paragraph":
      return planParagraph(context, block.runs, x, y, width, metrics, COLORS.ink);
    case "list":
      return planList(context, block.items, x, y, width, metrics);
    case "code":
      return planCode(context, block, x, y, width, metrics);
    case "table":
      return planTable(context, block, x, y, width, metrics);
    case "quote":
      return planQuote(context, block.runs, x, y, width, metrics);
    case "figure":
      return planFigure(context, block.runs, x, y, width, metrics);
    case "formula":
      return planFormula(context, block.tex, x, y, width, metrics);
    case "rule":
      return planRule(x, y, width);
    default:
      return { commands: [], height: 0 };
  }
}

function planSection(
  context: RasterContext,
  section: SlideSection,
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
  limit: number = Number.POSITIVE_INFINITY,
): Planned {
  const commands: SlideCommand[] = [];
  let cursor = y;

  if (section.heading) {
    const runs = section.heading.map((run) => ({ ...run, bold: true }));
    const tokens = tokenize(context, runs, metrics.heading, COLORS.steel);
    const lines = wrapTokens(tokens, width).slice(0, 2);
    const placed = textCommands(context, lines, x, cursor, metrics.headingLine, metrics.heading);

    commands.push(...placed.commands);
    cursor += placed.height + Math.round(metrics.heading * 0.3);

    const ruleHeight = Math.max(2, Math.round(metrics.heading * 0.12));
    commands.push({
      kind: "rect",
      x,
      y: cursor,
      width: Math.round(metrics.heading * 2.4),
      height: ruleHeight,
      fill: COLORS.blue,
      radius: ruleHeight / 2,
    });
    cursor += ruleHeight + Math.round(metrics.heading * 0.55);
  }

  let lastGap = 0;
  let drawn = 0;

  for (const block of section.blocks) {
    const plan = planBlock(context, block, x, cursor, width, metrics);

    // Content is never cut mid-block unless it is the first thing of the
    // section: a block that does not fit after others is replaced by an
    // ellipsis, so the slide never shows half a table or half a panel.
    if (cursor + plan.height > limit && drawn > 0) {
      commands.push({
        kind: "text",
        x,
        y: cursor,
        text: "…",
        font: fontFor(metrics.body, { bold: true }),
        color: COLORS.faint,
      });
      return { commands, height: Math.max(0, cursor - y) };
    }

    commands.push(...plan.commands);
    drawn += 1;
    lastGap = plan.height > 0 ? blockGap(block, metrics) : 0;
    cursor += plan.height + lastGap;
  }

  return { commands, height: Math.max(0, cursor - y - lastGap) };
}

function planSections(
  context: RasterContext,
  sections: SlideSection[],
  x: number,
  y: number,
  width: number,
  metrics: Metrics,
  limit: number = Number.POSITIVE_INFINITY,
): Planned {
  const commands: SlideCommand[] = [];
  let cursor = y;

  for (let index = 0; index < sections.length; index += 1) {
    if (index > 0) cursor += Math.round(SECTION_GAP * (metrics.body / 30));
    if (cursor >= limit) break;

    const plan = planSection(context, sections[index], x, cursor, width, metrics, limit);
    commands.push(...plan.commands);
    cursor += plan.height;
  }

  return { commands, height: cursor - y };
}

function planTitle(
  context: RasterContext,
  runs: SlideRun[],
  x: number,
  y: number,
  maxWidth: number,
  metrics: Metrics,
): Planned {
  const bold = runs.map((run) => ({ ...run, bold: true, code: false }));
  let size = metrics.title;
  let lines: Token[][] = [];

  for (const factor of [1, 0.92, 0.84, 0.76]) {
    size = Math.round(metrics.title * factor);
    lines = wrapTokens(tokenize(context, bold, size, COLORS.navy), maxWidth);
    if (lines.length <= MAX_TITLE_LINES) break;
  }

  if (lines.length > MAX_TITLE_LINES) {
    const keep = lines.slice(0, MAX_TITLE_LINES);
    const last = keep[MAX_TITLE_LINES - 1];
    const font = fontFor(size, { bold: true });
    const plain = last.map((token) => token.text).join("").trim();
    const clipped = ellipsize(context, plain, font, maxWidth);
    keep[MAX_TITLE_LINES - 1] = [
      {
        text: clipped,
        font,
        color: COLORS.navy,
        space: false,
        width: measure(context, { text: clipped, font, color: COLORS.navy, space: false }),
      },
    ];
    lines = keep;
  }

  const lineHeight = Math.round(size * TITLE_LINE);
  const placed = textCommands(context, lines, x, y, lineHeight, size);
  const ruleY = y + placed.height + Math.round(size * 0.3);
  const ruleHeight = Math.max(3, Math.round(size * 0.1));

  placed.commands.push({
    kind: "rect",
    x,
    y: ruleY,
    width: Math.round(size * 1.7),
    height: ruleHeight,
    fill: COLORS.blue,
    radius: ruleHeight / 2,
  });

  return { commands: placed.commands, height: ruleY + ruleHeight - y };
}

function splitSections(
  context: RasterContext,
  sections: SlideSection[],
  width: number,
  metrics: Metrics,
): [SlideSection[], SlideSection[]] {
  const heights = sections.map(
    (section) => planSection(context, section, 0, 0, width, metrics).height,
  );
  const total = heights.reduce((sum, height) => sum + height, 0);

  let split = Math.ceil(sections.length / 2);
  let best = Number.POSITIVE_INFINITY;
  let walked = 0;

  for (let index = 1; index < sections.length; index += 1) {
    walked += heights[index - 1];
    const tallest = Math.max(walked, total - walked);
    if (tallest < best) {
      best = tallest;
      split = index;
    }
  }

  return [sections.slice(0, split), sections.slice(split)];
}

function blockGap(block: SlideBlock, metrics: Metrics): number {
  const base = Math.round(BLOCK_GAP * (metrics.body / 30));
  return block.type === "code" || block.type === "table" || block.type === "formula"
    ? Math.round(base * 1.35)
    : base;
}


/** Everything below the title belongs to the content; the title never moves. */
const TITLE_GAP = 30;
/** The type sizes tried, largest first. The title is not part of the search. */
const SCALES = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64];

/** Runs of the title, with the fallback used when a slide has none. */
function titleRunsFor(model: SlideModel, fallbackTitle: string): SlideRun[] {
  return model.title.length > 0 ? model.title : [{ text: fallbackTitle }];
}

/** A title, always at the same size in the same place, on every slide. */
function planFixedTitle(
  context: RasterContext,
  model: SlideModel,
  fallbackTitle: string,
): Planned {
  const frame = figureFrame();
  const metrics = metricsFor(1);
  return planTitle(context, titleRunsFor(model, fallbackTitle), frame.x, frame.y, frame.width, {
    ...metrics,
    title: TITLE_SIZE,
    titleLine: Math.round(TITLE_SIZE * TITLE_LINE),
  });
}

/**
 * The line under which the content of every slide starts.
 *
 * All slides share the same title block, so a reader flipping through the deck
 * finds the first line of text at the same height even when the titles differ
 * in length; pictures are kept under this line too.
 */
export function contentTopFor(
  context: RasterContext,
  model: SlideModel,
  fallbackTitle: string,
): number {
  const plan = planFixedTitle(context, model, fallbackTitle);
  return figureFrame().y + plan.height + TITLE_GAP;
}

/**
 * Plans one slide: title on top, then the sections, in one column when they
 * fit and in two when they do not. Type size steps down until everything fits.
 *
 * The figures keep the area they had on the original slide, but never climb
 * into the title; the text is planned in the largest band that is left, so a
 * picture on the left pushes the text to the right instead of being buried
 * under it.
 */
export function planSlide(
  context: RasterContext,
  model: SlideModel,
  fallbackTitle: string,
  figures: PlacedFigure[] = [],
): SlideLayout {
  const wholeFrame = figureFrame();
  const title = planFixedTitle(context, model, fallbackTitle);
  const top = wholeFrame.y + title.height + TITLE_GAP;
  const frame = freeAreaFor(
    { ...wholeFrame, y: top, height: wholeFrame.y + wholeFrame.height - top },
    figures.map((entry) => entry.rect),
  );
  const columnWidth = Math.round((frame.width - COLUMN_GAP) / 2);
  const limit = frame.y + frame.height;

  const attempt = (scale: number, cut: number) => {
    const metrics = metricsFor(scale);
    const available = frame.height;

    const single = planSections(context, model.sections, frame.x, frame.y, frame.width, metrics, cut);

    let columns: { commands: SlideCommand[]; height: number } | null = null;
    if (model.sections.length >= 2) {
      const [first, second] = splitSections(context, model.sections, columnWidth, metrics);
      const left = planSections(context, first, frame.x, frame.y, columnWidth, metrics, cut);
      const right = planSections(
        context,
        second,
        frame.x + columnWidth + COLUMN_GAP,
        frame.y,
        columnWidth,
        metrics,
        cut,
      );

      columns = {
        commands: [...title.commands, ...left.commands, ...right.commands],
        height: Math.max(left.height, right.height),
      };
    }

    return {
      available,
      single: { commands: [...title.commands, ...single.commands], height: single.height },
      columns: columns && { ...columns, height: columns.height },
    };
  };

  for (const scale of SCALES) {
    const planned = attempt(scale, Number.POSITIVE_INFINITY);

    if (planned.single.height <= planned.available) {
      return {
        commands: planned.single.commands,
        figures,
        frame,
        clipped: false,
        sections: model.sections.length,
      };
    }

    if (planned.columns && planned.columns.height <= planned.available) {
      return {
        commands: planned.columns.commands,
        figures,
        frame,
        clipped: false,
        sections: model.sections.length,
      };
    }
  }

  // Nothing fits: smallest type, and whole blocks are dropped at the frame edge
  // instead of being cut in half.
  const final = attempt(SCALES[SCALES.length - 1], limit);

  return {
    commands: (final.columns ?? final.single).commands,
    figures,
    frame,
    clipped: true,
    sections: model.sections.length,
  };
}

function roundedRect(
  context: RasterContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const corner = Math.max(0, Math.min(radius, width / 2, height / 2));

  context.beginPath();
  context.moveTo(x + corner, y);
  context.lineTo(x + width - corner, y);
  context.arcTo(x + width, y, x + width, y + corner, corner);
  context.lineTo(x + width, y + height - corner);
  context.arcTo(x + width, y + height, x + width - corner, y + height, corner);
  context.lineTo(x + corner, y + height);
  context.arcTo(x, y + height, x, y + height - corner, corner);
  context.lineTo(x, y + corner);
  context.arcTo(x, y, x + corner, y, corner);
  context.closePath();
}

/** Paints a planned slide on top of the background. */
export function drawLayout(context: RasterContext, layout: SlideLayout): void {
  // The pictures are drawn first and outside the text clipping area: they are
  // placed on the slide, not inside the flow of the transcription.
  for (const placed of layout.figures) drawFigure(context, placed);

  context.save();
  context.textBaseline = "top";
  // The title lives above the content frame, so the clip is the whole free
  // area of the template: what gets cut is what falls off the slide, not what
  // sits above the first line of the transcription.
  const clip = figureFrame();
  context.beginPath();
  context.rect(clip.x, clip.y, clip.width, clip.height);
  context.clip();

  for (const command of layout.commands) {
    switch (command.kind) {
      case "text":
        context.font = command.font;
        context.fillStyle = command.color;
        context.fillText(command.text, command.x, command.y);
        break;

      case "rect":
        context.save();
        if (command.radius !== undefined) {
          roundedRect(context, command.x, command.y, command.width, command.height, command.radius);
        } else {
          context.beginPath();
          context.rect(command.x, command.y, command.width, command.height);
        }
        if (command.fill) {
          context.fillStyle = command.fill;
          context.fill();
        }
        if (command.stroke) {
          context.strokeStyle = command.stroke;
          context.lineWidth = 1;
          context.stroke();
        }
        context.restore();
        break;

      case "line":
        context.save();
        context.strokeStyle = command.color;
        context.lineWidth = command.width;
        context.beginPath();
        context.moveTo(command.x1, command.y1);
        context.lineTo(command.x2, command.y2);
        context.stroke();
        context.restore();
        break;

      case "math": {
        const formula = layoutMath(context, command.tex, command.size);
        drawMath(context, formula, command.x, command.y, command.color);
        break;
      }

      default:
        break;
    }
  }

  context.restore();
}

/**
 * Paints one recreated picture where the original slide had it.
 *
 * When the model could not redraw it, the area is not left blank: a labelled
 * panel shows that a visual element belongs there, so the rebuilt slide still
 * tells the truth about the original layout.
 */
function drawFigure(context: RasterContext, placed: PlacedFigure): void {
  const { rect, image, figure } = placed;

  context.save();

  if (image) {
    context.imageSmoothingEnabled = true;
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    context.restore();
    return;
  }

  context.fillStyle = COLORS.panel;
  roundedRect(context, rect.x, rect.y, rect.width, rect.height, 18);
  context.fill();
  context.strokeStyle = COLORS.panelBorder;
  context.lineWidth = 2;
  context.stroke();

  const size = Math.max(14, Math.min(30, Math.round(rect.height * 0.07)));
  context.fillStyle = COLORS.faint;
  context.font = `600 ${size}px "${FONTS.sans}"`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    figure.kind.replace(/-/g, " "),
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  );

  context.restore();
}

