import { normalizePdfRect, rectHasArea, type PdfRect } from "./app-view-helpers";
import { normalizeOutlineTitle } from "./app-helpers";

export type PdfLinkAnnotationLike = {
  rect?: unknown;
  url?: unknown;
  unsafeUrl?: unknown;
  dest?: string | Array<unknown> | null;
  subtype?: unknown;
};

export type PdfJsCommonFontLike = {
  name?: string;
  loadedName?: string;
  fallbackName?: string;
  systemFontInfo?: {
    css?: string;
    loadedName?: string;
  };
};

export type IdleTaskHandle = number;

export function parseLinkAnnotationRect(value: unknown): PdfRect | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [x1, y1, x2, y2] = value;
  if (![x1, y1, x2, y2].every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const rect = normalizePdfRect({ x1, y1, x2, y2 });
  return rectHasArea(rect) ? rect : null;
}

export function normalizeExternalLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const lower = normalized.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return null;
  return normalized;
}

export function isPdfLinkAnnotation(annotation: unknown): annotation is PdfLinkAnnotationLike {
  if (!annotation || typeof annotation !== "object") return false;
  const link = annotation as PdfLinkAnnotationLike;
  return link.subtype === "Link"
    || Array.isArray(link.dest)
    || typeof link.dest === "string"
    || typeof link.url === "string"
    || typeof link.unsafeUrl === "string";
}

export function normalizePdfPathKey(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null;
  const normalized = path.trim();
  if (normalized.length === 0) return null;
  return normalized.replace(/\\/g, "/").toLowerCase();
}

export function normalizePdfFontDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeOutlineTitle(value).replace(/^[A-Z]{6}\+/, "").trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizePageOrder(pageOrder: number[], pageCount: number): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const pageNumber of pageOrder) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount || seen.has(pageNumber)) continue;
    seen.add(pageNumber);
    normalized.push(pageNumber);
  }
  return normalized;
}

export function normalizeSelectedPages(selectedPages: Iterable<number>, pageCount: number): Set<number> {
  const normalized = new Set<number>();
  for (const pageNumber of selectedPages) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) continue;
    normalized.add(pageNumber);
  }
  return normalized;
}

export function scheduleIdleTask(callback: () => void, timeout = 300): IdleTaskHandle {
  const idleWindow = window as Window & typeof globalThis & {
    requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    return idleWindow.requestIdleCallback(() => callback(), { timeout });
  }
  return window.setTimeout(callback, Math.min(timeout, 120));
}

export function cancelIdleTask(handle: IdleTaskHandle | null) {
  if (handle === null) return;
  const idleWindow = window as Window & typeof globalThis & {
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof idleWindow.cancelIdleCallback === "function") {
    idleWindow.cancelIdleCallback(handle);
    return;
  }
  window.clearTimeout(handle);
}
