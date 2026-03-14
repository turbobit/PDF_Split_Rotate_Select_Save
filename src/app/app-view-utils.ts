import { ZOOM_MAX, ZOOM_MIN, clamp, normalizeOutlineTitle } from "./app-helpers";

export type ToolbarIconName =
  | "open"
  | "add"
  | "merge"
  | "close"
  | "fullscreen"
  | "print"
  | "apply"
  | "selectAll"
  | "clear"
  | "rangeRemove"
  | "save"
  | "singlePage"
  | "doublePage"
  | "search";

export function withShortcutHint(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function readStoredZoom(): number {
  return clamp(100, ZOOM_MIN, ZOOM_MAX);
}

export const PAGE_LOAD_BATCH_SIZE = 24;
export const PAGE_LOAD_BATCH_DELAY_MS = 16;

export function normalizeSearchQuery(value: string): string {
  return normalizeOutlineTitle(value).toLowerCase();
}

export function buildPreviewCacheKey(pageNumber: number, rotation: number, scale: number): string {
  return `${pageNumber}:${rotation}:${Math.round(scale * 1000)}`;
}

export type PdfRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type PdfImageOverlay = {
  id: string;
  kind: "image";
  pageNumber: number;
  rect: PdfRect;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  previewUrl: string;
  sourceName: string;
};

export type PdfPageOverlay = PdfImageOverlay;
export type PreviewLinkOverlay = {
  id: string;
  pageNumber: number;
  rect: PdfRect;
  kind: "internal" | "external";
  targetPageNumber?: number;
  url?: string;
};
export type PdfSecurityMode = "protect" | "unprotect" | "open";

export function normalizePdfRect(rect: PdfRect): PdfRect {
  return {
    x1: Math.min(rect.x1, rect.x2),
    y1: Math.min(rect.y1, rect.y2),
    x2: Math.max(rect.x1, rect.x2),
    y2: Math.max(rect.y1, rect.y2),
  };
}

export function rectHasArea(rect: PdfRect | null): rect is PdfRect {
  return !!rect && Math.abs(rect.x2 - rect.x1) >= 1 && Math.abs(rect.y2 - rect.y1) >= 1;
}

export function isPdfFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

export function imageMimeTypeFromPath(path: string): "image/png" | "image/jpeg" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

export function isPdfJsDocumentTeardownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Transport destroyed") || message.includes("Worker was destroyed");
}

export function isImageFilePath(path: string): boolean {
  return imageMimeTypeFromPath(path) !== null;
}

export async function measureImage(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Failed to decode image."));
      nextImage.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
