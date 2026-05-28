/**
 * src/sidepanel/lib/pdf-extract.ts
 *
 * Extract text content from a PDF ArrayBuffer using pdfjs-dist.
 * Caps to 20 pages / 50k chars to avoid overloading the LLM context.
 *
 * The worker is bundled by Vite via the `new URL(...)` dynamic import pattern.
 */

import * as pdfjsLib from "pdfjs-dist";

// Vite will bundle the worker when it sees this `new URL(...)` pattern.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const MAX_PAGES = 20;
const MAX_CHARS = 50_000;

/**
 * Extract text from a PDF given its raw ArrayBuffer.
 * Returns the concatenated text, capped at MAX_PAGES pages and MAX_CHARS chars.
 */
export async function extractPdfText(data: ArrayBuffer): Promise<string> {
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  const pageCount = Math.min(pdf.numPages, MAX_PAGES);
  const parts: string[] = [];
  let totalChars = 0;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");

    const remaining = MAX_CHARS - totalChars;
    if (remaining <= 0) break;

    if (pageText.length > remaining) {
      parts.push(pageText.slice(0, remaining));
      break;
    }

    parts.push(pageText);
    totalChars += pageText.length;
  }

  return parts.join("\n\n").trim();
}
