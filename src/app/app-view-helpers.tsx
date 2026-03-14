import { memo, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { ZOOM_MAX, ZOOM_MIN, clamp, normalizeOutlineTitle, type PreviewTextSpan } from "./app-helpers";

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

export function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  const commonProps = {
    className: "btn-icon",
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "open":
      return <svg {...commonProps}><path d="M2.5 5.5h3l1.2-2h2.7l1.2 2h3.1" /><path d="M2 6.5h12l-1 6.5H3z" /></svg>;
    case "add":
      return <svg {...commonProps}><path d="M3 4.5h7l3 3V13H3z" /><path d="M10 4.5V8h3" /><path d="M8 9v3" /><path d="M6.5 10.5h3" /></svg>;
    case "merge":
      return <svg {...commonProps}><path d="M3 4.5h3.5L8 6l1.5-1.5H13" /><path d="M3 11.5h3.5L8 10l1.5 1.5H13" /><path d="M8 6v4" /></svg>;
    case "close":
      return <svg {...commonProps}><path d="M3.5 3.5l9 9" /><path d="M12.5 3.5l-9 9" /></svg>;
    case "fullscreen":
      return <svg {...commonProps}><path d="M6 2.5H2.5V6" /><path d="M10 2.5h3.5V6" /><path d="M2.5 10V13.5H6" /><path d="M13.5 10v3.5H10" /></svg>;
    case "print":
      return <svg {...commonProps}><path d="M4.5 6V3.5h7V6" /><path d="M4 11.5H3a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 3 6.5h10A1.5 1.5 0 0 1 14.5 8v2A1.5 1.5 0 0 1 13 11.5h-1" /><path d="M4.5 9.5h7V13h-7z" /></svg>;
    case "apply":
      return <svg {...commonProps}><path d="M3 8l3 3 7-7" /></svg>;
    case "selectAll":
      return <svg {...commonProps}><path d="M2.5 3.5h4v4h-4z" /><path d="M9.5 3.5h4v4h-4z" /><path d="M2.5 10.5h4v2h-4z" /><path d="M10 11.5l1.5 1.5 2.5-3" /></svg>;
    case "clear":
      return <svg {...commonProps}><path d="M3 4.5h10" /><path d="M5 4.5V3h6v1.5" /><path d="M4.5 4.5l.8 8h5.4l.8-8" /><path d="M6.5 6.5v4" /><path d="M9.5 6.5v4" /></svg>;
    case "rangeRemove":
      return <svg {...commonProps}><path d="M2.5 5.5h5" /><path d="M2.5 10.5h5" /><path d="M9 8h5" /></svg>;
    case "save":
      return <svg {...commonProps}><path d="M3 3.5h8l2 2V13H3z" /><path d="M5 3.5v3h5v-3" /><path d="M5 12v-3.5h6V12" /></svg>;
    case "singlePage":
      return <svg {...commonProps}><rect x="4" y="2.5" width="8" height="11" rx="1.2" /><path d="M6 5h4" /><path d="M6 7.5h4" /></svg>;
    case "doublePage":
      return <svg {...commonProps}><rect x="1.8" y="3" width="5.5" height="10" rx="0.9" /><rect x="8.7" y="3" width="5.5" height="10" rx="0.9" /></svg>;
    case "search":
      return <svg {...commonProps}><circle cx="7" cy="7" r="3.5" /><path d="M10 10l3 3" /></svg>;
    default:
      return null;
  }
}

export const SHORTCUT_LABELS = {
  openPdf: "Ctrl+O",
  addPdf: "Ctrl+Shift+O",
  mergePdfs: "Ctrl+Shift+M",
  closePdf: "Ctrl+W",
  printSelection: "Ctrl+P",
  saveSelection: "Ctrl+S",
  applyQuickSelection: "Enter",
  selectAllPages: "Ctrl+A",
  clearSelection: "Esc",
  removeRange: "Ctrl+-",
  previousPage: "PageUp",
  nextPage: "PageDown",
  rotateLeft: "Ctrl+[",
  rotateRight: "Ctrl+]",
  findInDocument: "Ctrl+F",
  togglePreviewFullscreen: "Ctrl+L",
} as const;

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

type PreviewTextLayerProps = {
  spans: PreviewTextSpan[];
  isAreaSelectMode: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  activeSpanIndex: number | null;
  matchedSpanIndexes: Set<number>;
  normalizedSelectionRect: { left: number; top: number; right: number; bottom: number } | null;
  layerRef: RefObject<HTMLDivElement | null>;
};

export const PreviewTextLayer = memo(function PreviewTextLayer({
  spans,
  isAreaSelectMode,
  onMouseDown,
  activeSpanIndex,
  matchedSpanIndexes,
  normalizedSelectionRect,
  layerRef,
}: PreviewTextLayerProps) {
  return (
    <div
      className={`preview-text-layer ${isAreaSelectMode ? "area-mode" : ""}`}
      ref={layerRef}
      onMouseDown={onMouseDown}
    >
      {spans.map((span, spanIndex) => (
        <span
          key={span.id}
          className={`preview-text-span ${matchedSpanIndexes.has(spanIndex) ? "search-hit" : ""} ${activeSpanIndex === spanIndex ? "search-hit-active" : ""}`}
          data-text={span.text}
          style={{
            left: `${span.left}px`,
            top: `${span.top}px`,
            width: `${span.width}px`,
            height: `${span.height}px`,
            fontSize: `${span.fontSize}px`,
            fontFamily: span.fontFamily,
            transform: `rotate(${span.angleDeg}deg)`,
          }}
        >
          {span.text}
        </span>
      ))}
      {normalizedSelectionRect ? (
        <div
          className="preview-selection-rect"
          style={{
            left: `${normalizedSelectionRect.left}px`,
            top: `${normalizedSelectionRect.top}px`,
            width: `${Math.max(0, normalizedSelectionRect.right - normalizedSelectionRect.left)}px`,
            height: `${Math.max(0, normalizedSelectionRect.bottom - normalizedSelectionRect.top)}px`,
          }}
        />
      ) : null}
    </div>
  );
});
