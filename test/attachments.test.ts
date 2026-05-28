/**
 * test/attachments.test.ts
 *
 * Unit tests for src/sidepanel/lib/attachments.ts
 *
 * Covers:
 *   1. image file → kind:"image", dataUrl set, mediaType set
 *   2. text file → kind:"text", text set
 *   3. PDF file → kind:"pdf", text extracted (mocked extractPdfText)
 *   4. buildUserContent — text-only returns a STRING
 *   5. buildUserContent — text-only with inlined text attachment in the string
 *   6. buildUserContent — with image returns ARRAY containing image_url part
 *   7. buildUserContent — with image returns ARRAY containing text part first
 *   8. buildUserContent — pre-made pdf-kind attachment inlined into string/text part
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock pdfjs-dist BEFORE importing attachments (which imports pdf-extract)
// ---------------------------------------------------------------------------

vi.mock("pdfjs-dist", () => {
  return {
    default: {},
    getDocument: vi.fn(),
    GlobalWorkerOptions: { workerSrc: "" },
  };
});

// Mock pdf-extract so the heavy pdfjs worker is never instantiated in tests.
vi.mock("../src/sidepanel/lib/pdf-extract.js", () => ({
  extractPdfText: vi.fn(async () => "mocked pdf text"),
}));

// Import after mocks are set up.
import { readFileAsAttachment, buildUserContent, type Attachment } from "../src/sidepanel/lib/attachments.js";
import { extractPdfText } from "../src/sidepanel/lib/pdf-extract.js";

// ---------------------------------------------------------------------------
// FileReader mock (jsdom may not have a functioning FileReader.readAsDataURL)
// ---------------------------------------------------------------------------

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  error: Error | null = null;

  readAsDataURL(file: Blob) {
    // Simulate async completion.
    setTimeout(() => {
      this.result = `data:${(file as File).type};base64,FAKE`;
      this.onload?.();
    }, 0);
  }
}

// ---------------------------------------------------------------------------
// Helpers to create minimal File objects
// ---------------------------------------------------------------------------

function makeFile(name: string, type: string, content: string): File {
  return new File([content], name, { type });
}

function makeImageFile(name = "photo.png", type = "image/png"): File {
  // Content is just a dummy byte string — we never actually encode it.
  return new File(["PNG_BYTES"], name, { type });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachments — readFileAsAttachment", () => {
  beforeEach(() => {
    // Patch FileReader with our fake implementation.
    (globalThis as Record<string, unknown>).FileReader = FakeFileReader;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. image file → kind='image', dataUrl present, mediaType set", async () => {
    const file = makeImageFile();
    const att = await readFileAsAttachment(file);

    expect(att.kind).toBe("image");
    expect(att.name).toBe("photo.png");
    expect(att.mediaType).toBe("image/png");
    expect(att.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(att.text).toBeUndefined();
  });

  it("2. text file → kind='text', text populated", async () => {
    const file = makeFile("notes.txt", "text/plain", "hello world");
    const att = await readFileAsAttachment(file);

    expect(att.kind).toBe("text");
    expect(att.name).toBe("notes.txt");
    expect(att.text).toBe("hello world");
    expect(att.dataUrl).toBeUndefined();
  });

  it("3. PDF file → kind='pdf', text comes from extractPdfText", async () => {
    const file = makeFile("doc.pdf", "application/pdf", "%PDF-1.4 fake");
    const att = await readFileAsAttachment(file);

    expect(att.kind).toBe("pdf");
    expect(att.name).toBe("doc.pdf");
    expect(att.text).toBe("mocked pdf text");
    // extractPdfText should have been called once
    expect(extractPdfText).toHaveBeenCalledTimes(1);
  });
});

describe("attachments — buildUserContent", () => {
  it("4. no attachments → returns a STRING equal to the prompt", () => {
    const result = buildUserContent("What is this?", []);
    expect(typeof result).toBe("string");
    expect(result).toBe("What is this?");
  });

  it("5. text attachment → returns STRING with inlined block", () => {
    const atts: Attachment[] = [
      { kind: "text", name: "notes.txt", text: "line one\nline two" },
    ];
    const result = buildUserContent("Summarize this", atts);

    expect(typeof result).toBe("string");
    const s = result as string;
    expect(s).toContain("Summarize this");
    expect(s).toContain("--- attached: notes.txt ---");
    expect(s).toContain("line one\nline two");
  });

  it("6. image attachment → returns ARRAY containing image_url part", () => {
    const atts: Attachment[] = [
      { kind: "image", name: "photo.png", dataUrl: "data:image/png;base64,ABC", mediaType: "image/png" },
    ];
    const result = buildUserContent("Describe this image", atts);

    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ type: string; [k: string]: unknown }>;
    const imagePart = arr.find((p) => p.type === "image_url");
    expect(imagePart).toBeDefined();
    expect((imagePart as { type: string; image_url: { url: string } }).image_url.url).toBe("data:image/png;base64,ABC");
  });

  it("7. image attachment → text part is FIRST in the array", () => {
    const atts: Attachment[] = [
      { kind: "image", name: "shot.jpg", dataUrl: "data:image/jpeg;base64,XYZ", mediaType: "image/jpeg" },
    ];
    const result = buildUserContent("Describe", atts) as Array<{ type: string; [k: string]: unknown }>;

    expect(result[0].type).toBe("text");
    expect((result[0] as { type: "text"; text: string }).text).toContain("Describe");
  });

  it("8. pdf attachment (pre-made) inlined into text part / string", () => {
    const atts: Attachment[] = [
      { kind: "pdf", name: "contract.pdf", text: "CLAUSE 1: payment within 30 days" },
    ];
    const result = buildUserContent("Analyze this contract", atts);

    // pdf-only → no images → string result
    expect(typeof result).toBe("string");
    const s = result as string;
    expect(s).toContain("Analyze this contract");
    expect(s).toContain("--- attached: contract.pdf ---");
    expect(s).toContain("CLAUSE 1: payment within 30 days");
  });
});
