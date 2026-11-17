"use client";

import React, { useCallback, useRef, useState } from "react";

import { FileImport } from "@/components/FileImport";
import { Header } from "@/components/Header";
import { MaterialRow } from "@/components/MaterialRow";
import type {
  AnalysisStreamEvent,
  GenerationState,
  MaterialItem,
  RebuildStreamEvent,
} from "@/lib/types";

const ALLOWED_EXTENSIONS = [".pdf", ".pptx"];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Reads the newline-delimited JSON stream returned by the API routes. */
async function readStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as T);
    } catch {
      // A malformed line must not abort the whole run.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      parseLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  parseLine(buffer);
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}

/** Reads `filename="…"` from the Content-Disposition of the PDF response. */
function pdfFileName(response: Response, sourceName: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="?([^";]+)"?/i.exec(header);
  if (match) return match[1].trim();

  return `${sourceName.replace(/\.[^.]+$/, "")}-rebuilt.pdf`;
}

/** Hands a generated file to the browser without leaving an object URL behind. */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function Home() {
  const [items, setItems] = useState<MaterialItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(0);

  const updateItem = useCallback((id: string, patch: Partial<MaterialItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  /** Step 1: queue the dropped/selected files, no processing yet. */
  const addFiles = useCallback((incoming: File[] | FileList) => {
    const files = Array.from(incoming);
    if (files.length === 0) return;

    const rejected: string[] = [];
    const accepted: MaterialItem[] = [];

    for (const file of files) {
      const extension = extensionOf(file.name);

      if (extension === ".ppt") {
        rejected.push(`${file.name} (legacy .ppt: save it as .pptx first)`);
        continue;
      }
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        rejected.push(`${file.name} (unsupported type)`);
        continue;
      }
      if (file.size === 0) {
        rejected.push(`${file.name} (empty file)`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} (larger than 25 MB)`);
        continue;
      }

      nextId.current += 1;
      accepted.push({
        id: `material-${nextId.current}-${file.lastModified}`,
        file,
        status: "ready",
        progress: 0,
        stage: "idle",
        message: "",
        slideTotal: 0,
        slides: [],
      });
    }

    setItems((current) => {
      const seen = new Set(current.map((item) => `${item.file.name}:${item.file.size}`));
      const next = [...current];
      for (const item of accepted) {
        const key = `${item.file.name}:${item.file.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(item);
      }
      return next;
    });

    setError(rejected.length > 0 ? `Not added: ${rejected.join("; ")}.` : null);
  }, []);

  /** Step 2: let the model transcribe every slide and stream it back. */
  const startAnalysis = useCallback(
    async (id: string) => {
      const target = items.find((item) => item.id === id);
      if (!target || target.status === "processing") return;

      updateItem(id, {
        status: "processing",
        progress: 0,
        stage: "queued",
        message: "Queued…",
        error: undefined,
        result: undefined,
        slides: [],
        slideTotal: 0,
        generation: undefined,
      });

      const formData = new FormData();
      formData.append("file", target.file);

      try {
        const response = await fetch("/api/analyze", { method: "POST", body: formData });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(
            payload?.error ?? `The server rejected the file (HTTP ${response.status}).`,
          );
        }

        let settled = false;

        await readStream<AnalysisStreamEvent>(response.body, (event) => {
          if (event.type === "progress") {
            updateItem(id, {
              progress: event.value,
              stage: event.stage,
              message: event.message,
              ...(event.total ? { slideTotal: event.total } : {}),
            });
            return;
          }

          if (event.type === "slide") {
            setItems((current) =>
              current.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      slideTotal: event.slide.total,
                      slides: [...item.slides, event.slide],
                    }
                  : item,
              ),
            );
            return;
          }

          settled = true;

          if (event.type === "done") {
            updateItem(id, {
              status: "done",
              progress: 100,
              stage: "completed",
              message: event.result.message,
              result: event.result,
              error: undefined,
            });
            return;
          }

          updateItem(id, { status: "error", stage: "failed", message: "", error: event.message });
        });

        if (!settled) {
          updateItem(id, {
            status: "error",
            stage: "failed",
            message: "",
            error: "The connection closed before the analysis finished. Please try again.",
          });
        }
      } catch (failure) {
        updateItem(id, {
          status: "error",
          stage: "failed",
          message: "",
          error: failure instanceof Error ? failure.message : "An unexpected error occurred.",
        });
      }
    },
    [items, updateItem],
  );

  /** Adds `generation` to a material and merges a patch into it. */
  const mergeGeneration = useCallback(
    (id: string, patch: (current: GenerationState) => Partial<GenerationState>) => {
      setItems((current) =>
        current.map((item) => {
          if (item.id !== id) return item;

          const previous: GenerationState = item.generation ?? {
            status: "idle",
            progress: 0,
            message: "",
            slides: [],
            skipped: [],
          };

          return { ...item, generation: { ...previous, ...patch(previous) } };
        }),
      );
    },
    [],
  );

  /**
   * Step 3, independent of the analysis: lay every transcribed slide out on the
   * template. The browser sends the Markdown it already has, so nothing is
   * re-read from the document and the two steps can run in any order.
   */
  const startGeneration = useCallback(
    async (id: string) => {
      const target = items.find((item) => item.id === id);
      if (!target || target.status === "processing") return;
      if (target.generation?.status === "processing") return;

      const transcribed = target.slides.filter((slide) => slide.usedAI);
      if (transcribed.length === 0) {
        mergeGeneration(id, () => ({
          status: "error",
          error: "There is nothing to rebuild yet: analyze the material first.",
        }));
        return;
      }

      mergeGeneration(id, () => ({
        status: "processing",
        progress: 0,
        message: "Queued…",
        slides: [],
        skipped: [],
        error: undefined,
      }));

      try {
        // One request per slide. The figures of a slide are drawn, judged and
        // repaired inside a single request, and the request has the whole
        // function budget for that one slide instead of a fair share of the
        // deck's: a hard figure is no longer a first draft nobody had time to
        // review because seven other slides were queued behind it.
        for (const [offset, slide] of transcribed.entries()) {
          mergeGeneration(id, () => ({
            status: "processing",
            message: `Rebuilding slide ${offset + 1} of ${transcribed.length}…`,
          }));

          const response = await fetch("/api/rebuild", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fileName: target.file.name,
              slides: [
                {
                  index: slide.index,
                  markdown: slide.markdown,
                  figures: slide.figures,
                  figureCrops: slide.figureCrops,
                  source: slide.thumbnail,
                },
              ],
            }),
          });

          if (!response.ok || !response.body) {
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(
              payload?.error ?? `The server rejected the request (HTTP ${response.status}).`,
            );
          }

          let rebuilt = false;
          let failure: string | null = null;

          await readStream<RebuildStreamEvent>(response.body, (event) => {
            if (event.type === "slide") {
              rebuilt = true;
              mergeGeneration(id, (current) => ({
                status: "processing",
                slides: [
                  ...current.slides.filter((entry) => entry.index !== event.slide.index),
                  event.slide,
                ].sort((left, right) => left.index - right.index),
              }));
              return;
            }

            if (event.type === "error") {
              failure = event.message;
              return;
            }

            if (event.type === "done") rebuilt = true;
          });

          if (failure) throw new Error(failure);
          if (!rebuilt) {
            throw new Error(`Slide ${slide.index} was not rebuilt. Please try again.`);
          }

          mergeGeneration(id, () => ({
            status: "processing",
            progress: Math.round(((offset + 1) / transcribed.length) * 100),
            message: `Slide ${offset + 1} of ${transcribed.length} rebuilt.`,
          }));
        }

        mergeGeneration(id, () => ({
          status: "done",
          progress: 100,
          message:
            transcribed.length === 1
              ? "Slide rebuilt."
              : `${transcribed.length} slides rebuilt on the template.`,
          error: undefined,
        }));
      } catch (failure) {
        mergeGeneration(id, () => ({
          status: "error",
          error: failure instanceof Error ? failure.message : "An unexpected error occurred.",
        }));
      }
    },
    [items, mergeGeneration],
  );

  /**
   * Download of the rebuilt deck, or of a single rebuilt slide. The pages are
   * rendered again at full size, so the PDF never depends on the previews.
   */
  const downloadRebuilt = useCallback(
    async (id: string, indexes?: number[]) => {
      const target = items.find((item) => item.id === id);
      if (!target) return;

      const selected = target.slides.filter(
        (slide) => slide.usedAI && (!indexes || indexes.includes(slide.index)),
      );
      if (selected.length === 0) return;

      try {
        const response = await fetch("/api/rebuild/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: target.file.name,
            slides: selected.map(({ index, markdown, figures, figureCrops, thumbnail }) => ({
              index,
              markdown,
              figures,
              figureCrops,
              source: thumbnail,
            })),
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `The server rejected the request (HTTP ${response.status}).`);
        }

        saveBlob(await response.blob(), pdfFileName(response, target.file.name));
        mergeGeneration(id, () => ({ error: undefined }));
      } catch (failure) {
        // The rebuild itself is untouched: only the download failed.
        mergeGeneration(id, () => ({
          error: failure instanceof Error ? failure.message : "The PDF could not be downloaded.",
        }));
      }
    },
    [items, mergeGeneration],
  );

  const removeItem = useCallback((id: string) => {
    setItems((current) =>
      current.filter((item) => item.id !== id || item.status === "processing"),
    );
  }, []);

  const clearAll = useCallback(() => {
    setItems((current) => current.filter((item) => item.status === "processing"));
    setError(null);
  }, []);

  const hasRemovableItems = items.some((item) => item.status !== "processing");

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <Header />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-8 sm:px-6 sm:py-12">
        <FileImport
          dragOver={dragOver}
          error={error}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            addFiles(event.dataTransfer.files);
          }}
          onFilesChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            // Reset so the same file can be queued again later.
            event.target.value = "";
          }}
        />

        {items.length > 0 ? (
          <section className="mt-10">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Your material ({items.length})
              </h2>
              {hasRemovableItems ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs font-medium text-slate-500 transition-colors hover:text-rose-600"
                >
                  Remove all
                </button>
              ) : null}
            </div>

            <ul className="space-y-3">
              {items.map((item) => (
                <MaterialRow
                  key={item.id}
                  item={item}
                  onAnalyze={startAnalysis}
                  onGenerate={startGeneration}
                  onDownload={downloadRebuilt}
                  onRemove={removeItem}
                />
              ))}
            </ul>

            <p className="mt-5 text-xs text-slate-400">
              Analysis and rebuild are two separate steps: analyze a material to transcribe every
              slide, then rebuild the deck on the shared template. Hold the eye on a slide to see
              its rebuilt version.
            </p>
          </section>
        ) : null}
      </main>

      <footer className="border-t bg-white px-6 py-4 text-center text-xs text-slate-400">
        StudentClash AI &middot; slides read as images, transcribed with DeepSeek, page furniture
        separated, then rebuilt on a shared template
      </footer>
    </div>
  );
}


