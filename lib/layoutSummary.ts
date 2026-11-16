/**
 * The deterministic half of the deck-level layout summary.
 *
 * The vision model judges what is content and what is page furniture on each
 * slide; this module measures that judgement across the whole document:
 * it merges the same element described on several slides, counts the
 * repetitions and spots sequential elements (page numbers, counters, dates).
 *
 * No Node.js imports: the browser imports `formatSlideList` from here to show
 * the slide ranges next to each finding.
 */

import type { LayoutFinding, SlideAnalysis } from "@/lib/types";

interface Bucket {
  kind: string;
  /** Slide numbers, one entry per slide even if the element repeats on it. */
  slides: number[];
  /** One text value per slide, in slide order. */
  values: string[];
  positions: Map<string, number>;
}

/** Merges the per-slide furniture into deck-wide findings, most frequent first. */
export function collectLayoutFindings(slides: SlideAnalysis[]): LayoutFinding[] {
  const buckets = new Map<string, Bucket>();

  for (const slide of [...slides].sort((left, right) => left.index - right.index)) {
    for (const element of slide.layout) {
      const kind = element.kind || "other";
      const text = element.text.trim();
      const shape = maskDigits(text);
      const key = `${kind}::${shape}`;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { kind, slides: [], values: [], positions: new Map() };
        buckets.set(key, bucket);
      }

      // The same element can be reported twice on one slide (e.g. a header
      // repeated on a section cover): it still counts once for that slide.
      if (!bucket.slides.includes(slide.index)) {
        bucket.slides.push(slide.index);
        bucket.values.push(text);
      }

      const position = element.position || "unknown";
      bucket.positions.set(position, (bucket.positions.get(position) ?? 0) + 1);
    }
  }

  return [...buckets.values()]
    .map((bucket): LayoutFinding => {
      const values = unique(bucket.values.filter((value) => value.length > 0));

      return {
        kind: bucket.kind,
        position: mostFrequent(bucket.positions),
        text: values[0] ?? "",
        slides: [...bucket.slides].sort((left, right) => left - right),
        // The bucket groups texts that differ only by their digits, so two
        // distinct values mean the element stays while its text is counted.
        sequential: values.length > 1,
        values,
      };
    })
    .sort(
      (left, right) =>
        right.slides.length - left.slides.length ||
        left.kind.localeCompare(right.kind) ||
        left.position.localeCompare(right.position),
    );
}

/** Deterministic summary, used when the text model is unavailable. */
export function renderLayoutMarkdown(findings: LayoutFinding[], slideCount: number): string {
  if (findings.length === 0) {
    return [
      "## Layout and recurring elements",
      "",
      "No page furniture was detected: every visible element carries content.",
    ].join("\n");
  }

  const lines = findings.map((finding) => {
    const where =
      finding.slides.length === 1
        ? `slide ${finding.slides[0]}`
        : `${finding.slides.length} of ${slideCount} slides (${formatSlideList(finding.slides)})`;
    const what = finding.text ? `"${truncate(finding.text, 80)}"` : "(graphic element)";
    const sequential = finding.sequential
      ? `, sequential (${truncate(finding.values[0], 40)} → ${truncate(
          finding.values[finding.values.length - 1],
          40,
        )})`
      : "";

    return `- **${finding.kind}** — ${finding.position} — ${what}${sequential} — ${where}`;
  });

  return ["## Layout and recurring elements", "", ...lines].join("\n");
}

/** "1–3, 5, 8–12" from a list of slide numbers. */
export function formatSlideList(slides: number[]): string {
  const sorted = [...new Set(slides)].sort((left, right) => left - right);
  if (sorted.length === 0) return "";

  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];

    if (current === previous + 1) {
      previous = current;
      continue;
    }

    parts.push(start === previous ? `${start}` : `${start}–${previous}`);
    start = current;
    previous = current;
  }

  return parts.join(", ");
}

function maskDigits(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
}

function mostFrequent(counts: Map<string, number>): string {
  let best = "";
  let bestCount = -1;

  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }

  return best;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
