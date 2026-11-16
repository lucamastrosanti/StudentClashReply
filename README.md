# StudentClashReply

Read a lecture deck the way a person does: **one slide at a time, as a picture**.
The vision model transcribes the real content of every slide into structured
Markdown — prose with its original indentation, code verbatim, real tables,
formulas — while the pictures, diagrams and charts of the slide are reported
separately, each with the area it occupies, and the page furniture (running
headers, footers, logos, professor names, page numbers, dates, …) is kept out of
that Markdown and collected in a deck-level summary.

On top of the transcription there is a second, independent step: **rebuild**.
Each transcribed slide is laid out again on one shared template — the slide's own
background artwork plus everything the analysis found on that slide, and nothing
of the page furniture — then previewed in place and downloaded. Every picture is
redrawn from its own crop of the original slide and put back where it was.
Analysis and rebuild are two separate buttons: rebuilding never triggers a new
analysis, and analyzing again never rebuilds anything.

## Setup

```bash
npm install
```

Create `.env.local` in the project root:

```ini
DEEPSEEK_API_KEY=sk-...
```

The key is **required**: the analysis is the model.

```bash
npm run dev     # http://localhost:3000
npm run build && npm start
npm run lint
```

### PPTX conversion

Every input is reduced to a PDF, so that every page can be rasterised:

1. LibreOffice (`soffice`) when installed — works on Linux servers and can be
   pointed at with `SOFFICE_PATH`;
2. PowerPoint through COM automation on Windows, when Office is installed.

Without one of the two, `.pptx` uploads fail with a clear message; `.pdf`
uploads always work.

## How it works

1. **Upload** one or more `.pdf` / `.pptx` files (max 25 MB each). Nothing is
   processed until you ask for it.
2. **Analyze** one material: `POST /api/analyze` streams newline-delimited JSON.
3. **Read** the breakdown: slide thumbnails on the left, the transcription of
   the selected slide on the right, slide by slide as it arrives. Each slide
   also lists what was kept out of its Markdown and the pictures that will be
   redrawn.
4. **Check the layout summary** above the breakdown: it merges the furniture
   found on every slide, counts the repetitions and marks sequential elements
   such as page numbers.
5. **Rebuild** the deck, when you want it: `POST /api/rebuild` streams one
   picture per slide. Every rebuilt slide gets two small buttons in its corner —
   hold the eye to see the rebuilt version in place (release to go back), or
   download that single slide as a PDF. The deck PDF is a third button
   (`POST /api/rebuild/pdf`).

### Pipeline (`app/api/analyze/route.ts`)

| Stage | Module | What happens |
| --- | --- | --- |
| Conversion | `lib/pptxToPdf.ts` | `.pptx` → PDF with LibreOffice (`soffice --headless`) or PowerPoint COM (`SaveAs(..., 32)`). PDFs pass through untouched. |
| Raster | `lib/pdfPages.ts` | Each page is rendered once with pdf.js on a native Skia canvas at 1500 px: a full JPEG for the model and a 520 px JPEG for the rail. |
| Transcription | `lib/slideDescriber.ts` | One image in, three blocks out: the content Markdown (no section headers), the picture inventory as JSON (`id`, `position`, `kind`, box, `description`, `labels`, `palette`) and the furniture inventory (`POSITION \| KIND \| TEXT`). |
| Aggregation | `lib/layoutSummary.ts` | Merges the furniture of every slide, counts the repetitions and detects sequential values (page numbers, counters, dates) by masking digits. |
| Layout summary | `lib/slideDescriber.ts` | A second, text-only call names the patterns in the measured inventory. If it fails, the deterministic summary is used and the UI marks it `automatic`. |
| Stream | route | `progress` events, one `slide` event per transcription, then `done` (result, stats and layout summary) or `error`. |

Two model calls run at a time; the breakdown opens on the first slide and any
slide can be pinned by clicking its thumbnail. The vision model occasionally
answers with nothing at all, so an empty answer is retried twice (with a warmer
temperature) before that slide is reported as failed.

### Rebuild pipeline (`app/api/rebuild/*`)

| Stage | Module | What happens |
| --- | --- | --- |
| Request | `lib/rebuildPayload.ts` | The browser posts the Markdown it already has — never the document — plus the pictures of each slide and one JPEG of the original slide. Slides without a transcription are skipped and reported. |
| Parse | `lib/slideMarkdown.ts` | The transcription becomes a block model: title, sections, lists, code, tables, quotes; LaTeX formulas become readable Unicode. |
| Figures | `lib/slideFigureGen.ts` | Every picture is cropped out of the original slide and scaled up, then drawn by a rolling review: `deepseek-flash` looks at the crop and writes a precise brief (shapes, positions, colours, texts), `deepseek-v4-pro` turns that brief plus the crop into SVG at the size of the reserved rectangle, and a second look with both pictures side by side scores the drawing 0-10 and lists what is wrong. A drawing below 7 is sent back with that list and drawn again — at most two repairs, while the clock allows — and the best-scoring attempt is the one that is kept. The answer is cleaned, rasterised at twice its size, measured — the ink is cropped out of the canvas and fitted to the rectangle — and cached by content; two figures are drawn at a time, an answer that comes out empty is retried, and the vision model alone is the fallback when the figure budget runs out. |
| Plan | `lib/slideLayout.ts` | The picture rectangles are reserved first, then the title and the sections are set in the largest free band — two columns when one is not enough — while the type size steps down until everything fits. A block that still does not fit is dropped whole (replaced by an ellipsis) instead of being cut in half; if pictures are what leaves too little room, they shrink a little and the text is planned again. |
| Draw | `lib/slideTheme.ts` | The template artwork is vector, not a bitmap: four corner clusters in three blues plus one warm accent. Nothing is painted inside the text frame. |
| Encode | `lib/slideRender.ts` | One canvas at 1920×1080, then a JPEG: 1280 px for the preview, full size for the PDF. Once the page is painted, `deepseek-flash` compares it with the original slide: `ok`, a score, and up to four issues. A figure it names is drawn once more with the issue as the verdict and the page is painted again; text and layout issues cannot be rewritten here and are reported with the slide instead. |
| PDF | `lib/slidePdf.ts` | Image pages are written directly (xref table, one image per page, `DCTDecode`), so the download is exactly the picture that was previewed. |

The rebuilt slide carries content only: headers, footers, logos and page numbers
stay out, as they already did in the Markdown. Pictures are redrawn from their
own crop of the original slide and drawn back into the rectangle the analysis
gave them, so a chart on the left stays on the left. Drawing is the slow part of
a rebuild — about a minute per drawing, and a drawing sent back costs another —
so the whole request keeps a budget of 250 s for it, shared fairly between the
slides: each one gets a slice of what is left, and it is drawn again from the
crop alone, without the brief, when its slice is too short for the pair. Nothing
on the slide is one-shot: every drawing is judged against its crop before it
counts, and the finished page is judged against the original slide, so a figure
that only looks wrong next to the text can still be redrawn. Both judgements are
fail-open — a reviewer that times out, refuses or answers nonsense leaves the
drawing that exists — and both are skipped when the slice is too short to act on
what they say. A picture that no model could draw (an unusable answer after the
retries, or no model at all) falls back to a labelled panel with its description,
and is not counted among the redrawn ones. The PDF pages are raster, so their
text is not selectable.

The artwork lives only in `lib/slideTheme.ts`: replacing it with the final design
means changing `drawSlideBackground` and nothing else.

### What the model is asked

A single generic prompt with three parts.

**Content**: transcribe everything that carries the message verbatim in reading
order with its indentation, reproduce tables as Markdown tables with their real
number of rows and columns, reproduce code exactly in fenced blocks, write
formulas in LaTeX, and never summarise, invent or omit. No section headers of any
kind — no `## Testo`, no `## Codice`, nothing in front of a block — because the
original slide does not print them; pictures are not described here and the text
printed inside them is not repeated here.

**Figures**: every picture, photo, diagram, scheme, flow chart, graph, plot,
screenshot or map as one JSON array, each entry with a stable `id`, a `position`,
a `kind`, the box the element occupies as fractions of the slide
(`left`/`top`/`width`/`height`), a `description` precise enough to draw it again,
the `labels` printed inside it in reading order and at most five `palette`
colours. Separate elements get separate boxes; a slide with no picture answers
`[]`.

**Layout**: list every element that is page furniture rather than content —
running headers/footers, logos and institutional marks, course/professor names,
contacts, page numbers and counters, dates, revision codes, confidentiality
notes, watermarks, backgrounds, decorations, borders, progress bars, navigation
icons, QR codes — one per line as `POSITION | KIND | TEXT`, keeping the wording
stable across slides and copying sequential values exactly. A cover slide keeps
its own title as content.

The answer is three sentinel-delimited blocks, which survive long code listings
far better than escaped JSON:

```text
<<<CONTENT>>>
# Risultati del progetto
**Partecipanti** …
<<<FIGURES>>>
[{"id":"figura-1","position":"middle-left","kind":"bar-chart","left":0.05,
  "top":0.3,"width":0.4,"height":0.45,"description":"…","labels":["2022","2023"],"palette":["#6b4ce6"]}]
<<<LAYOUT>>>
top-center | running-header | Reti di Calcolatori
bottom-center | page-number | Pagina 3 di 24
<<<END>>>
```

If a furniture line still leaks into the content as a standalone line, it is
removed; headings are never touched. Those elements live only in the layout
summary, which the second model call writes from the measured inventory. The
same safety net drops a content line that repeats exactly one of the labels of a
picture — that text belongs to the picture, which is redrawn with it inside.

## Limits

- 60 slides per file, 25 MB per upload, `.pdf` and `.pptx` only (`.ppt` is
  rejected with a clear message).
- A slide that the model cannot read is reported as a failed slide (marked with
  `!` in the rail) and the rest of the deck keeps going; an empty answer is
  retried twice first, and a configuration error (wrong key, model refusing
  images) aborts the run instead of repeating the same failure 60 times.
- Before a run starts, the balance of the DeepSeek account is checked: an empty
  wallet would otherwise fail on every slide with `HTTP 402 Insufficient Balance`.
  If the credit runs out mid-deck, the run stops at once with that explanation
  and the slides already transcribed are kept.
- A rebuilt slide whose content does not fit is first set in a smaller type; if
  that is still not enough, the pictures shrink a little; if even that is not
  enough, whole blocks are dropped and the preview says the content was trimmed.
- Redrawn pictures are the model's own drawing of the crop: shapes and colours
  follow the original, while small print inside a chart (axis labels, legends)
  can be simplified or left out. A picture that could not be drawn keeps a
  labelled panel with its description, and the preview counts only the ones that
  were actually redrawn.
- The rebuilt slide is posted with its pictures and one JPEG of the original
  slide: a very dense deck makes that request large. Slides above 60 per file are
  still refused before any of this.
- The transcription is stored in the browser only: reloading the page loses it.
  The rebuilt slides live in memory until they are downloaded.
