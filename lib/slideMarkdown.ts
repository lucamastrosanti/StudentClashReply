/**
 * Turns the Markdown transcription of one slide into the block model the
 * renderer lays out.
 *
 * This is not a general-purpose Markdown parser: it understands exactly the
 * dialect the transcriber is asked to produce (one `#` title, `##` sections,
 * lists, tables, fenced code, quotes, plain paragraphs) and it is deliberately
 * dependency-free, so the same module can be used everywhere.
 */

/** A piece of text with one inline style applied. */
export interface SlideRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Inline formula, already turned into readable Unicode. */
  math?: boolean;
}

export interface SlideListItem {
  runs: SlideRun[];
  /** `1.`, `2.`, … for ordered lists, `null` for bullets. */
  marker: string | null;
  /** Nesting depth: 0 for top level. */
  level: number;
}

export type SlideBlock =
  | { type: "paragraph"; runs: SlideRun[] }
  | { type: "list"; items: SlideListItem[] }
  | { type: "code"; language: string; lines: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "quote"; runs: SlideRun[] }
  /** A description of a picture that cannot be redrawn: shown as a panel. */
  | { type: "figure"; runs: SlideRun[] }
  | { type: "rule" };

export type SlideSectionKind = "text" | "code" | "table" | "formula" | "figure" | "other";

export interface SlideSection {
  kind: SlideSectionKind;
  heading: SlideRun[] | null;
  blocks: SlideBlock[];
}

export interface SlideModel {
  title: SlideRun[];
  sections: SlideSection[];
  /** Blocks found in the transcription, title excluded. */
  blocks: number;
  /** True when the transcription carries nothing to lay out. */
  empty: boolean;
}

/** Slides the vision model could not read carry this sentence instead of content. */
const UNAVAILABLE = "the description is not available";


/**
 * False for the placeholder written when the vision model failed: those slides
 * have no content to rebuild, so the rebuild step leaves them out.
 */
export function hasSlideContent(markdown: string): boolean {
  const text = markdown.trim();
  if (text.length === 0) return false;
  if (text.toLowerCase().includes(UNAVAILABLE)) return false;

  return !parseSlideMarkdown(markdown).empty;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*```+\s*([\w+#.-]*)\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;

export function parseSlideMarkdown(markdown: string): SlideModel {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sections: SlideSection[] = [];
  let title: SlideRun[] | null = null;
  let current: SlideSection | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];

  const ensureSection = (): SlideSection => {
    if (current) return current;
    current = { kind: "text", heading: null, blocks: [] };
    sections.push(current);
    return current;
  };

  const startSection = (kind: SlideSectionKind, heading: SlideRun[] | null): SlideSection => {
    current = { kind, heading, blocks: [] };
    sections.push(current);
    return current;
  };

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;

    const runs = parseInline(paragraph.join(" ").trim());
    paragraph = [];
    if (runs.length === 0) return;

    const section = ensureSection();
    section.blocks.push(
      section.kind === "figure" ? { type: "figure", runs } : { type: "paragraph", runs },
    );
  };

  const flushQuote = (): void => {
    if (quote.length === 0) return;

    const runs = parseInline(quote.join(" ").trim());
    quote = [];
    if (runs.length > 0) ensureSection().blocks.push({ type: "quote", runs });
  };

  const flush = (): void => {
    flushParagraph();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\s+$/, "");

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();

      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i].replace(/\s+$/, ""));
        i += 1;
      }

      ensureSection().blocks.push({
        type: "code",
        language: fence[1] ?? "",
        lines: trimBlankLines(body),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();

      const depth = heading[1].length;
      const runs = parseInline(heading[2]);

      if (depth === 1 && title === null && sections.length === 0) {
        title = runs;
      } else {
        startSection(kindOfHeading(heading[2]), runs);
      }
      continue;
    }

    if (RULE.test(line)) {
      flush();
      ensureSection().blocks.push({ type: "rule" });
      continue;
    }

    const quoteLine = /^\s*>\s?(.*)$/.exec(line);
    if (quoteLine) {
      flushParagraph();
      quote.push(quoteLine[1]);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      flush();

      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;

      while (i < lines.length && lines[i].includes("|") && lines[i].trim().length > 0) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      // The loop stops on the first line that is not a row: let the outer loop
      // read it again.
      i -= 1;

      if (header.length > 0) ensureSection().blocks.push({ type: "table", header, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();

      const items: SlideListItem[] = [];
      const section = ensureSection();

      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i].replace(/\s+$/, ""));
        if (match) {
          const indent = match[1].replace(/\t/g, "    ").length;
          const marker = /\d/.test(match[2]) ? match[2] : null;

          items.push({
            runs: parseInline(match[3].trim()),
            marker,
            level: Math.min(2, Math.floor(indent / 2)),
          });
          i += 1;
          continue;
        }

        // An indented line that is not a new item continues the previous one.
        const continuation = lines[i].replace(/\s+$/, "");
        if (continuation.trim().length > 0 && /^\s{2,}/.test(continuation) && items.length > 0) {
          const last = items[items.length - 1];
          last.runs = parseInline(`${runsToPlainText(last.runs)} ${continuation.trim()}`.trim());
          i += 1;
          continue;
        }

        break;
      }

      i -= 1;
      section.blocks.push({ type: "list", items });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();

  const usable = sections.filter((section) => section.heading !== null || section.blocks.length > 0);
  const blocks = usable.reduce((count, section) => count + section.blocks.length, 0);

  const titleText = runsToPlainText(title ?? []).trim();
  // A section divider that carries nothing but its title is still content; the
  // generic "Slide 7" heading of an empty page is not.
  const meaningfulTitle =
    titleText.length > 0 && !/^(slide|diapositiva|pagina|page)\s*\d*$/i.test(titleText);

  return {
    title: title ?? [],
    sections: usable,
    blocks,
    empty: blocks === 0 && !meaningfulTitle,
  };
}

function kindOfHeading(heading: string): SlideSectionKind {
  const text = heading.toLowerCase();

  if (/(codice|code|snippet|script|frammento)/.test(text)) return "code";
  if (/(tabelle|tabella|table|matrice)/.test(text)) return "table";
  if (/(formul|equation|equazion|math|matematic)/.test(text)) return "formula";
  if (/(immagin|image|figur|layout|diagram|grafic|chart|schema)/.test(text)) return "figure";

  return "text";
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buffer = "";

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === "\\" && trimmed[i + 1] === "|") {
      buffer += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }

  cells.push(buffer.trim());
  return cells;
}


/** Inline Markdown → styled runs. */
export function parseInline(input: string): SlideRun[] {
  const runs: SlideRun[] = [];
  let buffer = "";
  let i = 0;

  const push = (run: SlideRun): void => {
    if (run.text.length === 0) return;
    runs.push(run);
  };

  const flush = (): void => {
    if (buffer.length === 0) return;
    push({ text: buffer });
    buffer = "";
  };

  while (i < input.length) {
    const char = input[i];

    if (char === "\\" && i + 1 < input.length) {
      buffer += input[i + 1];
      i += 2;
      continue;
    }

    if (char === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        push({ text: input.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const end = findEmphasis(input, i, char);

      if (end !== -1) {
        const length = input[i + 1] === char ? 2 : 1;
        flush();

        for (const run of parseInline(input.slice(i + length, end))) {
          push(length === 2 ? { ...run, bold: true } : { ...run, italic: true });
        }

        i = end + length;
        continue;
      }
    }

    if (char === "[") {
      const close = input.indexOf("](", i + 1);
      const end = close === -1 ? -1 : input.indexOf(")", close);
      if (close !== -1 && end !== -1) {
        flush();
        for (const run of parseInline(input.slice(i + 1, close))) push(run);
        i = end + 1;
        continue;
      }
    }

    if (char === "$") {
      const end = input.indexOf("$", i + 1);
      if (end > i + 1) {
        flush();
        push({ text: simplifyMath(input.slice(i + 1, end)), math: true });
        i = end + 1;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }

  flush();
  return runs;
}

export function runsToPlainText(runs: SlideRun[]): string {
  return runs.map((run) => run.text).join("");
}

/**
 * Finds the closing marker of an emphasis span, or -1 when there is none.
 *
 * `_` only opens emphasis at a word boundary: `3-SQL_operatori_insiemistici`
 * is a file name, not an italic word, and such titles are common in decks.
 */
function findEmphasis(input: string, start: number, marker: string): number {
  const doubled = input[start + 1] === marker;
  const openLength = doubled ? 2 : 1;

  if (marker === "_" && start > 0 && /[A-Za-z0-9]/.test(input[start - 1])) return -1;

  const token = doubled ? marker + marker : marker;
  const end = input.indexOf(token, start + openLength);
  if (end <= start + openLength) return -1;

  if (marker === "_" && /[A-Za-z0-9]/.test(input[end + openLength] ?? "")) return -1;

  return end;
}

const MATH_SYMBOLS: [string, string][] = [
  ["\\alpha", "α"], ["\\beta", "β"], ["\\gamma", "γ"], ["\\delta", "δ"], ["\\Delta", "Δ"],
  ["\\epsilon", "ε"], ["\\varepsilon", "ε"], ["\\zeta", "ζ"], ["\\eta", "η"], ["\\theta", "θ"],
  ["\\lambda", "λ"], ["\\mu", "μ"], ["\\nu", "ν"], ["\\xi", "ξ"], ["\\pi", "π"], ["\\rho", "ρ"],
  ["\\sigma", "σ"], ["\\Sigma", "Σ"], ["\\tau", "τ"], ["\\phi", "φ"], ["\\varphi", "φ"],
  ["\\chi", "χ"], ["\\psi", "ψ"], ["\\omega", "ω"], ["\\Omega", "Ω"], ["\\Gamma", "Γ"],
  ["\\Theta", "Θ"], ["\\Lambda", "Λ"], ["\\Pi", "Π"], ["\\Phi", "Φ"], ["\\Psi", "Ψ"],
  ["\\sum", "Σ"], ["\\prod", "Π"], ["\\int", "∫"], ["\\oint", "∮"], ["\\infty", "∞"],
  ["\\partial", "∂"], ["\\nabla", "∇"], ["\\forall", "∀"], ["\\exists", "∃"],
  ["\\leq", "≤"], ["\\le", "≤"], ["\\geq", "≥"], ["\\ge", "≥"], ["\\neq", "≠"], ["\\ne", "≠"],
  ["\\approx", "≈"], ["\\equiv", "≡"], ["\\times", "×"], ["\\cdot", "·"], ["\\div", "÷"],
  ["\\pm", "±"], ["\\to", "→"], ["\\rightarrow", "→"], ["\\Rightarrow", "⇒"], ["\\leftarrow", "←"],
  ["\\in", "∈"], ["\\notin", "∉"], ["\\subset", "⊂"], ["\\subseteq", "⊆"], ["\\cup", "∪"],
  ["\\cap", "∩"], ["\\emptyset", "∅"], ["\\sqrt", "√"], ["\\ldots", "…"], ["\\dots", "…"],
  ["\\quad", "  "], ["\\qquad", "    "], ["\\left", ""], ["\\right", ""], ["\\text", ""],
  ["\\mathrm", ""], ["\\mathbf", ""], ["\\mathbb", ""], ["\\mathcal", ""], ["\\,", ""],
  ["\\;", ""], ["\\:", ""], ["\\!", ""], ["\\ ", " "],
];

/** LaTeX is not typeset here: the common commands become readable symbols. */
export function simplifyMath(formula: string): string {
  let text = formula;

  for (const [command, symbol] of MATH_SYMBOLS) {
    text = text.split(command).join(symbol);
  }

  return text
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

