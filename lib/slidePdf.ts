/**
 * A minimal PDF writer for image pages.
 *
 * The rebuilt slides are rasters: embedding the very same JPEG in the PDF keeps
 * the download identical to what the user saw in the preview, and avoids a
 * second font pipeline. The file is written by hand because one image per page
 * needs nothing more than an xref table and a content stream — no dependency,
 * no subsetting, no surprises.
 */

export interface PdfImagePage {
  /** JPEG bytes, already encoded. */
  jpeg: Buffer;
  width: number;
  height: number;
}

/** 13.33 × 7.5 in, the usual 16:9 slide size. */
const PAGE_WIDTH = 960;

export function buildImagePdf(pages: PdfImagePage[]): Buffer {
  if (pages.length === 0) throw new Error("A PDF needs at least one page.");

  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let size = 0;

  const push = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(buffer);
    size += buffer.length;
  };

  const startObject = (id: number): void => {
    offsets[id] = size;
    push(`${id} 0 obj\n`);
  };

  push("%PDF-1.4\n");
  push("%\u00e2\u00e3\u00cf\u00d3\n");

  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");

  startObject(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  startObject(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const pageHeight = Math.round((PAGE_WIDTH * page.height) / page.width);

    startObject(pageId);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${pageHeight}]` +
        ` /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );

    const content = `q\n${PAGE_WIDTH} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
    startObject(contentId);
    push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n`);
    push(content);
    push("endstream\nendobj\n");

    startObject(imageId);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    push("\nendstream\nendobj\n");
  });

  const objectCount = 2 + pages.length * 3;
  const xrefOffset = size;

  push(`xref\n0 ${objectCount + 1}\n`);
  push("0000000000 65535 f \n");
  for (let id = 1; id <= objectCount; id += 1) {
    push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(parts, size);
}
