import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, type PDFRef, degrees } from "pdf-lib";
import { type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";

export const THUMBNAIL_SCALE = 0.22;
export const IMAGE_EXPORT_SCALE = 2;
export const THUMB_ITEM_HEIGHT = 206;
export const THUMB_OVERSCAN = 10;
export const THUMB_PREFETCH = 14;
export const THUMBNAIL_CONCURRENCY = 3;
export const THUMB_CACHE_LIMIT = 420;
export const OUTLINE_MAX_DEPTH = 4;
export const OUTLINE_TEXT_CANDIDATE_LIMIT = 80;
export const OUTLINE_LOAD_TIMEOUT_MS = 4500;
export const OUTLINE_SAVE_WAIT_TIMEOUT_MS = 5000;
export const OUTLINE_SAVE_WAIT_POLL_MS = 120;
export const PREVIEW_TEXT_SPAN_LIMIT = 2600;
export const ZOOM_MIN = 25;
export const ZOOM_MAX = 400;
export const ZOOM_STEP = 10;
export const APP_VERSION = "0.1.1";
export const PROJECT_REPO_URL = "https://github.com/turbobit/PDF_Split_Rotate_Select_Save";

export type SaveType = "pdf" | "png" | "jpg";
export type Locale = "ko" | "en";
export type SidebarTab = "thumbnails" | "outline";
export type OutlinePanelMode = "view" | "edit";
export type StatusState =
  | { type: "ready" }
  | { type: "loadingPdf" }
  | { type: "loaded"; pages: number }
  | { type: "savingPdf" }
  | { type: "savedPdf"; pages: number }
  | { type: "savingImages"; done: number; total: number }
  | { type: "savedImages"; total: number }
  | { type: "failed"; reason: "pdfLoad" | "pdfSave" | "imageSave" };

export type OutlineEntrySource = "pdf" | "text" | "manual";

export type OutlineEntry = {
  id: string;
  title: string;
  pageNumber: number;
  depth: number;
  source: OutlineEntrySource;
};

export type PdfOutlineNode = {
  title: string;
  dest: string | Array<unknown> | null;
  items: PdfOutlineNode[];
};

export type PdfPageRefLike = {
  num: number;
  gen: number;
};

export type TextItemLike = {
  str: string;
};

export type OutlineTreeNode = {
  title: string;
  pageNumber: number;
  children: OutlineTreeNode[];
};

export type PreviewTextSpan = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  angleDeg: number;
};

export type PreviewSelectionRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export function detectLocale(): Locale {
  const saved = window.localStorage.getItem("app.locale");
  if (saved === "ko" || saved === "en") return saved;
  return window.navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function normalizeFileStem(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? "document.pdf";
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem.trim().length > 0 ? stem : "document";
}

export function formatError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parsePageSelectionSpec(input: string, pageCount: number): Set<number> | null {
  const result = new Set<number>();
  const tokens = input
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return result;

  for (const token of tokens) {
    const single = token.match(/^\d+$/);
    if (single) {
      const page = Number.parseInt(token, 10);
      if (page >= 1 && page <= pageCount) result.add(page);
      continue;
    }

    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number.parseInt(range[1], 10);
      const b = Number.parseInt(range[2], 10);
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(pageCount, Math.max(a, b));
      for (let page = start; page <= end; page += 1) result.add(page);
      continue;
    }

    return null;
  }

  return result;
}

export function createExportUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const randomPart = Math.random().toString(16).slice(2);
  const timePart = Date.now().toString(16);
  return `${timePart}-${randomPart}`;
}

export function createOutlineEntryId(): string {
  return `outline-${createExportUuid()}`;
}

export function normalizeOutlineDepth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.floor(value), 0, OUTLINE_MAX_DEPTH);
}

export function normalizeOutlineTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isPdfPageRefLike(value: unknown): value is PdfPageRefLike {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return typeof target.num === "number" && typeof target.gen === "number";
}

export function isTextItemLike(value: unknown): value is TextItemLike {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return typeof target.str === "string";
}

export type RichTextItemLike = TextItemLike & {
  transform: number[];
  width: number;
  height: number;
};

export function isRichTextItemLike(value: unknown): value is RichTextItemLike {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  return typeof target.str === "string"
    && Array.isArray(target.transform)
    && target.transform.length >= 6
    && typeof target.width === "number"
    && typeof target.height === "number";
}

export function multiplyTransform(m1: number[], m2: number[]): [number, number, number, number, number, number] {
  const a = m1[0] * m2[0] + m1[2] * m2[1];
  const b = m1[1] * m2[0] + m1[3] * m2[1];
  const c = m1[0] * m2[2] + m1[2] * m2[3];
  const d = m1[1] * m2[2] + m1[3] * m2[3];
  const e = m1[0] * m2[4] + m1[2] * m2[5] + m1[4];
  const f = m1[1] * m2[4] + m1[3] * m2[5] + m1[5];
  return [a, b, c, d, e, f];
}

export function buildPreviewTextSpans(
  textItems: unknown[],
  viewportTransform: number[],
  viewportScale: number,
): PreviewTextSpan[] {
  const spans: PreviewTextSpan[] = [];
  let index = 0;
  for (const item of textItems) {
    if (!isRichTextItemLike(item)) continue;
    const text = item.str;
    if (text.trim().length === 0) continue;
    const tx = multiplyTransform(viewportTransform, item.transform);
    const fontHeight = Math.max(7, Math.hypot(tx[2], tx[3]));
    const width = Math.max(2, Math.abs(item.width * viewportScale));
    const height = Math.max(fontHeight, Math.abs(item.height * viewportScale));
    const left = tx[4];
    const top = tx[5] - height;
    const angleDeg = (Math.atan2(tx[1], tx[0]) * 180) / Math.PI;
    spans.push({
      id: `span-${index}`,
      text,
      left,
      top,
      width,
      height,
      fontSize: fontHeight,
      angleDeg,
    });
    index += 1;
    if (spans.length >= PREVIEW_TEXT_SPAN_LIMIT) break;
  }
  return spans;
}

export function normalizeSelectionRect(rect: PreviewSelectionRect): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(rect.x1, rect.x2),
    top: Math.min(rect.y1, rect.y2),
    right: Math.max(rect.x1, rect.x2),
    bottom: Math.max(rect.y1, rect.y2),
  };
}

export async function resolveOutlinePageNumber(
  doc: PDFDocumentProxy,
  destination: string | Array<unknown> | null,
): Promise<number | null> {
  let resolvedDestination: Array<unknown> | null = null;
  if (typeof destination === "string") {
    resolvedDestination = await doc.getDestination(destination);
  } else if (Array.isArray(destination)) {
    resolvedDestination = destination;
  }
  if (!resolvedDestination || resolvedDestination.length === 0) return null;
  const target = resolvedDestination[0];
  if (isPdfPageRefLike(target)) {
    const pageIndex = await doc.getPageIndex(target);
    return pageIndex + 1;
  }
  if (typeof target === "number" && Number.isFinite(target)) return target + 1;
  return null;
}

export async function flattenPdfOutlineNodes(
  doc: PDFDocumentProxy,
  nodes: PdfOutlineNode[],
  depth: number,
  entries: OutlineEntry[],
): Promise<void> {
  for (const node of nodes) {
    const title = normalizeOutlineTitle(node.title ?? "");
    const pageNumber = await resolveOutlinePageNumber(doc, node.dest);
    if (title.length > 0 && pageNumber !== null && pageNumber > 0 && pageNumber <= doc.numPages) {
      entries.push({
        id: createOutlineEntryId(),
        title,
        pageNumber,
        depth: normalizeOutlineDepth(depth),
        source: "pdf",
      });
    }
    if (Array.isArray(node.items) && node.items.length > 0) {
      await flattenPdfOutlineNodes(doc, node.items, depth + 1, entries);
    }
  }
}

export async function extractOutlineCandidatesFromText(
  doc: PDFDocumentProxy,
): Promise<Array<{ title: string; pageNumber: number }>> {
  const candidates: Array<{ title: string; pageNumber: number }> = [];
  const seen = new Set<string>();
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const tokens = textContent.items
      .map((item) => (isTextItemLike(item) ? normalizeOutlineTitle(item.str) : ""))
      .filter((token) => token.length > 0);
    if (tokens.length === 0) continue;
    const preferred = tokens.find((token) => token.length >= 4 && token.length <= 90 && !/^[\d\W]+$/.test(token));
    const fallback = tokens.slice(0, 12).join(" ");
    const normalized = normalizeOutlineTitle((preferred ?? fallback).replace(/^[\d.\-)\]\s]+/, ""));
    if (normalized.length < 4) continue;
    const title = normalized.length > 72 ? `${normalized.slice(0, 72).trimEnd()}...` : normalized;
    const dedupeKey = `${pageNumber}:${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({ title, pageNumber });
    if (candidates.length >= OUTLINE_TEXT_CANDIDATE_LIMIT) break;
  }
  return candidates;
}

export function buildOutlineTree(entries: OutlineEntry[], pageCount: number): OutlineTreeNode[] {
  const roots: OutlineTreeNode[] = [];
  const stack: Array<{ children: OutlineTreeNode[] }> = [{ children: roots }];
  for (const entry of entries) {
    const title = normalizeOutlineTitle(entry.title);
    if (title.length === 0) continue;
    const pageNumber = clamp(Math.floor(entry.pageNumber), 1, Math.max(1, pageCount));
    let depth = normalizeOutlineDepth(entry.depth);
    if (depth > stack.length - 1) depth = stack.length - 1;
    while (stack.length - 1 > depth) stack.pop();
    const node: OutlineTreeNode = { title, pageNumber, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ children: node.children });
  }
  return roots;
}

export function countOutlineDescendants(node: OutlineTreeNode): number {
  return node.children.length + node.children.reduce((sum, child) => sum + countOutlineDescendants(child), 0);
}

export function countOutlineVisible(nodes: OutlineTreeNode[]): number {
  return nodes.length + nodes.reduce((sum, node) => sum + countOutlineDescendants(node), 0);
}

export function applyOutlineEntriesToPdfDocument(outputDocument: PDFDocument, entries: OutlineEntry[]): void {
  if (outputDocument.getPageCount() === 0) {
    outputDocument.catalog.delete(PDFName.of("Outlines"));
    return;
  }

  const tree = buildOutlineTree(entries, outputDocument.getPageCount());
  if (tree.length === 0) {
    outputDocument.catalog.delete(PDFName.of("Outlines"));
    return;
  }

  const writeLevel = (parentRef: PDFRef, nodes: OutlineTreeNode[]): { first: PDFRef; last: PDFRef } | null => {
    let first: PDFRef | null = null;
    let last: PDFRef | null = null;
    let previousRef: PDFRef | null = null;
    let previousDict: PDFDict | null = null;

    for (const node of nodes) {
      const pageRef = outputDocument.getPage(node.pageNumber - 1).ref;
      const itemDict = outputDocument.context.obj({
        Title: PDFHexString.fromText(node.title),
        Parent: parentRef,
        Dest: outputDocument.context.obj([pageRef, PDFName.of("Fit")]),
      }) as PDFDict;
      const itemRef = outputDocument.context.register(itemDict);

      if (!first) first = itemRef;
      if (previousRef && previousDict) {
        previousDict.set(PDFName.of("Next"), itemRef);
        itemDict.set(PDFName.of("Prev"), previousRef);
      }

      if (node.children.length > 0) {
        const childLinks = writeLevel(itemRef, node.children);
        if (childLinks) {
          itemDict.set(PDFName.of("First"), childLinks.first);
          itemDict.set(PDFName.of("Last"), childLinks.last);
          itemDict.set(PDFName.of("Count"), PDFNumber.of(countOutlineDescendants(node)));
        }
      }

      previousRef = itemRef;
      previousDict = itemDict;
      last = itemRef;
    }

    if (!first || !last) return null;
    return { first, last };
  };

  const outlinesDict = outputDocument.context.obj({ Type: PDFName.of("Outlines") }) as PDFDict;
  const outlinesRef = outputDocument.context.register(outlinesDict);
  const links = writeLevel(outlinesRef, tree);
  if (!links) {
    outputDocument.catalog.delete(PDFName.of("Outlines"));
    return;
  }

  outlinesDict.set(PDFName.of("First"), links.first);
  outlinesDict.set(PDFName.of("Last"), links.last);
  outlinesDict.set(PDFName.of("Count"), PDFNumber.of(countOutlineVisible(tree)));
  outputDocument.catalog.set(PDFName.of("Outlines"), outlinesRef);
  outputDocument.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

export function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function normalizeRotationDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export async function appendPageWithRotation(
  outputDocument: PDFDocument,
  sourceDocument: PDFDocument,
  sourcePageIndex: number,
  extraRotation: number,
): Promise<void> {
  const [copied] = await outputDocument.copyPages(sourceDocument, [sourcePageIndex]);
  const currentRotation = normalizeRotationDegrees(copied.getRotation().angle);
  const finalRotation = normalizeRotationDegrees(currentRotation + extraRotation);
  copied.setRotation(degrees(finalRotation));
  outputDocument.addPage(copied);
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Canvas blob conversion failed."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

export async function renderPageToBlob(
  page: PDFPageProxy,
  scale: number,
  mimeType: "image/png" | "image/jpeg",
  quality?: number,
  rotation = 0,
): Promise<Blob> {
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Cannot acquire canvas context.");
  const task = page.render({ canvas, canvasContext: context, viewport, intent: "print" });
  await task.promise;
  const blob = await canvasToBlob(canvas, mimeType, quality);
  canvas.width = 0;
  canvas.height = 0;
  page.cleanup();
  return blob;
}

