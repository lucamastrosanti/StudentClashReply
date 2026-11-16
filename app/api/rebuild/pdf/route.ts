import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { parseRebuildPayload, rebuiltFileName } from "@/lib/rebuildPayload";
import { slideDeadline } from "@/lib/slideFigureGen";
import { buildImagePdf } from "@/lib/slidePdf";
import { renderSlide } from "@/lib/slideRender";

/**
 * Download of the rebuilt slides: the same pages the preview shows, at full
 * size, assembled into a PDF. One slide or the whole deck, depending on what
 * the browser sends.
 */
export const maxDuration = 300;

/**
 * The figures are redrawn by the models, a minute each: the deck PDF is one
 * request, so they get a budget short of the 300 s the platform allows, shared
 * fairly between the slides.
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

  const { fileName, slides } = parsed.payload;

  try {
    const pages = [];
    const figuresDeadline = Date.now() + FIGURE_BUDGET_MS;

    for (let offset = 0; offset < slides.length; offset += 1) {
      const slide = slides[offset];
      const rendered = await renderSlide(slide.markdown, {
        index: slide.index,
        figures: slide.figures,
        source: slide.source,
        deadline: slideDeadline(figuresDeadline, slides.length - offset),
      });
      pages.push({ jpeg: rendered.jpeg, width: rendered.width, height: rendered.height });
    }

    const pdf = buildImagePdf(pages);
    const bytes = new Uint8Array(pdf);
    const name = rebuiltFileName(fileName, slides);

    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The rebuilt PDF could not be generated.",
      },
      { status: 500 },
    );
  }
}
