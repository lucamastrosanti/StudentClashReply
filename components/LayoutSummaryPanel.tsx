"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp, LayoutTemplate, LoaderCircle } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { formatSlideList } from "@/lib/layoutSummary";
import type { LayoutSummary } from "@/lib/types";

interface LayoutSummaryPanelProps {
  /** Present only once the deck has been fully read. */
  layout?: LayoutSummary;
  isProcessing: boolean;
}

/**
 * Deck-level summary of the page furniture: what was found, where it sits, how
 * many slides it appears on and which elements change from slide to slide.
 *
 * The Markdown is written by the text model; the inventory below it is the
 * deterministic count the model was given, so every claim can be checked.
 */
export function LayoutSummaryPanel({ layout, isProcessing }: LayoutSummaryPanelProps) {
  const [open, setOpen] = useState(true);

  if (!layout && !isProcessing) return null;

  const findings = layout?.findings ?? [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50"
      >
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-700">
          <LayoutTemplate className="h-4 w-4 text-indigo-500" />
          Layout and recurring elements
          {layout ? (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">
              {findings.length}
            </span>
          ) : null}
          {layout && !layout.usedAI && findings.length > 0 ? (
            <span
              className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500"
              title="The text model was unavailable: this summary was assembled from the measured counts."
            >
              automatic
            </span>
          ) : null}
          {isProcessing ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-indigo-400" />
          ) : null}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        )}
      </button>

      {open ? (
        <div className="max-h-[38vh] space-y-3 overflow-y-auto border-t border-slate-100 px-4 py-3">
          {layout ? (
            <>
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ children }) => (
                    <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-indigo-600">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="mb-1 mt-3 text-xs font-semibold text-slate-800">{children}</h3>
                  ),
                  p: ({ children }) => (
                    <p className="my-1 text-xs leading-relaxed text-slate-600">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="my-1 list-disc space-y-1 pl-5 text-xs text-slate-600 marker:text-slate-400">
                      {children}
                    </ul>
                  ),
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  strong: ({ children }) => (
                    <strong className="font-semibold text-slate-900">{children}</strong>
                  ),
                }}
              >
                {layout.markdown}
              </Markdown>

              {findings.length > 0 ? (
                <ul className="space-y-1 border-t border-slate-100 pt-3">
                  <li className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Measured inventory
                  </li>
                  {findings.map((finding) => (
                    <li
                      key={`${finding.kind}-${finding.position}-${finding.text}`}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-slate-600"
                    >
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-700">
                        {finding.kind}
                      </span>
                      <span className="text-slate-400">{finding.position}</span>
                      {finding.text ? (
                        <span className="font-medium text-slate-800">{finding.text}</span>
                      ) : (
                        <span className="italic text-slate-400">graphic</span>
                      )}
                      {finding.sequential ? (
                        <span
                          className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10.5px] font-semibold text-indigo-600"
                          title="The element stays on the slide but its text changes."
                        >
                          {finding.values[0]} → {finding.values[finding.values.length - 1]}
                        </span>
                      ) : null}
                      <span className="ml-auto tabular-nums text-slate-400">
                        {finding.slides.length === 1
                          ? `slide ${finding.slides[0]}`
                          : `${finding.slides.length} slides (${formatSlideList(finding.slides)})`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-slate-500">
              The layout summary is written once every slide has been read.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
