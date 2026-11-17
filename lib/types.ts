/**
 * Shared types for the slide-breakdown pipeline.
 *
 * This module is intentionally free of Node.js imports so that it can be
 * imported (type-only) from client components as well as from route handlers.
 */

import type { SlideFigure, SlideReview } from "@/lib/slideFigures";

export type SourceType = "pdf" | "pptx";

/**
 * A marginal element the vision model deliberately kept out of the slide
 * content: running header/footer, logo, page number, author, date, …
 */
export interface SlideLayoutElement {
  /** Canonical area of the slide: top-left … bottom-right, background, full-width. */
  position: string;
  /** Short lowercase label: running-header, logo, page-number, author, … */
  kind: string;
  /** Text exactly as printed, or a bracketed description for pure graphics. */
  text: string;
}

/** One slide of the source document, transcribed by the vision model. */
export interface SlideAnalysis {
  /** 1-based slide/page number in the source document. */
  index: number;
  /** Slides analysed in this run (after the per-run limit). */
  total: number;
  /** Small JPEG (data URL) of the slide exactly as the model saw it. */
  thumbnail: string;
  /** Markdown transcription of the slide content, page furniture excluded. */
  markdown: string;
  /** Visual elements to recreate and place on the rebuilt slide. */
  figures: SlideFigure[];
  /**
   * One high-resolution JPEG (data URL) per figure, keyed by figure id, rendered
   * from the document itself. A figure is a small part of the page raster, so
   * cropping it from the thumbnail would leave its text unreadable.
   */
  figureCrops?: Record<string, string>;
  /** Page furniture found on this slide and kept out of `markdown`. */
  layout: SlideLayoutElement[];
  /** False when the model could not describe this slide. */
  usedAI: boolean;
  /** Diagnostic reason when `usedAI` is false. */
  note?: string;
}

export type AnalysisStage =
  | "queued"
  | "converting"
  | "rendering"
  | "analyzing"
  | "completed"
  | "failed";

export interface AnalysisStats {
  /** Slides transcribed: the document has exactly as many entries. */
  slides: number;
  aiSlides: number;
  failedSlides: number;
  sourceType: SourceType;
  /** True when the document had more slides than the per-run limit. */
  truncated: boolean;
}

/** One furniture element merged across the whole deck. */
export interface LayoutFinding {
  /** Canonical kind, e.g. running-header, logo, page-number. */
  kind: string;
  /** Where the element sits, e.g. bottom-right. */
  position: string;
  /** Representative text (the first occurrence for sequential elements). */
  text: string;
  /** 1-based slides where it appears, sorted. */
  slides: number[];
  /** True when the element stays but its text changes (page numbers, dates, counters). */
  sequential: boolean;
  /** Distinct values in slide order, for sequential elements. */
  values: string[];
}

/** Deck-level summary of the elements that were excluded from the slides. */
export interface LayoutSummary {
  /** Markdown summary shown above the transcriptions. */
  markdown: string;
  /** The merged inventory the summary is based on. */
  findings: LayoutFinding[];
  /** True when the text model wrote the narrative part of the summary. */
  usedAI: boolean;
}

export interface AnalysisResult {
  status: "success";
  message: string;
  stats: AnalysisStats;
  /** Page furniture detected across the deck and removed from the slides. */
  layout: LayoutSummary;
  highlights: string[];
}

/* -------------------------------------------------------------------------- */
/* Rebuilt deck                                                               */
/* -------------------------------------------------------------------------- */

/** One slide rebuilt on the standard template, as a JPEG data URL. */
export interface GeneratedSlide {
  /** 1-based slide/page number in the source document. */
  index: number;
  /** JPEG data URL of the rebuilt slide (background + content + figures). */
  image: string;
  /** Content blocks that were laid out on the slide. */
  blocks: number;
  /** Figures recreated from the original slide and placed on this slide. */
  figures: number;
  /** True when part of the content did not fit and was clipped. */
  clipped: boolean;
  /**
   * The verdict of the model that compared this slide with the original, when
   * it had the time to do it: what is still wrong, if anything.
   */
  review?: SlideReview;
}

/** Client-side state of the rebuild step, which is separate from the analysis. */
export interface GenerationState {
  status: "idle" | "processing" | "done" | "error";
  /** 0..100 */
  progress: number;
  message: string;
  /** Slides whose content was laid out. */
  slides: GeneratedSlide[];
  /** Slides left out because the analysis could not describe them. */
  skipped: number[];
  error?: string;
}

/** One slide sent to the rebuild endpoint: its content and its figures. */
export interface RebuildSlideInput {
  index: number;
  markdown: string;
  /** Visual elements of the original slide, with the area each one occupied. */
  figures?: SlideFigure[];
  /** High-resolution JPEG per figure, keyed by figure id. */
  figureCrops?: Record<string, string>;
  /** Compact JPEG data URL of the original slide, the reference for the figures. */
  source?: string;
}

export interface RebuildProgressEvent {
  type: "progress";
  /** 0..100 */
  value: number;
  message: string;
  total: number;
}

export interface RebuildSlideEvent {
  type: "slide";
  slide: GeneratedSlide;
}

export interface RebuildDoneEvent {
  type: "done";
  message: string;
  slides: number;
  clipped: number;
  skipped: number[];
}

export interface RebuildErrorEvent {
  type: "error";
  message: string;
}

export type RebuildStreamEvent =
  | RebuildProgressEvent
  | RebuildSlideEvent
  | RebuildDoneEvent
  | RebuildErrorEvent;

export interface AnalysisProgressEvent {
  type: "progress";
  stage: AnalysisStage;
  /** 0..100 */
  value: number;
  message: string;
  /** Slides announced by the server once the document has been opened. */
  total?: number;
}

export interface AnalysisSlideEvent {
  type: "slide";
  slide: SlideAnalysis;
}

export interface AnalysisDoneEvent {
  type: "done";
  result: AnalysisResult;
}

export interface AnalysisErrorEvent {
  type: "error";
  message: string;
}

export type AnalysisStreamEvent =
  | AnalysisProgressEvent
  | AnalysisSlideEvent
  | AnalysisDoneEvent
  | AnalysisErrorEvent;

/* -------------------------------------------------------------------------- */
/* Browser-side material queue                                                 */
/* -------------------------------------------------------------------------- */

export type MaterialStatus = "ready" | "processing" | "done" | "error";

/** One uploaded material shown in the list, with its own analysis state. */
export interface MaterialItem {
  id: string;
  file: File;
  status: MaterialStatus;
  /** 0..100 */
  progress: number;
  stage: AnalysisStage | "idle";
  message: string;
  /** Total slides announced by the server while the run is in progress. */
  slideTotal: number;
  /** Slides received so far, in arrival order. */
  slides: SlideAnalysis[];
  result?: AnalysisResult;
  error?: string;
  /** The separate rebuild step: absent until the user asks for it. */
  generation?: GenerationState;
}
