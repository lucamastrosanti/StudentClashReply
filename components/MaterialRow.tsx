"use client";

import React, { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  LayoutTemplate,
  Layers,
  LoaderCircle,
  Sparkles,
  Trash2,
} from "lucide-react";

import { SlideBreakdown } from "@/components/SlideBreakdown";
import type { MaterialItem } from "@/lib/types";

interface MaterialRowProps {
  item: MaterialItem;
  onAnalyze: (id: string) => void;
  /** Second, independent step: lay the transcribed slides on the template. */
  onGenerate: (id: string) => void;
  onDownload: (id: string, indexes?: number[]) => Promise<void>;
  onRemove: (id: string) => void;
}

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  converting: "PPTX to PDF",
  rendering: "Opening the document",
  analyzing: "AI transcription",
  rebuilding: "Rebuilding slides",
  completed: "Completed",
  failed: "Failed",
};

/** One uploaded material: file info, analysis action, live progress, breakdown. */
export function MaterialRow({ item, onAnalyze, onGenerate, onDownload, onRemove }: MaterialRowProps) {
  const { file, status, progress, message, result, error, stage, slides, slideTotal, generation } = item;
  const [open, setOpen] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const isProcessing = status === "processing";
  const isDone = status === "done" && Boolean(result);
  const total = Math.max(slideTotal, slides.length);

  const isRebuilding = generation?.status === "processing";
  const rebuilt = generation?.slides ?? [];
  const transcribedSlides = slides.filter((slide) => slide.usedAI).length;
  const canRebuild = transcribedSlides > 0 && !isProcessing && !isRebuilding;

  const download = async (indexes?: number[]) => {
    if (downloading) return;
    setDownloading(true);
    try {
      await onDownload(item.id, indexes);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-xs transition-shadow hover:shadow-md">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div className="bg-indigo-50 text-indigo-600 p-2.5 rounded-xl shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">{file.name}</p>
            <p className="text-xs text-slate-500">
              {formatBytes(file.size)} &middot;{" "}
              {file.name.toLowerCase().endsWith(".pptx") ? "PowerPoint" : "PDF"}
              {result ? ` \u00b7 ${result.stats.slides} slides` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onAnalyze(item.id)}
            disabled={isProcessing}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-indigo-300"
          >
            {isProcessing ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : isDone ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {isProcessing ? "Analyzing…" : isDone ? "Analyze again" : "Analyze"}
          </button>

          {isDone && result ? (
            <span className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-sm font-semibold text-emerald-700">
              <CheckCircle2 className="w-4 h-4" />
              Content transcribed
            </span>
          ) : null}

          <button
            type="button"
            onClick={() => onGenerate(item.id)}
            disabled={!canRebuild}
            title={
              transcribedSlides === 0
                ? "Analyze the material first: the rebuild needs the transcription."
                : "Lay every transcribed slide out on the template, content only."
            }
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3.5 py-2 text-sm font-semibold text-indigo-700 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
          >
            {isRebuilding ? (
              <LoaderCircle className="w-4 h-4 animate-spin" />
            ) : (
              <LayoutTemplate className="w-4 h-4" />
            )}
            {isRebuilding ? "Rebuilding…" : rebuilt.length > 0 ? "Rebuild again" : "Rebuild slides"}
          </button>

          {rebuilt.length > 0 ? (
            <button
              type="button"
              onClick={() => void download()}
              disabled={downloading}
              title="Download the rebuilt slides as a PDF."
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {downloading ? (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              {downloading ? "Preparing…" : `Download PDF (${rebuilt.length})`}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => onRemove(item.id)}
            disabled={isProcessing}
            aria-label={`Remove ${file.name}`}
            className="rounded-lg border border-slate-200 p-2 text-slate-400 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isProcessing ? (
        <ProgressBar
          value={progress}
          label={message}
          stage={stage}
          slides={slides.length}
          total={total}
        />
      ) : null}

      {isRebuilding ? (
        <ProgressBar
          value={generation?.progress ?? 0}
          label={generation?.message ?? ""}
          stage="rebuilding"
          slides={rebuilt.length}
          total={Math.max(rebuilt.length, transcribedSlides)}
        />
      ) : null}

      {generation?.status === "done" ? (
        <p className="mt-3 text-xs text-slate-500">
          <span className="font-semibold text-emerald-600">
            {rebuilt.length} {rebuilt.length === 1 ? "slide" : "slides"} rebuilt
          </span>{" "}
          on the standard template, content only.
          {generation.skipped.length > 0
            ? ` ${generation.skipped.length} slides without a transcription were left out.`
            : ""}
        </p>
      ) : null}

      {slides.length > 0 || isDone ? (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-left transition-colors hover:bg-slate-100"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Layers className="h-4 w-4 text-indigo-500" />
              Slide breakdown
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">
                {Math.max(slides.length, result?.stats.slides ?? 0)}
              </span>
              {isProcessing ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin text-indigo-400" />
              ) : null}
            </span>
            {open ? (
              <ChevronUp className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            )}
          </button>

          {open ? (
            <div className="p-3 sm:p-4">
              {slides.length > 0 ? (
                <SlideBreakdown
                  slides={slides}
                  total={total}
                  fileName={file.name}
                  layout={result?.layout}
                  isProcessing={isProcessing}
                  generated={rebuilt}
                  onDownloadSlide={(index) => void download([index])}
                />
              ) : (
                <p className="text-sm text-slate-500">The transcription is not available.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {error || generation?.error ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error ?? generation?.error}</span>
        </div>
      ) : null}
    </li>
  );
}

interface ProgressBarProps {
  value: number;
  label: string;
  stage: string;
  slides: number;
  total: number;
}

function ProgressBar({ value, label, stage, slides, total }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-slate-500">
          <span className="font-semibold text-indigo-600">
            {STAGE_LABELS[stage] ?? "Working"}
          </span>
          {label ? ` — ${label}` : ""}
        </span>
        <span className="shrink-0 font-semibold tabular-nums text-slate-500">
          {total > 0 ? `${slides} / ${total} · ${clamped}%` : `${clamped}%`}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
      >
        <div
          className="h-full rounded-full bg-indigo-600 transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(4, clamped)}%` }}
        />
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
