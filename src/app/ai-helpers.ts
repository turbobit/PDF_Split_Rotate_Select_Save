import { type PDFDocumentProxy } from "pdfjs-dist";
import { buildSearchableTextSpans, normalizeOutlineTitle } from "./app-helpers";
import type { PdfChunkInput } from "./settings-store";

const CHUNK_MAX_CHARS = 1100;
const CHUNK_OVERLAP_WORDS = 28;

function splitIntoChunks(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let chunk = "";
    while (end < words.length) {
      const next = chunk ? `${chunk} ${words[end]}` : words[end];
      if (next.length > CHUNK_MAX_CHARS && chunk.length > 0) break;
      chunk = next;
      end += 1;
      if (chunk.length >= CHUNK_MAX_CHARS) break;
    }
    const normalized = normalizeOutlineTitle(chunk);
    if (normalized.length > 0) chunks.push(normalized);
    if (end >= words.length) break;
    start = Math.max(end - CHUNK_OVERLAP_WORDS, start + 1);
  }
  return chunks;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function extractPdfChunks(
  doc: PDFDocumentProxy,
  onProgress?: (pageNumber: number, totalPages: number) => void,
): Promise<{ chunks: PdfChunkInput[]; chunkSignature: string }> {
  const chunks: PdfChunkInput[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const spans = buildSearchableTextSpans(textContent.items);
    const joined = normalizeOutlineTitle(spans.join(" "));
    if (joined.length > 0) {
      const pageChunks = splitIntoChunks(joined);
      for (let chunkIndex = 0; chunkIndex < pageChunks.length; chunkIndex += 1) {
        const content = pageChunks[chunkIndex];
        const seed = `${pageNumber}:${chunkIndex}:${content}`;
        const hash = await sha256Hex(seed);
        chunks.push({
          chunkId: `chunk-${pageNumber}-${chunkIndex}-${hash.slice(0, 12)}`,
          pageNumber,
          chunkIndex,
          content,
        });
      }
    }
    onProgress?.(pageNumber, doc.numPages);
    if (pageNumber % 3 === 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  const signatureSeed = chunks.map((chunk) => `${chunk.pageNumber}:${chunk.chunkIndex}:${chunk.content}`).join("\n");
  const chunkSignature = await sha256Hex(signatureSeed);
  return { chunks, chunkSignature };
}
