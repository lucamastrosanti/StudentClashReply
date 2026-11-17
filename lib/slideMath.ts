/**
 * Typesets the LaTeX subset a slide transcription uses.
 *
 * A formula is not a string of characters: a fraction is a numerator over a
 * denominator, a sum carries its limits, a root carries a radical. The old
 * renderer deleted the commands and printed what was left (`\frac{a}{b}`
 * becoming `ab`), which is why formulas looked like code. This module parses
 * the expression and lays it out as positioned glyphs, rules and lines, so the
 * slide shows a formula and not its source.
 *
 * It is deliberately not a TeX engine: it knows the commands that appear in
 * lecture material (fractions, scripts, roots, sums, matrices, Greek letters,
 * operators, `\text`) and it gives every unknown command back as readable text
 * instead of dropping it.
 */

import { FONTS } from "./slideTheme";

type RasterContext = import("@napi-rs/canvas").SKRSContext2D;

/* -------------------------------------------------------------------------- */
/* The expression                                                             */
/* -------------------------------------------------------------------------- */

export type MathNode =
  | { kind: "run"; text: string; italic?: boolean; bold?: boolean }
  | { kind: "text"; text: string; bold?: boolean }
  | { kind: "space"; em: number }
  | { kind: "frac"; num: MathNode[]; den: MathNode[] }
  | { kind: "sqrt"; body: MathNode[]; index: MathNode[] | null }
  | { kind: "scripts"; base: MathNode; sup: MathNode[] | null; sub: MathNode[] | null }
  | { kind: "op"; text: string; big: boolean; limits: boolean }
  | { kind: "matrix"; rows: MathNode[][][]; open: string; close: string }
  | { kind: "overbar"; body: MathNode[] };

/** Greek letters, operators and relations, as the glyphs a slide can show. */
const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", epsilon: "ε",
  varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", Theta: "Θ", iota: "ι",
  kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", upsilon: "υ", phi: "φ",
  varphi: "φ", Phi: "Φ", chi: "χ", psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω",
  Gamma: "Γ",
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆",
  circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈",
  equiv: "≡", sim: "∼", simeq: "≃", propto: "∝", ll: "≪", gg: "≫",
  to: "→", rightarrow: "→", longrightarrow: "→", Rightarrow: "⇒",
  leftarrow: "←", Leftarrow: "⇐", leftrightarrow: "↔", mapsto: "↦",
  uparrow: "↑", downarrow: "↓",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃",
  supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", varnothing: "∅",
  setminus: "∖", complement: "∁", forall: "∀", exists: "∃", neg: "¬",
  land: "∧", lor: "∨", lnot: "¬",
  infty: "∞", partial: "∂", nabla: "∇", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ",
  angle: "∠", perp: "⊥", parallel: "∥", therefore: "∴", because: "∵",
  ldots: "…", cdots: "⋯", dots: "…", vdots: "⋮", ddots: "⋱",
  prime: "′", degree: "°", S: "§", dagger: "†",
  lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", lfloor: "⌊",
  rfloor: "⌋", lceil: "⌈", rceil: "⌉", vert: "|", Vert: "‖", mid: "|",
  backslash: "∖", "|": "‖", "{": "{", "}": "}",
};

/** Symbols that take a little room on both sides. */
const RELATIONS = new Set(["=", "<", ">", "≤", "≥", "≠", "≈", "≡", "∼", "≃", "∝", "≪", "≫", "∈", "∉", "⊂", "⊆", "⊃", "⊇", "→", "⇒", "←", "⇐", "↔", "↦", "∴", "∵"]);
const BINARY = new Set(["+", "−", "±", "∓", "×", "·", "÷", "∪", "∩", "∖", "⊕", "⊗", "∧", "∨"]);

/** Big operators: the glyph, whether limits sit above and below it by default. */
const BIG_OPS: Record<string, { text: string; limits: boolean }> = {
  sum: { text: "∑", limits: true },
  prod: { text: "∏", limits: true },
  coprod: { text: "∐", limits: true },
  bigcup: { text: "⋃", limits: true },
  bigcap: { text: "⋂", limits: true },
  int: { text: "∫", limits: false },
  iint: { text: "∬", limits: false },
  iiint: { text: "∭", limits: false },
  oint: { text: "∮", limits: false },
};

/** Function names are upright and take a thin space before them. */
const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "dim", "ker", "deg", "arg", "det", "gcd", "Pr"]);
/** Functions whose subscript belongs under them, like a sum's. */
const LIMIT_FUNCTIONS = new Set(["lim", "max", "min", "sup", "inf"]);
/* -------------------------------------------------------------------------- */
/* The parser                                                                 */
/* -------------------------------------------------------------------------- */

interface Style {
  italic?: boolean;
  bold?: boolean;
}

/** Parses one expression into a tree, script by script. */
class Parser {
  private readonly source: string;
  private index = 0;

  constructor(source: string) {
    this.source = source;
  }

  parse(stopAtBrace = false, style: Style = {}): MathNode[] {
    const nodes: MathNode[] = [];

    while (this.index < this.source.length) {
      const char = this.source[this.index];

      if (stopAtBrace && char === "}") {
        this.index += 1;
        break;
      }
      if (/\s/.test(char)) {
        this.index += 1;
        continue;
      }
      if (char === "{") {
        this.index += 1;
        nodes.push(...this.parse(true, style));
        continue;
      }
      if (char === "}") {
        this.index += 1;
        continue;
      }
      if (char === "^" || char === "_") {
        this.attachScript(nodes, style);
        continue;
      }
      if (char === "\\") {
        this.readCommand(nodes, style);
        continue;
      }
      if (char === "&") {
        this.index += 1;
        nodes.push({ kind: "space", em: 0.5 });
        continue;
      }
      if (char === "~") {
        this.index += 1;
        nodes.push({ kind: "space", em: 0.33 });
        continue;
      }
      if (char === "%") {
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index += 1;
        continue;
      }
      if (char === "'") {
        this.index += 1;
        nodes.push({ kind: "run", text: "′" });
        continue;
      }
      if (/[A-Za-z]/.test(char)) {
        this.readLetters(nodes, style);
        continue;
      }
      if (/[0-9]/.test(char)) {
        this.readDigits(nodes);
        continue;
      }

      this.readSymbol(nodes);
    }

    return trimSpaces(nodes);
  }

  private readLetters(nodes: MathNode[], style: Style): void {
    const start = this.index;
    while (this.index < this.source.length && /[A-Za-z]/.test(this.source[this.index])) {
      this.index += 1;
    }
    nodes.push({
      kind: "run",
      text: this.source.slice(start, this.index),
      italic: style.italic ?? true,
      bold: style.bold,
    });
  }

  private readDigits(nodes: MathNode[]): void {
    const start = this.index;
    while (this.index < this.source.length && /[0-9]/.test(this.source[this.index])) {
      this.index += 1;
    }
    // An Italian decimal comma belongs to the number, not to the sentence.
    if (this.source[this.index] === "," && /[0-9]/.test(this.source[this.index + 1] ?? "")) {
      this.index += 1;
      while (this.index < this.source.length && /[0-9]/.test(this.source[this.index])) {
        this.index += 1;
      }
    }
    if (this.source[this.index] === "." && /[0-9]/.test(this.source[this.index + 1] ?? "")) {
      this.index += 1;
      while (this.index < this.source.length && /[0-9]/.test(this.source[this.index])) {
        this.index += 1;
      }
    }
    // Digits are set upright even inside an italic formula: a slanted 1 reads
    // as an l, and LaTeX does the same.
    nodes.push({ kind: "run", text: this.source.slice(start, this.index), italic: false });
  }

  /** One argument: a braced group, a command, or a single character. */
  private readArgument(style: Style): MathNode[] {
    this.skipSpaces();
    if (this.index >= this.source.length) return [];

    const char = this.source[this.index];
    if (char === "{") {
      this.index += 1;
      return this.parse(true, style);
    }
    if (char === "\\") {
      const nodes: MathNode[] = [];
      this.readCommand(nodes, style);
      return nodes;
    }

    this.index += 1;
    if (/[A-Za-z]/.test(char)) {
      return [{ kind: "run", text: char, italic: style.italic ?? true, bold: style.bold }];
    }
    if (/[0-9]/.test(char)) {
      const start = this.index - 1;
      while (/[0-9]/.test(this.source[this.index] ?? "")) this.index += 1;
      return [{ kind: "run", text: this.source.slice(start, this.index), italic: false }];
    }

    return [{ kind: "run", text: char === "-" ? "−" : char }];
  }

  private attachScript(nodes: MathNode[], style: Style): void {
    const isSup = this.source[this.index] === "^";
    this.index += 1;
    const argument = this.readArgument(style);
    const base: MathNode = nodes.length > 0 ? nodes.pop()! : { kind: "run", text: "" };

    if (base.kind === "scripts") {
      nodes.push(isSup ? { ...base, sup: argument } : { ...base, sub: argument });
      return;
    }

    nodes.push({
      kind: "scripts",
      base,
      sup: isSup ? argument : null,
      sub: isSup ? null : argument,
    });
  }

  /** The raw text of a braced group, used by `\text` and environment names. */
  private readRawGroup(): string {
    this.skipSpaces();
    if (this.source[this.index] !== "{") {
      this.index += 1;
      return "";
    }

    let depth = 0;
    const start = this.index + 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const text = this.source.slice(start, this.index);
          this.index += 1;
          return text;
        }
      }
      this.index += 1;
    }

    return this.source.slice(start);
  }

  /** Everything up to the matching `\end{env}`, nested environments included. */
  private readEnvironmentBody(env: string): string {
    const open = `\\begin{${env}}`;
    const close = `\\end{${env}}`;
    const start = this.index;
    let depth = 1;

    while (this.index < this.source.length) {
      if (this.source.startsWith(open, this.index)) {
        depth += 1;
        this.index += open.length;
        continue;
      }
      if (this.source.startsWith(close, this.index)) {
        depth -= 1;
        if (depth === 0) {
          const body = this.source.slice(start, this.index);
          this.index += close.length;
          return body;
        }
        this.index += close.length;
        continue;
      }
      this.index += 1;
    }

    return this.source.slice(start);
  }


  private readSymbol(nodes: MathNode[]): void {
    const char = this.source[this.index];
    this.index += 1;
    const text = char === "-" ? "−" : char === "*" ? "∗" : char;
    pushSpaced(nodes, text);
  }

  private skipSpaces(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) this.index += 1;
  }

  private readName(): string {
    this.index += 1;
    if (this.index >= this.source.length) return "";
    const char = this.source[this.index];

    if (/[A-Za-z]/.test(char)) {
      const start = this.index;
      while (this.index < this.source.length && /[A-Za-z]/.test(this.source[this.index])) {
        this.index += 1;
      }
      return this.source.slice(start, this.index);
    }

    this.index += 1;
    return char;
  }


  /** One command, after the backslash: its name and everything it owns. */
  private readCommand(nodes: MathNode[], style: Style): void {
    const name = this.readName();

    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac":
      case "cfrac": {
        const num = this.readArgument(style);
        const den = this.readArgument(style);
        nodes.push({ kind: "frac", num, den });
        return;
      }
      case "sqrt": {
        let index: MathNode[] | null = null;
        this.skipSpaces();
        if (this.source[this.index] === "[") {
          const start = this.index + 1;
          while (this.index < this.source.length && this.source[this.index] !== "]") this.index += 1;
          index = new Parser(this.source.slice(start, this.index)).parse();
          this.index += 1;
        }
        nodes.push({ kind: "sqrt", body: this.readArgument(style), index });
        return;
      }
      case "text":
      case "textrm":
      case "mbox":
      case "textit":
      case "textbf": {
        nodes.push({
          kind: "text",
          text: this.readRawGroup(),
          bold: name === "textbf",
        });
        return;
      }
      case "operatorname":
      case "mathrm":
      case "mathsf":
      case "mathtt": {
        nodes.push(...this.readArgument({ ...style, italic: false }));
        return;
      }
      case "mathbf":
      case "boldsymbol":
      case "bm": {
        nodes.push(...this.readArgument({ ...style, bold: true }));
        return;
      }
      case "mathit": {
        nodes.push(...this.readArgument({ ...style, italic: true }));
        return;
      }
      case "mathbb":
      case "mathcal":
      case "mathscr": {
        nodes.push({ kind: "text", text: plainNodes(this.readArgument({ ...style, italic: false })) });
        return;
      }
      case "overline":
      case "bar": {
        nodes.push({ kind: "overbar", body: this.readArgument(style) });
        return;
      }
      case "hat":
      case "widehat":
      case "tilde":
      case "widetilde":
      case "vec":
      case "dot":
      case "ddot":
      case "underline":
      case "boxed": {
        nodes.push(...this.readArgument(style));
        return;
      }
      case "left":
      case "right":
      case "big":
      case "Big":
      case "bigg":
      case "Bigg":
      case "bigl":
      case "bigr":
      case "Bigl":
      case "Bigr": {
        this.skipSpaces();
        if (this.source[this.index] === "\\") {
          const delimiter = this.readName();
          if (delimiter !== ".") nodes.push({ kind: "run", text: SYMBOLS[delimiter] ?? delimiter });
          return;
        }
        const delimiter = this.source[this.index];
        this.index += 1;
        if (delimiter && delimiter !== ".") nodes.push({ kind: "run", text: delimiter });
        return;
      }
      case "not": {
        this.skipSpaces();
        const next = this.source[this.index] === "\\" ? SYMBOLS[this.readName()] : this.source[this.index++];
        const negated: Record<string, string> = { "=": "≠", "∈": "∉", "<": "≮", ">": "≯", "≤": "≰", "≥": "≱" };
        nodes.push({ kind: "run", text: negated[next ?? ""] ?? `¬${next ?? ""}` });
        return;
      }
      case "begin": {
        const env = this.readRawGroup().trim();
        if (env === "array") this.readRawGroup();
        const body = this.readEnvironmentBody(env);
        const open =
          env === "pmatrix" ? "(" :
          env === "bmatrix" ? "[" :
          env === "Bmatrix" ? "{" :
          env === "vmatrix" ? "|" :
          env === "Vmatrix" ? "‖" :
          env === "cases" ? "{" : "";
        const close =
          env === "pmatrix" ? ")" :
          env === "bmatrix" ? "]" :
          env === "Bmatrix" ? "}" :
          env === "vmatrix" ? "|" :
          env === "Vmatrix" ? "‖" : "";
        nodes.push({ kind: "matrix", rows: parseMatrixBody(body), open, close });
        return;
      }
      case "end":
        this.readRawGroup();
        return;


      case "\\": {
        nodes.push({ kind: "space", em: 0.4 });
        return;
      }
      case ",":
      case ":":
        nodes.push({ kind: "space", em: 0.18 });
        return;
      case ";":
        nodes.push({ kind: "space", em: 0.25 });
        return;
      case "!":
        nodes.push({ kind: "space", em: -0.12 });
        return;
      case " ":
        nodes.push({ kind: "space", em: 0.25 });
        return;
      case "quad":
        nodes.push({ kind: "space", em: 1 });
        return;
      case "qquad":
        nodes.push({ kind: "space", em: 2 });
        return;
      case "displaystyle":
      case "textstyle":
      case "scriptstyle":
      case "limits":
      case "nolimits":
      case "nonumber":
      case "notag":
        return;
      case "color": {
        this.readRawGroup();
        nodes.push(...this.readArgument(style));
        return;
      }
      case "phantom":
      case "hspace":
      case "vspace":
      case "label":
        this.readRawGroup();
        return;
      default:
        break;
    }

    const big = BIG_OPS[name];
    if (big) {
      nodes.push({ kind: "op", text: big.text, big: true, limits: big.limits });
      return;
    }

    if (LIMIT_FUNCTIONS.has(name)) {
      nodes.push({ kind: "op", text: name, big: false, limits: true });
      return;
    }

    if (FUNCTIONS.has(name)) {
      if (nodes.length > 0) nodes.push({ kind: "space", em: 0.17 });
      nodes.push({ kind: "run", text: name, italic: false });
      return;
    }

    if (SYMBOLS[name] !== undefined) {
      pushSpaced(nodes, SYMBOLS[name]);
      return;
    }

    // An unknown command is still a word the reader should see: never drop it.
    if (name.length > 1) {
      nodes.push({ kind: "run", text: name, italic: false });
      return;
    }
    pushSpaced(nodes, name);
  }
}

/** Room around a relation or a binary operator, the way a formula is spaced. */
function pushSpaced(nodes: MathNode[], text: string): void {
  const em = RELATIONS.has(text) ? 0.28 : BINARY.has(text) ? 0.2 : 0;
  if (em > 0) nodes.push({ kind: "space", em });
  nodes.push({ kind: "run", text, italic: false });
  if (em > 0) nodes.push({ kind: "space", em });
}

/** The spaces at the two ends of an expression are not part of it. */
function trimSpaces(nodes: MathNode[]): MathNode[] {
  let start = 0;
  let end = nodes.length;

  while (start < end && nodes[start].kind === "space") start += 1;
  while (end > start && nodes[end - 1].kind === "space") end -= 1;

  return nodes.slice(start, end);
}

/** The readable characters of a node list, used by `\mathbb{R}` and friends. */
function plainNodes(nodes: MathNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "run" || node.kind === "text" || node.kind === "op") return node.text;
      if (node.kind === "space") return " ";
      if (node.kind === "frac") return `${plainNodes(node.num)}/${plainNodes(node.den)}`;
      return "";
    })
    .join("");
}

/** Splits a matrix body into rows of cells, at the top level only. */
function parseMatrixBody(body: string): MathNode[][][] {
  const rows: string[] = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);

    if (depth === 0 && char === "\\" && body[index + 1] === "\\") {
      rows.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  rows.push(current);

  return rows.map((row) => {
    const cells: string[] = [];
    let cell = "";
    let cellDepth = 0;

    for (const char of row) {
      if (char === "{") cellDepth += 1;
      if (char === "}") cellDepth = Math.max(0, cellDepth - 1);
      if (char === "&" && cellDepth === 0) {
        cells.push(cell);
        cell = "";
        continue;
      }
      cell += char;
    }
    cells.push(cell);

    return cells.map((source) => new Parser(source).parse());
  });
}

/* -------------------------------------------------------------------------- */
/* The layout                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One thing to paint, in the formula's own coordinates: x grows to the right,
 * y grows downwards from the baseline, so `y: -10` is ten pixels above it.
 */
export type MathOp =
  | { kind: "glyph"; x: number; y: number; text: string; font: string }
  | { kind: "rule"; x: number; y: number; width: number; height: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; width: number };

/** A typeset formula: its size, and the glyphs that paint it. */
export interface MathLayout {
  width: number;
  /** How far it reaches above the baseline. */
  ascent: number;
  /** How far it reaches below the baseline. */
  descent: number;
  ops: MathOp[];
  tex: string;
  size: number;
}

interface MathBox {
  width: number;
  ascent: number;
  descent: number;
  ops: MathOp[];
}

const LAYOUT_CACHE = new Map<string, MathLayout>();
const LAYOUT_CACHE_LIMIT = 500;
const FONT_METRICS = new Map<string, { ascent: number; descent: number }>();

function mathFont(size: number, italic = false, bold = false): string {
  return `${italic ? "italic " : ""}${bold ? "700" : "400"} ${Math.max(6, Math.round(size))}px "${FONTS.sans}"`;
}

function measure(context: RasterContext, font: string, text: string): number {
  context.font = font;
  return context.measureText(text).width;
}

/** The ascent and descent a font needs, measured once per font. */
function glyphMetrics(context: RasterContext, font: string): { ascent: number; descent: number } {
  const cached = FONT_METRICS.get(font);
  if (cached) return cached;

  context.font = font;
  const measured = context.measureText("Hxgy");
  const em = Number(/([0-9.]+)px/.exec(font)?.[1] ?? "16");
  const ascent =
    Number.isFinite(measured.actualBoundingBoxAscent) && measured.actualBoundingBoxAscent > 0
      ? measured.actualBoundingBoxAscent
      : em * 0.74;
  const descent =
    Number.isFinite(measured.actualBoundingBoxDescent) && measured.actualBoundingBoxDescent > 0
      ? measured.actualBoundingBoxDescent
      : em * 0.22;

  const metrics = { ascent, descent };
  if (FONT_METRICS.size > 300) FONT_METRICS.clear();
  FONT_METRICS.set(font, metrics);
  return metrics;
}

function shiftOps(ops: MathOp[], dx: number, dy = 0): MathOp[] {
  return ops.map((op) => {
    if (op.kind === "glyph") return { ...op, x: op.x + dx, y: op.y + dy };
    if (op.kind === "rule") return { ...op, x: op.x + dx, y: op.y + dy };
    return {
      ...op,
      x1: op.x1 + dx,
      y1: op.y1 + dy,
      x2: op.x2 + dx,
      y2: op.y2 + dy,
    };
  });
}

/** Puts boxes one after the other on the same baseline. */
function concat(boxes: MathBox[]): MathBox {
  const ops: MathOp[] = [];
  let width = 0;
  let ascent = 0;
  let descent = 0;

  for (const box of boxes) {
    ops.push(...shiftOps(box.ops, width));
    width += box.width;
    ascent = Math.max(ascent, box.ascent);
    descent = Math.max(descent, box.descent);
  }

  return { width, ascent, descent, ops };
}

function layoutNodes(context: RasterContext, nodes: MathNode[], size: number): MathBox {
  return concat(nodes.map((node) => layoutNode(context, node, size)));
}

function layoutNode(context: RasterContext, node: MathNode, size: number): MathBox {
  switch (node.kind) {
    case "space":
      return { width: Math.max(0, node.em * size), ascent: 0, descent: 0, ops: [] };
    case "run":
    case "text": {
      const italic = node.kind === "run" ? (node.italic ?? true) : false;
      const font = mathFont(size, italic, node.bold ?? false);
      const metrics = glyphMetrics(context, font);
      return {
        width: measure(context, font, node.text),
        ascent: metrics.ascent,
        descent: metrics.descent,
        ops: [{ kind: "glyph", x: 0, y: 0, text: node.text, font }],
      };
    }
    case "op": {
      const font = mathFont(node.big ? size * 1.35 : size, false, false);
      const metrics = glyphMetrics(context, font);
      return {
        width: measure(context, font, node.text),
        ascent: metrics.ascent,
        descent: metrics.descent,
        ops: [{ kind: "glyph", x: 0, y: 0, text: node.text, font }],
      };
    }
    case "frac":
      return layoutFraction(context, node.num, node.den, size);
    case "sqrt":
      return layoutRoot(context, node, size);
    case "scripts":
      return layoutScripts(context, node, size);
    case "matrix":
      return layoutMatrix(context, node, size);
    case "overbar":
      return layoutOverbar(context, node.body, size);
    default:
      return { width: 0, ascent: 0, descent: 0, ops: [] };
  }
}


/**
 * Numerator over denominator, with the bar on the formula's axis.
 *
 * The bar sits a little above the baseline (where a minus sign would be), the
 * numerator's bottom rests on it and the denominator hangs from it: this is
 * what makes `\frac{a}{b}` read as a fraction instead of as two letters.
 */
function layoutFraction(context: RasterContext, num: MathNode[], den: MathNode[], size: number): MathBox {
  const inner = Math.max(9, size * 0.76);
  const numerator = layoutNodes(context, num, inner);
  const denominator = layoutNodes(context, den, inner);
  const pad = Math.max(2, size * 0.12);
  const bar = Math.max(1, size * 0.05);
  const axis = Math.round(size * 0.26);

  const width = Math.max(numerator.width, denominator.width) + pad * 2;
  const numeratorBaseline = -axis - bar / 2 - pad - numerator.descent;
  const denominatorBaseline = -axis + bar / 2 + pad + denominator.ascent;

  return {
    width,
    ascent: -(numeratorBaseline - numerator.ascent),
    descent: denominatorBaseline + denominator.descent,
    ops: [
      ...shiftOps(numerator.ops, (width - numerator.width) / 2, numeratorBaseline),
      ...shiftOps(denominator.ops, (width - denominator.width) / 2, denominatorBaseline),
      { kind: "rule", x: 0, y: -axis - bar / 2, width, height: bar },
    ],
  };
}

/** A radical drawn as three strokes, with the rule that covers its body. */
function layoutRoot(context: RasterContext, node: Extract<MathNode, { kind: "sqrt" }>, size: number): MathBox {
  const body = layoutNodes(context, node.body, size);
  const height = body.ascent + body.descent;
  const top = -body.ascent;
  const index = node.index ? layoutNodes(context, node.index, Math.max(9, size * 0.6)) : null;
  const shift = index ? index.width * 0.8 : 0;
  const radical = Math.max(6, size * 0.45);
  const gap = Math.max(2, size * 0.08);
  const thin = Math.max(1, size * 0.045);
  const start = shift;
  const knee = start + radical * 0.3;
  const tip = start + radical * 0.7;
  const bodyX = start + radical + gap * 0.4;

  const ops: MathOp[] = [
    { kind: "line", x1: start, y1: top + height * 0.55, x2: knee, y2: top + height * 0.12, width: thin },
    { kind: "line", x1: knee, y1: top + height * 0.12, x2: tip, y2: top, width: thin },
    { kind: "rule", x: tip, y: top, width: bodyX + body.width - tip, height: thin },
    ...shiftOps(body.ops, bodyX),
  ];

  if (index) {
    const indexBaseline = top + height * 0.18;
    ops.push(...shiftOps(index.ops, 0, indexBaseline));
  }

  return {
    width: bodyX + body.width,
    ascent: height + thin,
    descent: body.descent,
    ops,
  };
}

/**
 * A base with a superscript and/or a subscript.
 *
 * Limits of a sum go above and below it, centred; the script of a letter goes
 * to its right, raised or lowered, which is the difference between `\sum_{i}`
 * and `x_i`.
 */
function layoutScripts(context: RasterContext, node: Extract<MathNode, { kind: "scripts" }>, size: number): MathBox {
  const scriptSize = Math.max(9, size * 0.7);
  const base = layoutNode(context, node.base, size);
  const sup = node.sup ? layoutNodes(context, node.sup, scriptSize) : null;
  const sub = node.sub ? layoutNodes(context, node.sub, scriptSize) : null;
  const limits = node.base.kind === "op" && node.base.limits;

  if (limits) {
    const width = Math.max(base.width, sup?.width ?? 0, sub?.width ?? 0);
    const gap = Math.max(2, size * 0.14);
    const ops = shiftOps(base.ops, (width - base.width) / 2);

    let ascent = base.ascent;
    if (sup) {
      const baseline = -base.ascent - gap - sup.descent;
      ops.push(...shiftOps(sup.ops, (width - sup.width) / 2, baseline));
      ascent = Math.max(ascent, -baseline + sup.ascent);
    }

    let descent = base.descent;
    if (sub) {
      const baseline = base.descent + gap + sub.ascent;
      ops.push(...shiftOps(sub.ops, (width - sub.width) / 2, baseline));
      descent = Math.max(descent, baseline + sub.descent);
    }

    return { width, ascent, descent, ops };
  }

  // The limits of an integral sit beside a glyph that is already tall: a wider
  // gap and a deeper drop keep them off its stem, the way LaTeX sets them.
  const big = node.base.kind === "op" && node.base.big;
  const gap = Math.max(1, size * (big ? 0.1 : 0.05));
  const supBaseline = -size * (big ? 0.5 : 0.42);
  const subBaseline = size * (big ? 0.34 : 0.26);
  const scriptWidth = Math.max(sup?.width ?? 0, sub?.width ?? 0);
  // What follows an integral starts in the band its lower limit hangs in, so it
  // is pushed clear of it: `\int_0^1 \frac{}{}` must not read as `0 1 + x`.
  const tail = big && (sup || sub) ? Math.max(2, size * 0.16) : 0;
  const width = base.width + (sup || sub ? gap + scriptWidth + tail : 0);
  const ops = shiftOps(base.ops, 0);

  if (sup) ops.push(...shiftOps(sup.ops, base.width + gap, supBaseline));
  if (sub) ops.push(...shiftOps(sub.ops, base.width + gap, subBaseline));

  return {
    width,
    ascent: Math.max(base.ascent, sup ? -supBaseline + sup.ascent : 0),
    descent: Math.max(base.descent, sub ? subBaseline + sub.descent : 0),
    ops,
  };
}

/** A horizontal rule over an expression, for `\overline{x}`. */
function layoutOverbar(context: RasterContext, body: MathNode[], size: number): MathBox {
  const content = layoutNodes(context, body, size);
  const thickness = Math.max(1, size * 0.05);
  const offset = Math.max(2, size * 0.12);

  return {
    width: content.width,
    ascent: content.ascent + offset + thickness,
    descent: content.descent,
    ops: [
      ...content.ops,
      { kind: "rule", x: 0, y: -content.ascent - offset - thickness, width: content.width, height: thickness },
    ],
  };
}


/** A bracketed grid, for matrices, systems and `cases`. */
function layoutMatrix(context: RasterContext, node: Extract<MathNode, { kind: "matrix" }>, size: number): MathBox {
  const cellSize = Math.max(9, size * 0.95);
  const rows = node.rows.map((row) => row.map((cell) => layoutNodes(context, cell, cellSize)));
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const widths = new Array<number>(columns).fill(0);

  for (const row of rows) {
    row.forEach((box, column) => {
      widths[column] = Math.max(widths[column], box.width);
    });
  }

  const columnGap = Math.max(4, size * 0.9);
  const rowGap = Math.max(2, size * 0.4);
  const height = rows.reduce(
    (total, row) =>
      total + Math.max(0, ...row.map((box) => box.ascent)) + Math.max(0, ...row.map((box) => box.descent)),
    0,
  ) + rowGap * Math.max(0, rows.length - 1);
  const contentWidth = widths.reduce((total, value) => total + value, 0) + columnGap * Math.max(0, columns - 1);

  // The grid is centred on the formula's axis, the way a matrix in an
  // equation sits next to the equals sign.
  const ascent = height / 2 + size * 0.25;
  const descent = height - ascent;
  const ops: MathOp[] = [];

  let top = -ascent;
  for (const row of rows) {
    const rowAscent = Math.max(0, ...row.map((box) => box.ascent));
    const rowDescent = Math.max(0, ...row.map((box) => box.descent));
    let x = 0;

    row.forEach((box, column) => {
      ops.push(...shiftOps(box.ops, x + (widths[column] - box.width) / 2, top + rowAscent));
      x += widths[column] + columnGap;
    });

    top += rowAscent + rowDescent + rowGap;
  }

  const gap = Math.max(2, size * 0.12);
  const open = node.open ? delimiter(context, node.open, height, size) : null;
  const close = node.close ? delimiter(context, node.close, height, size) : null;
  const shift = open ? open.width + gap : 0;
  const width = shift + contentWidth + (close ? close.width + gap : 0);
  const centre = -ascent + height / 2;
  const grid = shiftOps(ops, shift);

  ops.length = 0;
  let reach = ascent;
  let drop = descent;

  if (open) {
    ops.push(...shiftOps(open.ops, 0, centre + (open.ascent - open.descent) / 2));
    reach = Math.max(reach, -centre + (open.ascent + open.descent) / 2);
    drop = Math.max(drop, centre + (open.ascent + open.descent) / 2);
  }
  ops.push(...grid);
  if (close) {
    ops.push(...shiftOps(close.ops, shift + contentWidth + gap, centre + (close.ascent - close.descent) / 2));
    reach = Math.max(reach, -centre + (close.ascent + close.descent) / 2);
    drop = Math.max(drop, centre + (close.ascent + close.descent) / 2);
  }

  return { width, ascent: reach, descent: drop, ops };
}

/** A bracket drawn large enough to span a grid. */
function delimiter(context: RasterContext, text: string, height: number, size: number): MathBox {
  const font = mathFont(Math.max(size, height * 1.2), false, false);
  const metrics = glyphMetrics(context, font);

  return {
    width: measure(context, font, text),
    ascent: metrics.ascent,
    descent: metrics.descent,
    ops: [{ kind: "glyph", x: 0, y: 0, text, font }],
  };
}

/* -------------------------------------------------------------------------- */
/* The public surface                                                         */
/* -------------------------------------------------------------------------- */

/** Words of ordinary prose, ignoring commands and the texts they print. */
function proseWordCount(text: string): number {
  const stripped = text
    .replace(/\\text\s*\{[^{}]*\}/g, " ")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/\\[^A-Za-z]/g, " ");

  return (stripped.match(/(?:^|[\s(\[{,;:])([A-Za-zÀ-ÿ]{3,})(?=[\s.,;:!?)\]}]|$)/g) ?? []).length;
}

/** Whether a whole line of markdown is a formula rather than prose. */
export function isFormulaLine(line: string): boolean {
  const text = line.trim();
  if (text.length < 2 || text.length > 400) return false;

  if (
    (text.startsWith("$$") && text.endsWith("$$")) ||
    (text.startsWith("\\[") && text.endsWith("\\]")) ||
    (text.startsWith("\\(") && text.endsWith("\\)")) ||
    (text.startsWith("$") && text.endsWith("$") && text.length > 2)
  ) {
    return true;
  }

  // A sentence with a formula inside it is a paragraph, not a display formula:
  // `Una frazione inline: $x = \frac{a}{b}$ dentro il testo` stays prose, and
  // only the part between the dollars is typeset.
  if (text.includes("$") || /\\[()]/.test(text)) return false;

  // A display formula has almost no words; a sentence has several. This keeps
  // a line that merely mentions `\frac` from losing its spaces and its prose.
  if (proseWordCount(text) >= 4) return false;

  if (/\\[A-Za-z]+/.test(text)) return true;
  if (/\b(?:frac|dfrac|tfrac|sqrt|cdot|times|div|text|mathrm|mathbf|mathbb|left|right|begin|end|overline|sum|prod|int|lim|infty|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|Delta|Omega)\s*[({]/.test(text)) {
    return true;
  }
  // The transcription sometimes loses the backslash: `frac{6.02}{2}` is still
  // a fraction, and `10^{26}` is still a power.
  return /\b(?:frac|sqrt)\s*\{/.test(text) || (/[\^_]\{/.test(text) && /[=+\-−·×/]/.test(text));
}

/** Strips the delimiters a formula may have been written with. */
export function normalizeTex(source: string): string {
  let tex = source.replace(/\r\n?/g, " ").replace(/\s+/g, " ").trim();

  for (let pass = 0; pass < 4; pass += 1) {
    const before = tex;
    if (tex.startsWith("$$") && tex.endsWith("$$") && tex.length > 4) tex = tex.slice(2, -2).trim();
    else if (tex.startsWith("\\[") && tex.endsWith("\\]")) tex = tex.slice(2, -2).trim();
    else if (tex.startsWith("\\(") && tex.endsWith("\\)")) tex = tex.slice(2, -2).trim();
    else if (tex.startsWith("$") && tex.endsWith("$") && tex.length > 2) tex = tex.slice(1, -1).trim();
    else if (tex.startsWith("[") && tex.endsWith("]") && isFormulaLine(tex.slice(1, -1))) tex = tex.slice(1, -1).trim();
    if (before === tex) break;
  }

  // A model that escapes its own escaping writes `\\frac`: that is a command,
  // not a row break, so the doubled backslash is collapsed.
  return tex.replace(/\\{2,}(?=[A-Za-z])/g, "\\");
}


/**
 * Typesets one formula at one size.
 *
 * The same formula is measured again and again while a slide is fitted (for
 * every scale, for every column), so the result is cached by expression and
 * size. Measurement is the only thing that touches the canvas here; painting
 * happens in `drawMath`.
 */
export function layoutMath(context: RasterContext, source: string, size: number): MathLayout {
  const tex = normalizeTex(source);
  const pixels = Math.max(6, size);
  const key = `${Math.round(pixels)}|${tex}`;
  const cached = LAYOUT_CACHE.get(key);
  if (cached) return cached;

  let nodes: MathNode[] = [];
  try {
    nodes = new Parser(tex).parse();
  } catch {
    nodes = [];
  }
  // An expression made only of commands we ignore must still be visible.
  if (nodes.length === 0 && tex.length > 0) nodes = [{ kind: "text", text: tex }];

  const box = layoutNodes(context, nodes, pixels);
  const layout: MathLayout = { ...box, tex, size: pixels };

  if (LAYOUT_CACHE.size >= LAYOUT_CACHE_LIMIT) LAYOUT_CACHE.clear();
  LAYOUT_CACHE.set(key, layout);
  return layout;
}

/** Paints a formula whose left end and baseline are given. */
export function drawMath(
  context: RasterContext,
  layout: MathLayout,
  x: number,
  baseline: number,
  color: string,
): void {
  context.save();
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = color;
  context.strokeStyle = color;

  for (const op of layout.ops) {
    if (op.kind === "glyph") {
      context.font = op.font;
      context.fillText(op.text, x + op.x, baseline + op.y);
      continue;
    }
    if (op.kind === "rule") {
      context.fillRect(x + op.x, baseline + op.y, op.width, op.height);
      continue;
    }

    context.lineWidth = op.width;
    context.beginPath();
    context.moveTo(x + op.x1, baseline + op.y1);
    context.lineTo(x + op.x2, baseline + op.y2);
    context.stroke();
  }

  context.restore();
}

