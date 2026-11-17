import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { parseRebuildPayload } from "@/lib/rebuildPayload";
import { slideDeadline } from "@/lib/slideFigureGen";
import { renderSlide } from "@/lib/slideRender";
import type { RebuildStreamEvent } from "@/lib/types";

/**
 * Rebuilds the transcribed slides on the standard template and streams one
 * picture per slide.
 *
 * The request carries the Markdown the browser already has, so this route never
 * touches the uploaded document: analysis and rebuild are two separate actions
 * and either one can be repeated without the other.
 */
export const maxDuration = 300;

/** Wide enough for the rail, the enlarged panel and a quick review. */
const PREVIEW_WIDTH = 1280;
const PREVIEW_QUALITY = 80;
/**
 * The figures are redrawn by the models, a minute each: this is the part of the
 * request that can run out of time, so it gets a budget of its own, short of
 * the 300 s the platform allows. Each slide takes a fair slice of it, so a deck
 * does not spend everything on its first pictures and leave the rest as panels.
 */
const FIGURE_BUDGET_MS = 250_000;

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "The request could not be read. Please try again." },
      { status: 400 },
    );
  }

  const parsed = parseRebuildPayload(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { slides, skipped } = parsed.payload;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const figuresDeadline = Date.now() + FIGURE_BUDGET_MS;

      const send = (event: RebuildStreamEvent): void => {
        if (closed) return;

        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The browser went away: the remaining slides are simply abandoned.
          closed = true;
        }
      };

      try {
        send({
          type: "progress",
          value: 2,
          message:
            slides.length === 1 ? "Rebuilding the slide…" : `Rebuilding ${slides.length} slides…`,
          total: slides.length,
        });

        let clipped = 0;

        for (let offset = 0; offset < slides.length; offset += 1) {
          if (closed) return;

          const slide = slides[offset];
          const rendered = await renderSlide(slide.markdown, {
            index: slide.index,
            width: PREVIEW_WIDTH,
            quality: PREVIEW_QUALITY,
            figures: slide.figures,
            crops: slide.figureCrops,
            source: slide.source,
            deadline: slideDeadline(figuresDeadline, slides.length - offset),
          });

          if (rendered.clipped) clipped += 1;

          send({
            type: "slide",
            slide: {
              index: slide.index,
              image: `data:image/jpeg;base64,${rendered.jpeg.toString("base64")}`,
              blocks: rendered.blocks,
              figures: rendered.figures,
              clipped: rendered.clipped,
              ...(rendered.review ? { review: rendered.review } : {}),
            },
          });

          send({
            type: "progress",
            value: Math.round(((offset + 1) / slides.length) * 100),
            message: `Slide ${offset + 1} of ${slides.length} rebuilt.`,
            total: slides.length,
          });
        }

        send({
          type: "done",
          message:
            slides.length === 1
              ? "Slide rebuilt."
              : `${slides.length} slides rebuilt on the template.`,
          slides: slides.length,
          clipped,
          skipped,
        });
      } catch (error) {
        send({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred while rebuilding the slides.",
        });
      } finally {
        closed = true;

        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
