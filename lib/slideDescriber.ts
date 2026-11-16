import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

import { figuresFromLegacyText, parseFiguresBlock, type SlideFigure } from "@/lib/slideFigures";
import type { LayoutFinding, SlideLayoutElement } from "@/lib/types";

/**
 * One slide in, three things out: the Markdown of its real content, the
 * pictures it contains (with the area each one occupies), and the inventory of
 * the page furniture (headers, footers, logos, page numbers, author names,
 * dates, …) that must stay out of that Markdown.
 *
 * There is deliberately no JSON schema: the model answers with sentinel
 * delimited blocks, which survive long code listings and tables far better than
 * escaped JSON. Only the picture inventory is JSON, because it carries numbers.
 * The prompt is generic, so it does not change with the kind of material being
 * uploaded.
 */

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-flash";
const REQUEST_TIMEOUT_MS = 120_000;
/** A dense slide (code + two tables + figure inventory) stays under this. */
const MAX_ANSWER_TOKENS = 5000;
/** The deck-level summary is short; a slow answer must not hold the run. */
const SUMMARY_TIMEOUT_MS = 60_000;
/** Extra attempts when the model answers with nothing at all. */
const EMPTY_ANSWER_RETRIES = 2;

const SYSTEM_PROMPT = [
  "You are a faithful slide transcriber.",
  "For every slide you separate the real content from the visual elements and from the page furniture: you transcribe the content, you report every picture with the area it occupies, and you list the marginal, repeated or sequential elements that are not content.",
  "You never summarise the content, never invent and never omit it.",
  "You write in the language of the slide.",
].join(" ");

const USER_PROMPT = `Read this slide and answer in exactly this format, with no other text before or after it:

<<<CONTENT>>>
<Markdown transcription of the slide content only>
<<<FIGURES>>>
<one JSON array with every visual element of the slide>
<<<LAYOUT>>>
<page-furniture elements, one per line, as POSITION | KIND | TEXT>
<<<END>>>

PART 1 — CONTENT
- Transcribe everything that carries the message of this slide: title, body text, lists, indentation, line breaks, code, tables, formulas, captions.
- Write the content in its natural reading order. Do NOT write section headings: no "Testo", "Codice", "Tabelle", "Formule", "Immagini e layout", no "## …" label of any kind and no label in front of a block.
- Start with "# <title>" using the slide title verbatim (use "# Slide" when the slide has no title).
- Tables: real Markdown tables with the real number of rows and columns, header row included.
- Code: a fenced block with the language when recognisable, line breaks and indentation preserved exactly.
- Formulas: LaTeX.
- Pictures, diagrams, charts, screenshots: do NOT describe them here and do NOT repeat the text printed inside them here; they belong to PART 2.
- Page furniture must NOT appear in this part, not even as a first line: it belongs to PART 3.
- No summary, no commentary, nothing that is not on the slide.

PART 2 — FIGURES
List every visual element of the slide — picture, photo, diagram, scheme, flow chart, graph, plot, screenshot, map — as one JSON array and nothing else:
[
  {
    "id": "figura-1",
    "position": "middle-left",
    "kind": "diagram",
    "left": 0.03,
    "top": 0.22,
    "width": 0.42,
    "height": 0.55,
    "description": "what the element shows, precisely enough to draw it again",
    "labels": ["every text printed inside the element"],
    "palette": ["#1b3c5f", "#5c8dc6"]
  }
]
- left, top, width and height locate the element on the SLIDE, as fractions from 0 to 1 (0 is the left/top edge, 1 the right/bottom edge). Measure them carefully: they decide where the element is placed on the rebuilt slide.
- description: the shapes and their arrangement, arrows, axes, series, colours, relative sizes. Enough for someone who only reads it to draw the element again. Never describe the text around the element.
- labels: the text printed inside the element, verbatim, in reading order, title, axis labels, legend and captions included. An element with no text has an empty list.
- palette: at most five dominant colours of the element, as hex.
- A slide with several elements has several separate objects, each with its own coordinates: never merge them, never reuse the same box, never cover the whole slide with one box when the elements are in different areas.
- If the slide has no visual element, write [].

PART 3 — LAYOUT
List every element that is page furniture rather than content: anything that would still be there — identical or merely counted — on other slides of the same document.
- running headers and footers, course or section titles repeated on every slide;
- logos, crests, institutional or department marks, brand marks;
- course name, professor/author/supervisor names, emails, contacts, social handles;
- page numbers, "n/N" counters, slide numbers, dates, revision codes, confidentiality or legal notices;
- watermarks, background graphics, decorative shapes, rules, borders, frames, progress bars, navigation icons, QR codes;
- any text or graphic in the margins (top, bottom, left, right) that is not needed to understand this slide.
Rules:
- An element that is genuinely part of the message stays in CONTENT and is not listed here: on a cover slide, for example, the course name is the title.
- If the same element appears on several slides, list it on each slide so the repetition can be measured, and keep the wording stable across slides.
- For sequential elements (page numbers, counters, dates) copy the value exactly as printed on this slide.
- Write one element per line as POSITION | KIND | TEXT.
  POSITION: top-left, top-center, top-right, middle-left, middle-right, bottom-left, bottom-center, bottom-right, background, full-width.
  KIND: a short lowercase label such as running-header, running-footer, logo, institution, author, contact, page-number, counter, date, revision, confidentiality, watermark, background, decoration, border, progress, navigation, qr-code, other.
  TEXT: the exact text without quotes; for a pure graphic use a short bracketed description such as [crest of Politecnico di Torino].
- If the slide has no page furniture, write NONE on a single line.`;

const LAYOUT_SYSTEM_PROMPT = [
  "You are a layout analyst.",
  "You receive the page furniture detected on the slides of one document and you write a terse Markdown summary of it.",
  "You group the same element described in different words, you state how often it appears and you recognise sequential elements.",
  "You never invent elements and you never describe the slide content.",
].join(" ");

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

/** Module-level client, as required by the DeepSeek integration. */
const client = apiKey
  ? new OpenAI({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      // Rate limits and hiccups are retried by the SDK before a slide is lost.
      maxRetries: 2,
    })
  : null;

/** Thrown when a slide cannot be described. `fatal` aborts the whole run. */
export class DescriberError extends Error {
  readonly fatal: boolean;

  constructor(message: string, fatal: boolean) {
    super(message);
    this.name = "DescriberError";
    this.fatal = fatal;
  }
}

export function isDescriberConfigured(): boolean {
  return client !== null;
}

export interface DescribeSlideInput {
  /** Full-size JPEG of the slide as a data URL. */
  image: string;
  /** 1-based slide number. */
  index: number;
  total: number;
}

export interface SlideDescription {
  /** Markdown of the slide content, page furniture excluded. */
  markdown: string;
  /** Pictures, diagrams, charts and screenshots to recreate on the rebuilt slide. */
  figures: SlideFigure[];
  /** Marginal, repeated or sequential elements kept out of `markdown`. */
  layout: SlideLayoutElement[];
  usedAI: boolean;
}

/** Sends one slide picture to the vision model and splits content from furniture. */
export async function describeSlide(input: DescribeSlideInput): Promise<SlideDescription> {
  if (!client) {
    throw new DescriberError(
      "DEEPSEEK_API_KEY is not configured: the slide analysis needs the vision model.",
      true,
    );
  }

  const content: ChatCompletionContentPart[] = [
    {
      type: "text",
      text: `${USER_PROMPT}\n\nThis is slide ${input.index} of ${input.total}.`,
    },
    { type: "image_url", image_url: { url: input.image } },
  ];

  try {
    // The model occasionally answers with nothing at all. It is not a
    // configuration problem — the same slide usually works on a second try —
    // so the call is repeated before the slide is reported as failed.
    for (let attempt = 0; attempt <= EMPTY_ANSWER_RETRIES; attempt += 1) {
      const completion = await client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        temperature: attempt === 0 ? 0.1 : 0.35,
        max_tokens: MAX_ANSWER_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
      });

      const answer = completion.choices[0]?.message?.content?.trim();

      if (!answer) {
        console.warn(
          `Slide ${input.index}: empty answer, retrying (${attempt + 1}/${EMPTY_ANSWER_RETRIES}).`,
        );
        continue;
      }

      const parsed = parseSlideAnswer(answer);
      if (!parsed.markdown.trim()) {
        console.warn(
          `Slide ${input.index}: empty transcription, retrying (${attempt + 1}/${EMPTY_ANSWER_RETRIES}).`,
        );
        continue;
      }

      return { ...parsed, usedAI: true };
    }

    throw new DescriberError(
      "The model returned an empty answer (3 attempts).",
      false,
    );
  } catch (error) {
    if (error instanceof DescriberError) throw error;
    throw new DescriberError(describeApiFailure(error), isFatalFailure(error));
  }
}

const CONTENT_MARKER = /<{2,}\s*CONTENT\s*>{2,}/i;
const FIGURES_MARKER = /<{2,}\s*FIGURES\s*>{2,}/i;
const LAYOUT_MARKER = /<{2,}\s*LAYOUT\s*>{2,}/i;
const END_MARKER = /<{2,}\s*END\s*>{2,}/i;
/** Whatever closes CONTENT, whether the figure block is there or not. */
const CONTENT_END_MARKER = /<{2,}\s*(?:FIGURES|LAYOUT)\s*>{2,}/i;

/** Section labels the model still likes to put in front of a block. */
const LEGACY_LABEL = /^(testo|text|contenuto|content|codice|code|tabelle?|tables?|formule|formulas?|immagini(\s+e\s+layout)?|figure|figures|layout)$/i;
/** Section labels that introduce a description of the pictures. */
const LEGACY_FIGURE_LABEL = /^(immagini(\s+e\s+layout)?|figure|figures|layout)$/i;

/** Splits the three sentinel-delimited blocks out of the model answer. */
function parseSlideAnswer(answer: string): Omit<SlideDescription, "usedAI"> {
  const text = answer.replace(/\r\n?/g, "\n").trim();
  const hasMarkers =
    CONTENT_MARKER.test(text) || FIGURES_MARKER.test(text) || LAYOUT_MARKER.test(text);

  if (!hasMarkers) {
    // The model ignored the format: keep the answer as content instead of
    // throwing a useful transcription away.
    const { markdown, legacyFigureText } = normalizeContent(stripFences(text));

    return {
      markdown: markdown || "# Slide",
      figures: figuresFromLegacyText(legacyFigureText),
      layout: [],
    };
  }

  const contentPart = CONTENT_MARKER.test(text)
    ? cutSection(text, CONTENT_MARKER, CONTENT_END_MARKER)
    : text.slice(0, firstMarkerIndex(text));
  const figuresPart = FIGURES_MARKER.test(text)
    ? cutSection(text, FIGURES_MARKER, LAYOUT_MARKER)
    : "";
  const layoutPart = LAYOUT_MARKER.test(text) ? cutSection(text, LAYOUT_MARKER, END_MARKER) : "";

  const layout = parseLayout(layoutPart);
  const { markdown, legacyFigureText } = normalizeContent(stripFences(contentPart));
  const body = removeLeakedFurniture(markdown, layout);

  // A model that ignored the figure block usually still described the pictures
  // under the old "Immagini e layout" heading: that text becomes one figure.
  const figures = parseFiguresBlock(figuresPart);
  const resolved = figures.length > 0 ? figures : figuresFromLegacyText(legacyFigureText);

  return {
    markdown: removeFigureLabels(body, resolved) || "# Slide",
    figures: resolved,
    layout,
  };
}

/**
 * Text printed inside a picture is part of the picture.
 *
 * The model is told to leave it out of CONTENT, but it often transcribes a
 * chart title or the labels of a diagram anyway. The picture is redrawn with
 * that text inside it, so the duplicate line would print twice: a standalone
 * line that is exactly one of the labels of a figure is dropped. Headings are
 * never touched, so a title that happens to repeat a label stays.
 */
function removeFigureLabels(markdown: string, figures: SlideFigure[]): string {
  const labels = new Set(
    figures
      .flatMap((figure) => figure.labels)
      .map(figureLabelKey)
      .filter((label) => label.length >= 3),
  );
  if (labels.size === 0) return markdown;

  const kept = markdown.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    return !labels.has(figureLabelKey(trimmed));
  });

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function figureLabelKey(value: string): string {
  return normalizeLine(value).replace(/[.;:,]+$/, "");
}

function firstMarkerIndex(text: string): number {
  const positions = [CONTENT_MARKER, FIGURES_MARKER, LAYOUT_MARKER]
    .map((marker) => text.search(marker))
    .filter((position) => position >= 0);

  return positions.length > 0 ? Math.min(...positions) : text.length;
}

interface NormalizedContent {
  /** Content without the section labels the model adds on top of it. */
  markdown: string;
  /** Text that was written under a picture/layout label, if any. */
  legacyFigureText: string;
}

/**
 * Drops `## Testo`, `## Codice`, `## Immagini e layout` and friends.
 *
 * They are the model's own scaffolding, not content: keeping them would print a
 * section header that is not on the original slide. Whatever sits under a
 * picture label is collected separately, as a fallback figure description.
 */
function normalizeContent(value: string): NormalizedContent {
  const kept: string[] = [];
  const figureLines: string[] = [];
  let collectingFigures = false;

  for (const line of value.split("\n")) {
    const heading = /^\s*#{2,6}\s*(.+?)\s*#*\s*$/.exec(line);
    const bold = /^\s*[*_]{2}([^*_]{2,40})[*_]{2}\s*:?\s*$/.exec(line);
    const label = (heading?.[1] ?? bold?.[1] ?? "").replace(/[*_`]/g, "").trim();

    if (label && LEGACY_LABEL.test(label)) {
      collectingFigures = LEGACY_FIGURE_LABEL.test(label);
      continue;
    }

    // A real heading of the slide ends the collected picture text.
    if (collectingFigures && heading) {
      collectingFigures = false;
      kept.push(line);
      continue;
    }

    if (collectingFigures) {
      if (line.trim()) figureLines.push(line.trim());
      continue;
    }

    kept.push(line);
  }

  const markdown = kept
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { markdown, legacyFigureText: figureLines.join(" ") };
}

function cutSection(text: string, from: RegExp, to: RegExp): string {
  const start = text.search(from);
  if (start === -1) return "";

  const rest = text.slice(start).replace(from, "");
  const end = rest.search(to);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function stripFences(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)\n```\s*$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function parseLayout(section: string): SlideLayoutElement[] {
  const elements: SlideLayoutElement[] = [];
  const seen = new Set<string>();

  for (const rawLine of section.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("```")) continue;

    line = line.replace(/^[-*•·]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (!line || /^none\b/i.test(line)) continue;

    const parts = line.split("|").map((part) => part.trim());

    if (parts.length === 1) {
      elements.push({ position: "unknown", kind: "other", text: unquote(parts[0]) });
      continue;
    }

    const position = canonicalPosition(parts[0]);
    const kind = parts.length >= 3 ? canonicalKind(parts[1]) : "other";
    const text = unquote(parts.length >= 3 ? parts.slice(2).join(" | ") : parts[1]);

    // A line with neither a label nor a description carries no information.
    if (!text && kind === "other") continue;

    const key = `${position}|${kind}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({ position, kind, text });

    if (elements.length >= 40) break;
  }

  return elements;
}

function unquote(value: string): string {
  return value.replace(/^[`"“”'«»]+/, "").replace(/[`"“”'«»]+$/, "").trim();
}

const CANONICAL_POSITIONS = new Set([
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "background",
  "full-width",
]);

function canonicalPosition(value: string): string {
  const position = value
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+|[^a-z-]+$/g, "");

  if (CANONICAL_POSITIONS.has(position)) return position;

  const vertical = /top|header|above/.test(position)
    ? "top"
    : /bottom|footer|below/.test(position)
      ? "bottom"
      : /middle|center|centre/.test(position)
        ? "middle"
        : "";
  const horizontal = /left/.test(position)
    ? "left"
    : /right/.test(position)
      ? "right"
      : /center|centre|middle/.test(position)
        ? "center"
        : "";

  if (vertical && horizontal) return `${vertical}-${horizontal}`;
  if (/background/.test(position)) return "background";
  if (/full|across|entire/.test(position)) return "full-width";
  return position || "unknown";
}

const KIND_SYNONYMS: Record<string, string> = {
  header: "running-header",
  headers: "running-header",
  "page-header": "running-header",
  heading: "running-header",
  footer: "running-footer",
  footers: "running-footer",
  "page-footer": "running-footer",
  "page-number": "page-number",
  "page-numbers": "page-number",
  pagenumber: "page-number",
  pagination: "page-number",
  numbering: "page-number",
  number: "page-number",
  "slide-number": "page-number",
  "slide-numbers": "page-number",
  professor: "author",
  teacher: "author",
  lecturer: "author",
  "author-name": "author",
  logo: "logo",
  logos: "logo",
  logotype: "logo",
  crest: "logo",
  emblem: "logo",
  brand: "logo",
  "brand-mark": "logo",
};

function canonicalKind(value: string): string {
  const kind = value
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (KIND_SYNONYMS[kind] ?? kind) || "other";
}

/**
 * Safety net: if the model listed an element as furniture but also left it as a
 * standalone line of the content, the line is dropped. Headings are never
 * touched, so a cover slide keeps its title even when the title is the course
 * name.
 */
function removeLeakedFurniture(markdown: string, layout: SlideLayoutElement[]): string {
  const furniture = new Set(
    layout.map((element) => normalizeLine(element.text)).filter((text) => text.length >= 3),
  );
  if (furniture.size === 0) return markdown;

  const kept = markdown.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    return !furniture.has(normalizeLine(trimmed));
  });

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeLine(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[\s>*+\-–—•·]+/, "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface LayoutSummaryInput {
  fileName: string;
  findings: LayoutFinding[];
}

/**
 * Second, text-only pass over the whole deck: a per-slide call only sees one
 * slide, so it cannot tell that the header of slide 3 is the header of slide 17.
 * The deterministic aggregation has already merged and counted the findings;
 * this call names the patterns and writes the summary the user reads.
 *
 * Returns null when the call fails: the summary is a bonus and must never
 * invalidate the transcription.
 */
export async function refineLayoutSummary(input: LayoutSummaryInput): Promise<string | null> {
  if (!client || input.findings.length === 0) return null;

  const inventory = input.findings
    .slice(0, 80)
    .map((finding) => {
      const where =
        finding.slides.length === 1
          ? `slide ${finding.slides[0]}`
          : `${finding.slides.length} slides`;
      const value = finding.sequential
        ? `values ${finding.values[0]} … ${finding.values[finding.values.length - 1]}`
        : finding.text
          ? `text ${finding.text}`
          : "graphic without text";

      return `- ${finding.kind} | ${finding.position} | ${value} | ${where}`;
    })
    .join("\n");

  try {
    const completion = await client.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: "system", content: LAYOUT_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `Document: "${input.fileName}".`,
              "Each line is: KIND | POSITION | TEXT/VALUES | OCCURRENCES.",
              "",
              inventory,
              "",
              'Write a Markdown summary with the exact heading "## Layout and recurring elements" and nothing else.',
              "- One bullet per element, after grouping the lines that describe the same thing even when the wording differs.",
              "- Say what the element is, where it sits and on how many slides it appears.",
              "- Say explicitly which elements are sequential (their text changes from slide to slide, e.g. page numbers: give the first and last value) and which are static.",
              "- Mention the one-off marginal elements in a final short line.",
              "- Do not invent elements, do not describe the slide content, no preamble and no closing remarks.",
            ].join("\n"),
          },
        ],
      },
      { timeout: SUMMARY_TIMEOUT_MS },
    );

    const summary = completion.choices[0]?.message?.content?.trim();
    if (!summary) return null;

    return summary.startsWith("## ")
      ? summary
      : `## Layout and recurring elements\n\n${summary}`;
  } catch {
    return null;
  }
}

/**
 * A wrong key, a missing model or an empty wallet would fail on every slide:
 * aborting is cheaper and clearer than 60 identical errors.
 */
function isFatalFailure(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 422
  );
}

function describeApiFailure(error: unknown): string {
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : "unknown error";

  // The DeepSeek balance ran out mid-deck: the wording has to say what to do.
  if (status === 402) {
    return [
      "The DeepSeek account has no credit left (HTTP 402 Insufficient Balance), so no further slide can be transcribed.",
      "Top up the balance at platform.deepseek.com, then analyze the material again.",
      "The slides already transcribed are kept.",
    ].join(" ");
  }

  return status ? `The vision model rejected the request (HTTP ${status}): ${message}` : message;
}

export interface BalanceCheck {
  available: boolean;
  message?: string;
}

/**
 * Pre-flight check against the DeepSeek balance endpoint.
 *
 * A zero balance is not a per-slide problem: without this check the whole deck
 * fails slide by slide with the same 402 error. Returns null when the check
 * itself is unavailable, so the analysis can still be attempted.
 */
export async function checkModelBalance(): Promise<BalanceCheck | null> {
  if (!apiKey) return null;

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      is_available?: boolean;
      balance_infos?: { currency?: string; total_balance?: string }[];
    };
    const info = data.balance_infos?.[0];
    const total = Number(info?.total_balance ?? "0");

    if (data.is_available === false || !Number.isFinite(total) || total <= 0) {
      const balance = info ? `${info.total_balance ?? "0"} ${info.currency ?? "USD"}` : "empty";

      return {
        available: false,
        message:
          `The DeepSeek account cannot be used: the balance is ${balance}. ` +
          "Top up at platform.deepseek.com, then analyze the material again.",
      };
    }

    return { available: true };
  } catch {
    return null;
  }
}
