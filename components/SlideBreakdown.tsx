"use client";

import React, { useMemo, useState } from "react";
import { Download, Eye } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { LayoutSummaryPanel } from "@/components/LayoutSummaryPanel";
import type { SlideFigure } from "@/lib/slideFigures";
import type {
  GeneratedSlide,
  LayoutSummary,
  SlideAnalysis,
  SlideLayoutElement,
} from "@/lib/types";

interface SlideBreakdownProps {
  slides: SlideAnalysis[];
  total: number;
  fileName: string;
  /** The deck-level furniture summary, available once the run is done. */
  layout?: LayoutSummary;
  isProcessing: boolean;
  /** Slides already rebuilt on the template, keyed by page number. */
  generated: GeneratedSlide[];
  /** Download of a single rebuilt slide. */
  onDownloadSlide: (index: number) => void;
}

/**
 * The per-slide breakdown: a rail of slide pictures on the left, the Markdown
 * transcription of the selected slide on the right.
 *
 * Once a slide has been rebuilt, a small button in its corner lets the user
 * hold to preview the rebuilt version and release to get the original back.
 */
export function SlideBreakdown({
  slides,
  total,
  fileName,
  layout,
  isProcessing,
  generated,
  onDownloadSlide,
}: SlideBreakdownProps) {
  const ordered = useMemo(
    () => [...slides].sort((left, right) => left.index - right.index),
    [slides],
  );
  const generatedByIndex = useMemo(
    () => new Map(generated.map((slide) => [slide.index, slide])),
    [generated],
  );
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [peekIndex, setPeekIndex] = useState<number | null>(null);

  // The first transcribed slide is selected by default; clicking a thumbnail
  // pins the panel to that slide while the rest of the deck keeps streaming.
  const selected =
    pinnedIndex !== null
      ? ordered.find((slide) => slide.index === pinnedIndex) ?? null
      : ordered[0] ?? null;

  const count = Math.max(total, ordered.length);
  const peeked = peekIndex !== null ? generatedByIndex.get(peekIndex) : undefined;
  const selectedRebuild = selected ? generatedByIndex.get(selected.index) : undefined;

  const startPeek = (index: number) => (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // Capture the pointer: releasing outside the button must still end the peek.
    event.currentTarget.setPointerCapture(event.pointerId);
    setPeekIndex(index);
  };
  const stopPeek = () => setPeekIndex(null);

  return (
    <div className="space-y-3">
      <LayoutSummaryPanel layout={layout} isProcessing={isProcessing} />

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
      <div className="max-h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
        {count === 0 ? (
          <p className="p-3 text-xs text-slate-500">Waiting for the first slide…</p>
        ) : (
          <ul className="space-y-1.5">
            {Array.from({ length: count }, (_, offset) => {
              const index = offset + 1;
              const slide = ordered.find((value) => value.index === index);
              const rebuiltSlide = generatedByIndex.get(index);
              const peeking = peekIndex === index && Boolean(rebuiltSlide);
              const active = selected?.index === index;

              return (
                <li key={index} className="relative">
                  <button
                    type="button"
                    disabled={!slide}
                    onClick={() => setPinnedIndex(index)}
                    aria-current={active ? "true" : undefined}
                    className={`w-full rounded-lg border p-1.5 text-left transition-colors ${
                      active
                        ? "border-indigo-300 bg-white shadow-sm"
                        : "border-transparent hover:border-slate-200 hover:bg-white"
                    } disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent`}
                  >
                    <span className="relative block aspect-video w-full overflow-hidden rounded-md border border-slate-200 bg-white">
                      {peeking && rebuiltSlide ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={rebuiltSlide.image}
                          alt={`Rebuilt slide ${index}`}
                          className="h-full w-full object-contain"
                        />
                      ) : slide?.thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={slide.thumbnail}
                          alt={`Slide ${index}`}
                          loading="lazy"
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[11px] text-slate-400">
                          {slide ? "No preview" : "…"}
                        </span>
                      )}
                      {peeking ? (
                        <span className="absolute left-1 top-1 rounded bg-indigo-600 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                          rebuilt
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 flex items-center justify-between px-0.5 text-[11px] font-semibold text-slate-600">
                      <span>Slide {index}</span>
                      {slide && !slide.usedAI ? <span className="text-rose-500">!</span> : null}
                    </span>
                  </button>

                  {rebuiltSlide ? (
                    <div className="absolute bottom-6 right-1.5 flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Hold to preview the rebuilt slide ${index}`}
                        title="Hold to see the rebuilt slide"
                        onPointerDown={startPeek(index)}
                        onPointerUp={stopPeek}
                        onPointerCancel={stopPeek}
                        onLostPointerCapture={stopPeek}
                        onKeyDown={(event) => {
                          if (event.key === " " || event.key === "Enter") {
                            event.preventDefault();
                            setPeekIndex(index);
                          }
                        }}
                        onKeyUp={stopPeek}
                        onBlur={stopPeek}
                        className="touch-none select-none rounded-md border border-slate-200 bg-white/95 p-1 text-slate-500 shadow-sm transition-colors hover:border-indigo-300 hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Download the rebuilt slide ${index}`}
                        title="Download this rebuilt slide as a PDF"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDownloadSlide(index);
                        }}
                        className="rounded-md border border-slate-200 bg-white/95 p-1 text-slate-500 shadow-sm transition-colors hover:border-indigo-300 hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Transcription
            </p>
            <p className="truncate text-sm font-semibold text-slate-800">
              {selected ? `Slide ${selected.index} of ${count}` : "Waiting for the first slide…"}
            </p>
          </div>
          {selected && (selected.layout.length > 0 || generatedByIndex.has(selected.index)) ? (
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              {generatedByIndex.has(selected.index) ? (
                <span
                  className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600"
                  title="This slide has been rebuilt on the template: hold the eye on its thumbnail to see it."
                >
                  rebuilt
                </span>
              ) : null}
              {selected.layout.length > 0 ? (
                <span
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500"
                  title="Headers, footers, logos and page numbers are listed in the layout summary instead."
                >
                  content only
                </span>
              ) : null}
            </span>
          ) : null}
        </div>

        {selected && selected.note ? (
          <div className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-[11.5px] leading-relaxed text-rose-700 sm:px-6">
            <span className="font-semibold">Not transcribed.</span> {selected.note}
          </div>
        ) : null}

        {selected && selected.layout.length > 0 ? (
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 sm:px-6">
            <ExcludedElements elements={selected.layout} />
          </div>
        ) : null}

        {selected && selected.figures.length > 0 ? (
          <div className="border-b border-indigo-100 bg-indigo-50/70 px-4 py-2.5 sm:px-6">
            <FigureList
              figures={selected.figures}
              rebuilt={generatedByIndex.has(selected.index)}
            />
          </div>
        ) : null}

        {/* What the reviewer of the rebuilt slide still finds wrong, if anything. */}
        {selectedRebuild?.review && !selectedRebuild.review.ok ? (
          <div className="border-b border-amber-100 bg-amber-50/70 px-4 py-2.5 sm:px-6">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-600">
              Checked against the original · {selectedRebuild.review.score}/10
            </p>
            {selectedRebuild.review.issues.length > 0 ? (
              <ul className="space-y-1">
                {selectedRebuild.review.issues.map((issue, position) => (
                  <li
                    key={`${issue.target}-${position}`}
                    className="text-[11px] leading-snug text-amber-800"
                  >
                    <span className="mr-1 font-bold uppercase tracking-wider text-amber-500">
                      {issue.target}
                    </span>
                    {issue.problem}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] leading-snug text-amber-800">
                The reviewer was not convinced, but did not name a single problem.
              </p>
            )}
          </div>
        ) : null}

        <div className="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-6">
          {selected ? (
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h1 className="mb-3 mt-1 text-lg font-bold text-slate-900">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-wider text-indigo-600">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="mb-2 mt-4 text-sm font-semibold text-slate-800">{children}</h3>
                ),
                p: ({ children }) => (
                  <p className="my-2 text-sm leading-relaxed text-slate-700">{children}</p>
                ),
                ul: ({ children }) => (
                  <ul className="my-2 list-disc space-y-1 pl-5 text-sm text-slate-700 marker:text-slate-400">
                    {children}
                  </ul>
                ),
                ol: ({ children }) => (
                  <ol className="my-2 list-decimal space-y-1 pl-5 text-sm text-slate-700 marker:text-slate-400">
                    {children}
                  </ol>
                ),
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                strong: ({ children }) => (
                  <strong className="font-semibold text-slate-900">{children}</strong>
                ),
                em: ({ children }) => <em className="italic">{children}</em>,
                hr: () => <hr className="my-5 border-slate-200" />,
                blockquote: ({ children }) => (
                  <blockquote className="my-3 border-l-4 border-indigo-200 bg-indigo-50/60 px-3 py-2 text-sm italic text-slate-600">
                    {children}
                  </blockquote>
                ),
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-indigo-600 underline underline-offset-2"
                  >
                    {children}
                  </a>
                ),
                pre: ({ children }) => (
                  <pre className="my-3 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11.5px] leading-relaxed text-slate-100 [&>code]:bg-transparent [&>code]:px-0 [&>code]:py-0 [&>code]:text-slate-100">
                    {children}
                  </pre>
                ),
                code: ({ children }) => (
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">
                    {children}
                  </code>
                ),
                table: ({ children }) => (
                  <div className="my-3 overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-700">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="border border-slate-200 px-2 py-1 align-top text-slate-700">
                    {children}
                  </td>
                ),
              }}
            >
              {selected.markdown}
            </Markdown>
          ) : (
            <p className="text-sm text-slate-500">
              The transcription of every slide will appear here as soon as the model has read it.
            </p>
          )}
        </div>

        <p className="truncate border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          {fileName}
        </p>
      </div>
      </div>

      {/* Hold-to-preview: the rebuilt slide, large, while the eye is pressed. */}
      {peeked ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-6">
          <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-white/20 bg-white shadow-2xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={peeked.image}
              alt={`Rebuilt slide ${peeked.index}`}
              className="block w-full"
            />
            <p className="flex items-center justify-between gap-3 bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-white">
              <span>
                Rebuilt slide {peeked.index}
                {peeked.figures > 0
                  ? ` · ${peeked.figures} ${peeked.figures === 1 ? "figure" : "figures"} redrawn`
                  : ""}
                {peeked.clipped ? " · dense content trimmed to fit" : ""}
                {peeked.review
                  ? peeked.review.ok
                    ? " · approved by the reviewer"
                    : peeked.review.issues.length === 0
                      ? ` · reviewer not convinced (${peeked.review.score}/10)`
                      : ` · reviewer flagged ${peeked.review.issues.length} ${
                          peeked.review.issues.length === 1 ? "problem" : "problems"
                        }`
                  : ""}
              </span>
              <span className="text-slate-300">release to go back</span>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The visual elements of the slide, each redrawn from the original picture. */
function FigureList({ figures, rebuilt }: { figures: SlideFigure[]; rebuilt: boolean }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        {rebuilt ? "Redrawn from the original slide" : "Visual elements to redraw"}
      </p>
      <ul className="space-y-1">
        {figures.map((figure) => (
          <li
            key={figure.id}
            className="flex items-start gap-1.5 text-[11px] leading-snug text-slate-600"
          >
            <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600">
              {figure.kind}
            </span>
            <span className="min-w-0">
              <span className="text-slate-400">{figure.position}</span> · {figure.description}
              {figure.labels.length > 0 ? (
                <span className="text-slate-400"> ({figure.labels.join(", ")})</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compact list of what the model left out of the selected slide. */
function ExcludedElements({ elements }: { elements: SlideLayoutElement[] }) {
  const visible = elements.slice(0, 8);
  const hidden = elements.length - visible.length;

  return (
    <div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        Kept out of this transcription
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {visible.map((element, index) => (
          <li
            key={`${element.kind}-${index}`}
            title={element.position}
            className="max-w-full truncate rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500"
          >
            <span className="font-semibold text-slate-600">{element.kind}</span>
            {element.text ? <span> · {element.text}</span> : null}
          </li>
        ))}
        {hidden > 0 ? (
          <li className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-400">
            +{hidden} more
          </li>
        ) : null}
      </ul>
    </div>
  );
}
