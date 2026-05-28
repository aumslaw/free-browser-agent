/**
 * src/sidepanel/lib/attachments.ts
 *
 * Unified file-attachment helper for the Free Browser Agent side panel.
 *
 * Supports:
 *   - image/*       → read as data-URL (base64)
 *   - application/pdf → extract text via pdf-extract.ts
 *   - everything else (text/*, .md, .json, .csv, code) → read as UTF-8 text
 *
 * `buildUserContent` composes the Anthropic/OpenAI-compatible message content:
 *   - No images → plain string (prompt + inlined text/pdf blocks)
 *   - Image(s)  → Array<text-part | image_url-part>
 */

import { extractPdfText } from "./pdf-extract.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Attachment {
  kind: "image" | "text" | "pdf";
  name: string;
  /** Set for image attachments — the data: URL string. */
  dataUrl?: string;
  /** MIME type, set for images (e.g. "image/png"). */
  mediaType?: string;
  /** Set for text / pdf attachments — the extracted / raw text. */
  text?: string;
}

// ---------------------------------------------------------------------------
// readFileAsAttachment
// ---------------------------------------------------------------------------

/**
 * Read a browser File and return an Attachment promise.
 * - image/* → FileReader.readAsDataURL
 * - application/pdf → ArrayBuffer → extractPdfText
 * - else → file.text()
 */
export async function readFileAsAttachment(file: File): Promise<Attachment> {
  const { name, type } = file;

  if (type.startsWith("image/")) {
    const dataUrl = await readAsDataURL(file);
    return { kind: "image", name, dataUrl, mediaType: type };
  }

  if (type === "application/pdf") {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf);
    return { kind: "pdf", name, text };
  }

  // Fallback: treat as plain text (text/*, .md, .json, .csv, source code, etc.)
  const text = await file.text();
  return { kind: "text", name, text };
}

// ---------------------------------------------------------------------------
// buildUserContent
// ---------------------------------------------------------------------------

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };

/**
 * Build the `content` field for a user ChatMessage.
 *
 * - No image attachments → returns a STRING (plain-text prompt + inlined blocks)
 * - Image attachment(s) → returns an ARRAY with one text part + one image_url
 *   part per image, so vision-capable models receive the images inline.
 */
export function buildUserContent(
  prompt: string,
  atts: Attachment[]
): string | Array<TextPart | ImagePart> {
  // Inline all text/pdf attachments into the text part.
  const textBlocks = atts
    .filter((a) => a.kind === "text" || a.kind === "pdf")
    .map((a) => `\n\n--- attached: ${a.name} ---\n${a.text ?? ""}`)
    .join("");

  const textContent = prompt + textBlocks;

  const images = atts.filter((a) => a.kind === "image" && a.dataUrl);

  if (images.length === 0) {
    // No images — return plain string for maximum provider compatibility.
    return textContent;
  }

  // Has images → return structured array.
  const parts: Array<TextPart | ImagePart> = [
    { type: "text", text: textContent },
    ...images.map(
      (a): ImagePart => ({
        type: "image_url",
        image_url: { url: a.dataUrl! },
      })
    ),
  ];

  return parts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
