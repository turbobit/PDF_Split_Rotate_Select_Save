import { join } from "@tauri-apps/api/path";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { PDFDocument, degrees } from "pdf-lib";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type KeyboardEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerSrc;

const THUMBNAIL_SCALE = 0.22;
const IMAGE_EXPORT_SCALE = 2;
const THUMB_ITEM_HEIGHT = 206;
const THUMB_OVERSCAN = 10;
const THUMB_PREFETCH = 14;
const THUMBNAIL_CONCURRENCY = 3;
const THUMB_CACHE_LIMIT = 420;
const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 10;

type SaveType = "pdf" | "png" | "jpg";
type Locale = "ko" | "en";
type StatusState =
  | { type: "ready" }
  | { type: "loadingPdf" }
  | { type: "loaded"; pages: number }
  | { type: "savingPdf" }
  | { type: "savedPdf"; pages: number }
  | { type: "savingImages"; done: number; total: number }
  | { type: "savedImages"; total: number }
  | { type: "failed"; reason: "pdfLoad" | "pdfSave" | "imageSave" };

function detectLocale(): Locale {
  const saved = window.localStorage.getItem("app.locale");
  if (saved === "ko" || saved === "en") return saved;
  return window.navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function normalizeFileStem(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? "document.pdf";
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem.trim().length > 0 ? stem : "document";
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parsePageSelectionSpec(input: string, pageCount: number): Set<number> | null {
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

function createExportUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const randomPart = Math.random().toString(16).slice(2);
  const timePart = Date.now().toString(16);
  return `${timePart}-${randomPart}`;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function normalizeRotationDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

async function appendPageWithRotation(
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

async function canvasToBlob(
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

async function renderPageToBlob(
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

function App() {
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const tr = useCallback((ko: string, en: string) => (locale === "ko" ? ko : en), [locale]);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [activePage, setActivePage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [saveType, setSaveType] = useState<SaveType>("pdf");
  const [openExplorerAfterSave, setOpenExplorerAfterSave] = useState(true);
  const [quickSelectInput, setQuickSelectInput] = useState("");
  const [rangeFromInput, setRangeFromInput] = useState("");
  const [rangeToInput, setRangeToInput] = useState("");
  const [showAddPdfModal, setShowAddPdfModal] = useState(false);
  const [addPdfPath, setAddPdfPath] = useState<string | null>(null);
  const [addPdfBytes, setAddPdfBytes] = useState<Uint8Array | null>(null);
  const [addPdfPageCount, setAddPdfPageCount] = useState(0);
  const [addInsertPosition, setAddInsertPosition] = useState<"front" | "back">("back");
  const [addRangeInput, setAddRangeInput] = useState("");
  const [isAddingPdf, setIsAddingPdf] = useState(false);
  const [showMergePdfModal, setShowMergePdfModal] = useState(false);
  const [mergePdfPaths, setMergePdfPaths] = useState<string[]>([]);
  const [mergeDraggingPath, setMergeDraggingPath] = useState<string | null>(null);
  const [mergeDropPath, setMergeDropPath] = useState<string | null>(null);
  const [mergeDraggingIndex, setMergeDraggingIndex] = useState<number | null>(null);
  const [mergeInsertPosition, setMergeInsertPosition] = useState<"front" | "back" | "beforeActive" | "afterActive">("back");
  const [status, setStatus] = useState<StatusState>({ type: "ready" });
  const [errorText, setErrorText] = useState<string | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>({});
  const [thumbQueueCount, setThumbQueueCount] = useState(0);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const [thumbViewportHeight, setThumbViewportHeight] = useState(0);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [previewZoom, setPreviewZoom] = useState(100);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [isPreviewFocused, setIsPreviewFocused] = useState(false);
  const [draggingPage, setDraggingPage] = useState<number | null>(null);
  const [dropTargetPage, setDropTargetPage] = useState<number | null>(null);
  const [draggingPageIndex, setDraggingPageIndex] = useState<number | null>(null);
  const [isPointerReordering, setIsPointerReordering] = useState(false);

  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumbViewportRef = useRef<HTMLDivElement | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const activePageRef = useRef(1);
  const thumbnailUrlsRef = useRef<Record<number, string>>({});
  const thumbnailOrderRef = useRef<number[]>([]);
  const pendingPagesRef = useRef<number[]>([]);
  const requestedPagesRef = useRef<Set<number>>(new Set());
  const inflightPagesRef = useRef<Set<number>>(new Set());
  const queueTokenRef = useRef(0);
  const visiblePagesRef = useRef<Set<number>>(new Set());
  const pageRotationsRef = useRef<Record<number, number>>({});
  const pageOrderRef = useRef<number[]>([]);
  const toastTimerRef = useRef<number | null>(null);

  const isBusy = isLoadingPdf || isSaving || isAddingPdf;
  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);
  const selectedPageNumbers = useMemo(() => pageOrder.filter((pageNumber) => selectedPages.has(pageNumber)), [pageOrder, selectedPages]);
  const pageOrderIndexMap = useMemo(() => {
    const map: Record<number, number> = {};
    pageOrder.forEach((pageNumber, index) => {
      map[pageNumber] = index;
    });
    return map;
  }, [pageOrder]);
  const loadedThumbCount = useMemo(() => Object.keys(thumbnailUrls).length, [thumbnailUrls]);
  const visibleStartIndex = useMemo(() => Math.max(0, Math.floor(thumbScrollTop / THUMB_ITEM_HEIGHT) - THUMB_OVERSCAN), [thumbScrollTop]);
  const visibleCount = useMemo(() => Math.max(1, Math.ceil(thumbViewportHeight / THUMB_ITEM_HEIGHT) + THUMB_OVERSCAN * 2), [thumbViewportHeight]);
  const visibleEndIndex = useMemo(() => (pageOrder.length === 0 ? -1 : Math.min(pageOrder.length - 1, visibleStartIndex + visibleCount - 1)), [pageOrder.length, visibleStartIndex, visibleCount]);
  const visiblePageNumbers = useMemo(() => {
    if (visibleEndIndex < visibleStartIndex) return [] as number[];
    return pageOrder.slice(visibleStartIndex, visibleEndIndex + 1);
  }, [pageOrder, visibleStartIndex, visibleEndIndex]);
  const statusText = useMemo(() => {
    if (status.type === "ready") return tr("PDF를 열어 작업을 시작하세요.", "Open a PDF to start.");
    if (status.type === "loadingPdf") return tr("PDF 로딩 중...", "Loading PDF...");
    if (status.type === "loaded") return tr(`총 ${status.pages}페이지 로딩 완료`, `Loaded ${status.pages} pages`);
    if (status.type === "savingPdf") return tr("선택 페이지를 PDF로 저장 중...", "Saving selected pages to PDF...");
    if (status.type === "savedPdf") return tr(`PDF 저장 완료 (${status.pages}페이지)`, `PDF saved (${status.pages} pages)`);
    if (status.type === "savingImages") return tr(`이미지 저장 중... (${status.done}/${status.total})`, `Saving images... (${status.done}/${status.total})`);
    if (status.type === "savedImages") return tr(`이미지 저장 완료 (${status.total}개 파일)`, `Images saved (${status.total} files)`);
    if (status.reason === "pdfLoad") return tr("PDF 로딩 실패", "PDF loading failed");
    if (status.reason === "pdfSave") return tr("PDF 저장 실패", "PDF save failed");
    return tr("이미지 저장 실패", "Image save failed");
  }, [status, tr]);

  useEffect(() => {
    window.localStorage.setItem("app.locale", locale);
  }, [locale]);

  useEffect(() => {
    pageRotationsRef.current = pageRotations;
  }, [pageRotations]);

  useEffect(() => {
    pageOrderRef.current = pageOrder;
  }, [pageOrder]);

  const showToast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastText(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(() => {
    activePageRef.current = activePage;
    setPageInput(String(activePage));
  }, [activePage]);

  const clearThumbnailPipeline = useCallback(() => {
    for (const url of Object.values(thumbnailUrlsRef.current)) URL.revokeObjectURL(url);
    thumbnailUrlsRef.current = {};
    thumbnailOrderRef.current = [];
    pendingPagesRef.current = [];
    requestedPagesRef.current.clear();
    inflightPagesRef.current.clear();
    queueTokenRef.current += 1;
    setThumbnailUrls({});
    setThumbQueueCount(0);
    setThumbScrollTop(0);
  }, []);

  const clearPreviewCanvas = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.width = "0px";
    canvas.style.height = "0px";
  }, []);

  const replacePdfDocument = useCallback(async (nextDoc: PDFDocumentProxy | null) => {
    if (pdfDocRef.current) await pdfDocRef.current.destroy();
    pdfDocRef.current = nextDoc;
    setPdfDoc(nextDoc);
  }, []);

  useEffect(() => {
    const previewHost = previewHostRef.current;
    if (!previewHost) return;
    const update = () => setPreviewSize({ width: previewHost.clientWidth, height: previewHost.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(previewHost);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = thumbViewportRef.current;
    if (!viewport) return;
    const update = () => setThumbViewportHeight(viewport.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    clearThumbnailPipeline();
    if (pdfDocRef.current) void pdfDocRef.current.destroy();
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, [clearThumbnailPipeline]);

  const isPageProtected = useCallback((pageNumber: number) => {
    return pageNumber === activePageRef.current || visiblePagesRef.current.has(pageNumber);
  }, []);

  const addThumbnail = useCallback((pageNumber: number, url: string) => {
    setThumbnailUrls((prev) => {
      if (prev[pageNumber]) {
        URL.revokeObjectURL(url);
        return prev;
      }
      const next = { ...prev, [pageNumber]: url };
      thumbnailUrlsRef.current = next;
      thumbnailOrderRef.current.push(pageNumber);
      while (thumbnailOrderRef.current.length > THUMB_CACHE_LIMIT) {
        const candidate = thumbnailOrderRef.current.find((item) => !isPageProtected(item)) ?? thumbnailOrderRef.current[0];
        if (candidate === undefined || candidate === pageNumber) break;
        const removeUrl = next[candidate];
        if (removeUrl) {
          URL.revokeObjectURL(removeUrl);
          delete next[candidate];
          requestedPagesRef.current.delete(candidate);
        }
        thumbnailOrderRef.current = thumbnailOrderRef.current.filter((item) => item !== candidate);
      }
      thumbnailUrlsRef.current = next;
      return { ...next };
    });
  }, [isPageProtected]);

  const pumpThumbnailQueue = useCallback((token: number) => {
    const doc = pdfDocRef.current;
    if (!doc || token !== queueTokenRef.current) return;
    while (inflightPagesRef.current.size < THUMBNAIL_CONCURRENCY && pendingPagesRef.current.length > 0) {
      const pageNumber = pendingPagesRef.current.shift();
      if (!pageNumber || thumbnailUrlsRef.current[pageNumber]) continue;
      inflightPagesRef.current.add(pageNumber);
      void (async () => {
        try {
          const page = await doc.getPage(pageNumber);
          const blob = await renderPageToBlob(page, THUMBNAIL_SCALE, "image/png");
          const blobUrl = URL.createObjectURL(blob);
          if (token !== queueTokenRef.current) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          addThumbnail(pageNumber, blobUrl);
        } catch (error) {
          if (token === queueTokenRef.current) setErrorText(`${tr("썸네일 렌더링 실패", "Thumbnail render failed")} (${pageNumber}): ${formatError(error)}`);
        } finally {
          inflightPagesRef.current.delete(pageNumber);
          if (token === queueTokenRef.current) {
            setThumbQueueCount(pendingPagesRef.current.length + inflightPagesRef.current.size);
            pumpThumbnailQueue(token);
          }
        }
      })();
    }
    setThumbQueueCount(pendingPagesRef.current.length + inflightPagesRef.current.size);
  }, [addThumbnail, tr]);

  const enqueueThumbnailPages = useCallback((pages: number[], highPriority: boolean) => {
    if (!pdfDocRef.current || pageCount === 0) return;
    const add: number[] = [];
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > pageCount) continue;
      if (thumbnailUrlsRef.current[pageNumber]) continue;
      if (requestedPagesRef.current.has(pageNumber) || inflightPagesRef.current.has(pageNumber)) continue;
      requestedPagesRef.current.add(pageNumber);
      add.push(pageNumber);
    }
    if (add.length === 0) return;
    pendingPagesRef.current = highPriority ? [...add, ...pendingPagesRef.current] : [...pendingPagesRef.current, ...add];
    const token = queueTokenRef.current;
    setThumbQueueCount(pendingPagesRef.current.length + inflightPagesRef.current.size);
    pumpThumbnailQueue(token);
  }, [pageCount, pumpThumbnailQueue]);

  useEffect(() => {
    visiblePagesRef.current = new Set(visiblePageNumbers);
  }, [visiblePageNumbers]);

  useEffect(() => {
    if (!pdfDoc || pageCount === 0) return;
    enqueueThumbnailPages([activePage, ...visiblePageNumbers], true);
    const prefetch: number[] = [];
    for (let offset = 1; offset <= THUMB_PREFETCH; offset += 1) {
      const afterIndex = visibleEndIndex + offset;
      const beforeIndex = visibleStartIndex - offset;
      if (afterIndex >= 0 && afterIndex < pageOrder.length) prefetch.push(pageOrder[afterIndex]);
      if (beforeIndex >= 0 && beforeIndex < pageOrder.length) prefetch.push(pageOrder[beforeIndex]);
    }
    enqueueThumbnailPages(prefetch, false);
  }, [pdfDoc, pageCount, activePage, visiblePageNumbers, visibleEndIndex, visibleStartIndex, pageOrder, enqueueThumbnailPages]);

  useEffect(() => {
    if (!pdfDoc || previewSize.width < 40 || previewSize.height < 40) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    let renderTask: RenderTask | null = null;
    let cancelled = false;
    const run = async () => {
      try {
        const page = await pdfDoc.getPage(activePage);
        if (cancelled) return;
        const rotation = pageRotationsRef.current[activePage] ?? 0;
        const base = page.getViewport({ scale: 1, rotation });
        const fitW = Math.max(previewSize.width - 24, 140);
        const fitH = Math.max(previewSize.height - 64, 140);
        const fitScale = Math.max(0.1, Math.min(fitW / base.width, fitH / base.height));
        const cssScale = Math.max(0.1, fitScale * (previewZoom / 100));
        const viewport = page.getViewport({ scale: cssScale, rotation });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Cannot acquire preview canvas context.");
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        renderTask = page.render({ canvas, canvasContext: context, viewport, intent: "display" });
        await renderTask.promise;
      } catch (error) {
        const known = error as { name?: string };
        if (known.name !== "RenderingCancelledException" && !cancelled) {
          setErrorText(`${tr("미리보기 렌더링 실패", "Preview render failed")}: ${formatError(error)}`);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
    };
  }, [pdfDoc, activePage, pageRotations, previewSize, previewZoom, tr]);

  const handleOpenPdf = useCallback(async () => {
    setErrorText(null);
    const selected = await open({
      multiple: false,
      directory: false,
      title: tr("PDF 파일 선택", "Select PDF file"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    setIsLoadingPdf(true);
    setStatus({ type: "loadingPdf" });
    try {
      clearThumbnailPipeline();
      await replacePdfDocument(null);
      clearPreviewCanvas();
      setPdfPath(null);
      setPdfBytes(null);
      setPageCount(0);
      setPageOrder([]);
      setActivePage(1);
      setPageInput("1");
      setSelectedPages(new Set());
      setQuickSelectInput("");
      setRangeFromInput("");
      setRangeToInput("");
      setPreviewZoom(100);
      setPageRotations({});
      pageRotationsRef.current = {};

      const fileBytes = new Uint8Array(await readFile(selected));
      const previewBytes = cloneBytes(fileBytes);
      const stateBytes = cloneBytes(fileBytes);
      const task = getDocument({ data: previewBytes });
      const loadedDoc = await task.promise;
      await replacePdfDocument(loadedDoc);
      setPdfPath(selected);
      setPdfBytes(stateBytes);
      setPageCount(loadedDoc.numPages);
      setPageOrder(Array.from({ length: loadedDoc.numPages }, (_, idx) => idx + 1));
      setActivePage(1);
      setPageInput("1");
      setSelectedPages(new Set([1]));
      setRangeFromInput("");
      setRangeToInput("");
      setPreviewZoom(100);
      setPageRotations({});
      pageRotationsRef.current = {};
      setStatus({ type: "loaded", pages: loadedDoc.numPages });
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfLoad" });
      setErrorText(`${tr("PDF 로딩 실패", "PDF loading failed")}: ${formatError(error)}`);
    } finally {
      setIsLoadingPdf(false);
    }
  }, [clearPreviewCanvas, clearThumbnailPipeline, replacePdfDocument, tr]);

  const handleOpenAddPdfModal = useCallback(async () => {
    if (!pdfDoc || !pdfBytes || isBusy) return;
    const selected = await open({
      multiple: false,
      directory: false,
      title: tr("추가할 PDF 파일 선택", "Select PDF file to add"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const fileBytes = new Uint8Array(await readFile(selected));
      const sourceDocument = await PDFDocument.load(fileBytes, { updateMetadata: false });
      const sourcePageCount = sourceDocument.getPageCount();
      if (sourcePageCount <= 0) {
        await message(tr("추가할 PDF 페이지가 없습니다.", "No pages found in the selected PDF."), {
          title: tr("안내", "Notice"),
        });
        return;
      }
      setAddPdfPath(selected);
      setAddPdfBytes(new Uint8Array(fileBytes));
      setAddPdfPageCount(sourcePageCount);
      setAddInsertPosition("back");
      setAddRangeInput("");
      setShowAddPdfModal(true);
    } catch (error) {
      await message(`${tr("추가 PDF 로딩 실패", "Failed to load PDF for adding")}: ${formatError(error)}`, {
        title: tr("안내", "Notice"),
      });
    }
  }, [isBusy, pdfBytes, pdfDoc, tr]);

  const handleMergePdfs = useCallback(async () => {
    if (isBusy) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: tr("병합할 PDF 파일 선택", "Select PDF files to merge"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const mergePaths = Array.isArray(selected) ? selected : [selected];
    if (mergePaths.length === 0) return;
    setMergePdfPaths(mergePaths);
    setMergeDraggingPath(null);
    setMergeDropPath(null);
    setMergeDraggingIndex(null);
    setMergeInsertPosition("back");
    setShowMergePdfModal(true);
  }, [isBusy, tr]);

  const closeMergePdfModal = useCallback(() => {
    if (isAddingPdf) return;
    setShowMergePdfModal(false);
    setMergePdfPaths([]);
    setMergeDraggingPath(null);
    setMergeDropPath(null);
    setMergeDraggingIndex(null);
    setMergeInsertPosition("back");
  }, [isAddingPdf]);

  const moveMergePdfPathByIndex = useCallback((sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    setMergePdfPaths((prev) => {
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex >= prev.length || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const handleApplyMergePdfs = useCallback(async () => {
    if (mergePdfPaths.length === 0) return;
    const existingOrder = pageOrder.length === pageCount
      ? pageOrder
      : Array.from({ length: pageCount }, (_, index) => index + 1);
    const currentPageCount = existingOrder.length;
    const currentActiveIndex = existingOrder.indexOf(activePage);
    const resolvedInsertPosition =
      (mergeInsertPosition === "beforeActive" || mergeInsertPosition === "afterActive") && currentActiveIndex < 0
        ? "back"
        : mergeInsertPosition;
    const insertIndex = (() => {
      if (resolvedInsertPosition === "front") return 0;
      if (resolvedInsertPosition === "beforeActive") return currentActiveIndex;
      if (resolvedInsertPosition === "afterActive") return currentActiveIndex + 1;
      return currentPageCount;
    })();

    setIsAddingPdf(true);
    setErrorText(null);
    try {
      const outputDoc = await PDFDocument.create();
      let mergedAddedCount = 0;

      if (pdfBytes && pageCount > 0) {
        const currentDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
        const appendCurrentRange = async (orderSlice: number[]) => {
          for (const sourcePageNumber of orderSlice) {
            const extraRotation = pageRotationsRef.current[sourcePageNumber] ?? 0;
            await appendPageWithRotation(outputDoc, currentDoc, sourcePageNumber - 1, extraRotation);
          }
        };
        const appendMergedDocs = async () => {
          for (const path of mergePdfPaths) {
            const bytes = await readFile(path);
            const sourceDoc = await PDFDocument.load(bytes, { updateMetadata: false });
            const sourcePageCount = sourceDoc.getPageCount();
            if (sourcePageCount <= 0) continue;
            const copied = await outputDoc.copyPages(sourceDoc, Array.from({ length: sourcePageCount }, (_, index) => index));
            copied.forEach((page) => outputDoc.addPage(page));
            mergedAddedCount += copied.length;
          }
        };

        await appendCurrentRange(existingOrder.slice(0, insertIndex));
        await appendMergedDocs();
        await appendCurrentRange(existingOrder.slice(insertIndex));
      } else {
        for (const path of mergePdfPaths) {
          const bytes = await readFile(path);
          const sourceDoc = await PDFDocument.load(bytes, { updateMetadata: false });
          const sourcePageCount = sourceDoc.getPageCount();
          if (sourcePageCount <= 0) continue;
          const copied = await outputDoc.copyPages(sourceDoc, Array.from({ length: sourcePageCount }, (_, index) => index));
          copied.forEach((page) => outputDoc.addPage(page));
          mergedAddedCount += copied.length;
        }
      }

      if (outputDoc.getPageCount() === 0) {
        await message(tr("병합할 페이지가 없습니다.", "No pages available to merge."), {
          title: tr("안내", "Notice"),
        });
        return;
      }

      const mergedBytes = await outputDoc.save();
      const mergedArray = new Uint8Array(mergedBytes);
      const previewBytes = cloneBytes(mergedArray);
      const stateBytes = cloneBytes(mergedArray);
      const task = getDocument({ data: previewBytes });
      const mergedDoc = await task.promise;

      clearThumbnailPipeline();
      await replacePdfDocument(mergedDoc);
      setPdfBytes(stateBytes);
      if (!pdfPath && mergePdfPaths.length > 0) setPdfPath(mergePdfPaths[0]);

      const mergedCount = mergedDoc.numPages;
      const mergedOrder = Array.from({ length: mergedCount }, (_, index) => index + 1);
      setPageCount(mergedCount);
      setPageOrder(mergedOrder);
      setPageRotations({});
      pageRotationsRef.current = {};
      const oldSelected = new Set(selectedPages);
      const nextSelected = new Set<number>();
      existingOrder.forEach((sourcePageNumber, idx) => {
        if (!oldSelected.has(sourcePageNumber)) return;
        const mapped = idx < insertIndex ? idx + 1 : idx + mergedAddedCount + 1;
        nextSelected.add(mapped);
      });
      for (let idx = 0; idx < mergedAddedCount; idx += 1) nextSelected.add(insertIndex + idx + 1);
      setSelectedPages(nextSelected.size > 0 ? nextSelected : new Set([1]));

      const nextActive = currentActiveIndex >= 0
        ? (currentActiveIndex < insertIndex ? currentActiveIndex + 1 : currentActiveIndex + mergedAddedCount + 1)
        : 1;
      setActivePage(clamp(nextActive, 1, mergedCount));
      setPageInput(String(clamp(nextActive, 1, mergedCount)));
      setStatus({ type: "loaded", pages: mergedCount });
      closeMergePdfModal();
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfLoad" });
      setErrorText(`${tr("PDF 병합 실패", "Failed to merge PDFs")}: ${formatError(error)}`);
    } finally {
      setIsAddingPdf(false);
    }
  }, [
    clearThumbnailPipeline,
    closeMergePdfModal,
    activePage,
    mergePdfPaths,
    mergeInsertPosition,
    pageCount,
    pageOrder,
    pdfBytes,
    pdfPath,
    replacePdfDocument,
    selectedPages,
    tr,
  ]);

  const closeAddPdfModal = useCallback(() => {
    if (isAddingPdf) return;
    setShowAddPdfModal(false);
    setAddPdfPath(null);
    setAddPdfBytes(null);
    setAddPdfPageCount(0);
    setAddInsertPosition("back");
    setAddRangeInput("");
  }, [isAddingPdf]);

  const handleApplyAddPdf = useCallback(async () => {
    if (!pdfBytes || !pdfDoc || !addPdfBytes || addPdfPageCount <= 0) return;
    const parsedRange = addRangeInput.trim().length === 0
      ? new Set(Array.from({ length: addPdfPageCount }, (_, index) => index + 1))
      : parsePageSelectionSpec(addRangeInput, addPdfPageCount);
    if (parsedRange === null || parsedRange.size === 0) {
      await message(
        tr(
          "추가할 범위를 확인해주세요. 예: 1-3, 5, 9",
          "Check pages to add. Example: 1-3, 5, 9",
        ),
        { title: tr("안내", "Notice") },
      );
      return;
    }
    const pagesToAdd = Array.from(parsedRange).sort((a, b) => a - b);
    const existingOrder = pageOrder.length === pageCount
      ? pageOrder
      : Array.from({ length: pageCount }, (_, index) => index + 1);
    setIsAddingPdf(true);
    setErrorText(null);
    try {
      const currentDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
      const sourceDoc = await PDFDocument.load(addPdfBytes, { updateMetadata: false });
      const outputDoc = await PDFDocument.create();

      const appendAddedPages = async () => {
        const copiedSource = await outputDoc.copyPages(sourceDoc, pagesToAdd.map((pageNumber) => pageNumber - 1));
        copiedSource.forEach((page) => outputDoc.addPage(page));
      };
      const appendCurrentPages = async () => {
        for (const sourcePageNumber of existingOrder) {
          const extraRotation = pageRotationsRef.current[sourcePageNumber] ?? 0;
          await appendPageWithRotation(outputDoc, currentDoc, sourcePageNumber - 1, extraRotation);
        }
      };

      if (addInsertPosition === "front") {
        await appendAddedPages();
        await appendCurrentPages();
      } else {
        await appendCurrentPages();
        await appendAddedPages();
      }

      const mergedBytes = await outputDoc.save();
      const mergedArray = new Uint8Array(mergedBytes);
      const previewBytes = cloneBytes(mergedArray);
      const stateBytes = cloneBytes(mergedArray);
      const task = getDocument({ data: previewBytes });
      const mergedDoc = await task.promise;

      clearThumbnailPipeline();
      await replacePdfDocument(mergedDoc);
      setPdfBytes(stateBytes);

      const mergedCount = mergedDoc.numPages;
      const mergedOrder = Array.from({ length: mergedCount }, (_, index) => index + 1);
      setPageCount(mergedCount);
      setPageOrder(mergedOrder);
      setPageRotations({});
      pageRotationsRef.current = {};

      const addCount = pagesToAdd.length;
      const oldSelected = new Set(selectedPages);
      const preservedSelection = new Set<number>();
      existingOrder.forEach((sourcePageNumber, idx) => {
        if (!oldSelected.has(sourcePageNumber)) return;
        preservedSelection.add((addInsertPosition === "front" ? addCount : 0) + idx + 1);
      });
      for (let idx = 0; idx < addCount; idx += 1) {
        preservedSelection.add((addInsertPosition === "front" ? 0 : existingOrder.length) + idx + 1);
      }
      setSelectedPages(preservedSelection);

      const oldActiveIndex = existingOrder.indexOf(activePage);
      const nextActive = oldActiveIndex >= 0
        ? (addInsertPosition === "front" ? addCount : 0) + oldActiveIndex + 1
        : 1;
      setActivePage(clamp(nextActive, 1, mergedCount));
      setPageInput(String(clamp(nextActive, 1, mergedCount)));
      setStatus({ type: "loaded", pages: mergedCount });
      closeAddPdfModal();
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfLoad" });
      setErrorText(`${tr("PDF 추가 실패", "Failed to add PDF")}: ${formatError(error)}`);
    } finally {
      setIsAddingPdf(false);
    }
  }, [
    activePage,
    addInsertPosition,
    addPdfBytes,
    addPdfPageCount,
    addRangeInput,
    clearThumbnailPipeline,
    closeAddPdfModal,
    pageCount,
    pageOrder,
    pdfBytes,
    pdfDoc,
    replacePdfDocument,
    selectedPages,
    tr,
  ]);

  const handleClosePdf = useCallback(async () => {
    setErrorText(null);
    clearThumbnailPipeline();
    await replacePdfDocument(null);
    clearPreviewCanvas();
    setPdfPath(null);
    setPdfBytes(null);
    setPageCount(0);
    setPageOrder([]);
    setActivePage(1);
    setPageInput("1");
    setSelectedPages(new Set());
    setQuickSelectInput("");
    setRangeFromInput("");
    setRangeToInput("");
    setPreviewZoom(100);
    setPageRotations({});
    pageRotationsRef.current = {};
    setStatus({ type: "ready" });
  }, [clearPreviewCanvas, clearThumbnailPipeline, replacePdfDocument]);

  const togglePageSelection = useCallback((pageNumber: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageNumber)) next.delete(pageNumber);
      else next.add(pageNumber);
      return next;
    });
  }, []);

  const removePageFromSelection = useCallback((pageNumber: number) => {
    setSelectedPages((prev) => {
      if (!prev.has(pageNumber)) return prev;
      const next = new Set(prev);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  const movePageInOrderByIndex = useCallback((sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    setPageOrder((prev) => {
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex >= prev.length || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isPointerReordering) return;
    const move = (event: MouseEvent) => {
      if (draggingPageIndex === null) return;
      const viewport = thumbViewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const relativeY = event.clientY - rect.top + viewport.scrollTop;
      const rawIndex = Math.floor(relativeY / THUMB_ITEM_HEIGHT);
      const targetIndex = clamp(rawIndex, 0, Math.max(0, pageOrderRef.current.length - 1));
      if (targetIndex === draggingPageIndex) return;
      movePageInOrderByIndex(draggingPageIndex, targetIndex);
      setDraggingPageIndex(targetIndex);
      setDropTargetPage(pageOrderRef.current[targetIndex] ?? null);
    };
    const stop = () => {
      setIsPointerReordering(false);
      setDropTargetPage(null);
      setDraggingPage(null);
      setDraggingPageIndex(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [draggingPageIndex, isPointerReordering, movePageInOrderByIndex]);

  const movePage = useCallback((delta: number) => {
    if (pageCount === 0) return;
    setActivePage((prev) => clamp(prev + delta, 1, pageCount));
  }, [pageCount]);

  const goToPage = useCallback(() => {
    if (pageCount === 0) return;
    const parsed = parsePositiveInt(pageInput);
    if (!parsed) {
      setPageInput(String(activePage));
      return;
    }
    setActivePage(clamp(parsed, 1, pageCount));
  }, [activePage, pageCount, pageInput]);

  const applyQuickSelection = useCallback(async () => {
    if (pageCount === 0) return;
    const parsed = parsePageSelectionSpec(quickSelectInput, pageCount);
    if (parsed === null) {
      await message(
        tr(
          "형식 오류: 1,3 또는 3-10 처럼 입력하세요.",
          "Invalid format. Use patterns like 1,3 or 3-10.",
        ),
        { title: tr("안내", "Notice") },
      );
      return;
    }
    setSelectedPages(parsed);
    const firstPage = Array.from(parsed).sort((a, b) => a - b)[0];
    if (firstPage) setActivePage(firstPage);
  }, [pageCount, quickSelectInput, tr]);

  const adjustZoom = useCallback((delta: number) => {
    setPreviewZoom((previous) => clamp(previous + delta, ZOOM_MIN, ZOOM_MAX));
  }, []);

  const resetZoom = useCallback(() => {
    setPreviewZoom(100);
  }, []);

  const handlePreviewWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!isPreviewFocused || !event.ctrlKey || !pdfDoc || isBusy) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      setPreviewZoom((previous) => clamp(previous + delta, ZOOM_MIN, ZOOM_MAX));
    },
    [isPreviewFocused, isBusy, pdfDoc],
  );

  const handleArrowPageNavigation = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!pdfDoc || isBusy || pageCount === 0) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      movePage(-1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      movePage(1);
    }
  }, [isBusy, movePage, pageCount, pdfDoc]);

  const rotateActivePage = useCallback((delta: number) => {
    if (pageCount === 0) return;
    const pageNumber = activePage;
    setPageRotations((previous) => {
      const current = previous[pageNumber] ?? 0;
      const nextRotation = ((current + delta) % 360 + 360) % 360;
      const next = { ...previous };
      if (nextRotation === 0) {
        delete next[pageNumber];
      } else {
        next[pageNumber] = nextRotation;
      }
      pageRotationsRef.current = next;
      return next;
    });
  }, [activePage, pageCount]);

  const applyRangeSelection = useCallback(async (mode: "add" | "remove") => {
    if (pageCount === 0) return;
    const startRaw = parsePositiveInt(rangeFromInput);
    const endRaw = parsePositiveInt(rangeToInput);
    if (!startRaw || !endRaw) {
      await message(tr("유효한 범위(시작/끝)를 입력해주세요.", "Enter a valid page range."), {
        title: tr("안내", "Notice"),
      });
      return;
    }
    const start = clamp(Math.min(startRaw, endRaw), 1, pageCount);
    const end = clamp(Math.max(startRaw, endRaw), 1, pageCount);
    setSelectedPages((prev) => {
      const next = new Set(prev);
      for (let page = start; page <= end; page += 1) {
        if (mode === "add") next.add(page);
        else next.delete(page);
      }
      return next;
    });
  }, [pageCount, rangeFromInput, rangeToInput, tr]);

  const handleSavePdf = useCallback(async () => {
    if (!pdfBytes || selectedPageNumbers.length === 0) return;
    const sourceStem = normalizeFileStem(pdfPath ?? "document.pdf");
    const exportUuid = createExportUuid();
    const targetPath = await save({
      title: tr("추출 PDF 저장", "Save extracted PDF"),
      defaultPath: `${sourceStem}_${exportUuid}_selected.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!targetPath) return;
    setIsSaving(true);
    setStatus({ type: "savingPdf" });
    try {
      let workingBytes = new Uint8Array(pdfBytes);
      if (!hasPdfHeader(workingBytes) && pdfPath) {
        const reloaded = new Uint8Array(await readFile(pdfPath));
        if (hasPdfHeader(reloaded)) {
          workingBytes = reloaded;
          setPdfBytes(new Uint8Array(reloaded));
        }
      }
      if (!hasPdfHeader(workingBytes)) {
        throw new Error("Working PDF data is invalid. Please reopen the PDF and try again.");
      }
      const sourceDocument = await PDFDocument.load(workingBytes, { updateMetadata: false });
      const outputDocument = await PDFDocument.create();
      for (const sourcePageNumber of selectedPageNumbers) {
        const extraRotation = pageRotationsRef.current[sourcePageNumber] ?? 0;
        await appendPageWithRotation(outputDocument, sourceDocument, sourcePageNumber - 1, extraRotation);
      }
      const outputBytes = await outputDocument.save();
      await writeFile(targetPath, outputBytes);
      if (openExplorerAfterSave) {
        try {
          await revealItemInDir(targetPath);
        } catch {
          // Ignore explorer open failures; save itself already succeeded.
        }
      }
      setStatus({ type: "savedPdf", pages: selectedPageNumbers.length });
      showToast(
        tr(
          `선택한 ${selectedPageNumbers.length}페이지를 PDF로 저장했습니다.`,
          `Saved ${selectedPageNumbers.length} selected pages to PDF.`,
        ),
      );
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfSave" });
      setErrorText(`${tr("PDF 저장 실패", "PDF save failed")}: ${formatError(error)}`);
    } finally {
      setIsSaving(false);
    }
  }, [openExplorerAfterSave, pdfBytes, pdfPath, selectedPageNumbers, showToast, tr]);

  const handleSaveImages = useCallback(async (type: "png" | "jpg") => {
    if (!pdfDoc || selectedPageNumbers.length === 0) return;
    const targetDirectory = await open({
      title: tr("저장 폴더 선택", "Select output folder"),
      directory: true,
      multiple: false,
    });
    if (!targetDirectory || Array.isArray(targetDirectory)) return;
    const mimeType = type === "png" ? "image/png" : "image/jpeg";
    const extension = type === "png" ? "png" : "jpg";
    const quality = type === "png" ? undefined : 0.92;
    const fileStem = normalizeFileStem(pdfPath ?? "document.pdf");
    const total = selectedPageNumbers.length;
    const workerCount = Math.min(total, Math.max(1, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2))));
    let cursor = 0;
    let completed = 0;
    const takePage = () => {
      const idx = cursor;
      cursor += 1;
      return idx < total ? selectedPageNumbers[idx] : null;
    };
    setIsSaving(true);
    setStatus({ type: "savingImages", done: 0, total });
    try {
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          const pageNumber = takePage();
          if (pageNumber === null) return;
          const page = await pdfDoc.getPage(pageNumber);
          const rotation = pageRotationsRef.current[pageNumber] ?? 0;
          const imageBlob = await renderPageToBlob(
            page,
            IMAGE_EXPORT_SCALE,
            mimeType,
            quality,
            rotation,
          );
          const imageBytes = new Uint8Array(await imageBlob.arrayBuffer());
          const targetPath = await join(targetDirectory, `${fileStem}_p${String(pageNumber).padStart(4, "0")}.${extension}`);
          await writeFile(targetPath, imageBytes);
          completed += 1;
          if (completed % 5 === 0 || completed === total) setStatus({ type: "savingImages", done: completed, total });
        }
      }));
      if (openExplorerAfterSave) {
        try {
          await openPath(targetDirectory);
        } catch {
          // Ignore explorer open failures; save itself already succeeded.
        }
      }
      setStatus({ type: "savedImages", total });
      showToast(tr(`선택한 ${total}페이지를 이미지로 저장했습니다.`, `Saved ${total} selected pages as images.`));
    } catch (error) {
      setStatus({ type: "failed", reason: "imageSave" });
      setErrorText(`${tr("이미지 저장 실패", "Image save failed")}: ${formatError(error)}`);
    } finally {
      setIsSaving(false);
    }
  }, [openExplorerAfterSave, pdfDoc, pdfPath, selectedPageNumbers, showToast, tr]);

  const handleSaveSelection = useCallback(async () => {
    setErrorText(null);
    if (!pdfDoc || !pdfBytes) {
      await message(tr("먼저 PDF를 열어주세요.", "Open a PDF first."), { title: tr("안내", "Notice") });
      return;
    }
    if (selectedPageNumbers.length === 0) {
      await message(tr("저장할 페이지를 하나 이상 선택해주세요.", "Select at least one page to save."), {
        title: tr("안내", "Notice"),
      });
      return;
    }
    if (saveType === "pdf") await handleSavePdf();
    else await handleSaveImages(saveType);
  }, [pdfDoc, pdfBytes, selectedPageNumbers.length, saveType, handleSavePdf, handleSaveImages, tr]);

  const totalThumbHeight = pageOrder.length * THUMB_ITEM_HEIGHT;

  return (
    <div className="app-shell">
      <section className="toolbar-grid">
        <div className="panel toolbar-row">
          <div className="action-group toolbar-block file-block">
            <button className="primary-btn" onClick={() => void handleOpenPdf()} disabled={isBusy}>{tr("PDF 열기", "Open PDF")}</button>
            <button className="ghost-btn" onClick={() => void handleOpenAddPdfModal()} disabled={!pdfDoc || !pdfBytes || isBusy}>
              {tr("PDF 추가", "Add PDF")}
            </button>
            <button className="ghost-btn" onClick={() => void handleMergePdfs()} disabled={isBusy}>
              {tr("PDF 병합", "Merge PDFs")}
            </button>
            {pdfDoc ? (
              <button className="ghost-btn" onClick={() => void handleClosePdf()} disabled={isBusy}>
                {tr("닫기", "Close")}
              </button>
            ) : null}
            <label className="locale-control">
              <span>{tr("언어", "Language")}</span>
              <select value={locale} onChange={(event) => setLocale(event.currentTarget.value as Locale)}>
                <option value="ko">{tr("한국어", "Korean")}</option>
                <option value="en">{tr("영어", "English")}</option>
              </select>
            </label>
          </div>

          <div className="action-group toolbar-block select-block">
            <label className="inline-field quick-select-field">
              <span>{tr("빠른 선택", "Quick select")}</span>
              <input
                value={quickSelectInput}
                onChange={(event) => setQuickSelectInput(event.currentTarget.value)}
                placeholder="1,3 or 3-10"
                disabled={!pdfDoc || isBusy}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void applyQuickSelection();
                }}
              />
            </label>
            <button className="ghost-btn" onClick={() => void applyQuickSelection()} disabled={!pdfDoc || isBusy}>
              {tr("적용", "Apply")}
            </button>
            <button className="ghost-btn" onClick={() => setSelectedPages(new Set(pageNumbers))} disabled={!pdfDoc || isBusy || pageCount === 0}>{tr("전체 선택", "Select all")}</button>
            <button className="ghost-btn" onClick={() => setSelectedPages(new Set())} disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}>{tr("선택 해제", "Clear selection")}</button>
            <label className="inline-field range-field"><span>{tr("범위 선택", "Range select")}</span>
              <input value={rangeFromInput} onChange={(event) => setRangeFromInput(event.currentTarget.value)} placeholder={tr("시작", "Start")} inputMode="numeric" disabled={!pdfDoc || isBusy} />
              <span className="range-separator">~</span>
              <input value={rangeToInput} onChange={(event) => setRangeToInput(event.currentTarget.value)} placeholder={tr("끝", "End")} inputMode="numeric" disabled={!pdfDoc || isBusy} />
            </label>
            <button className="ghost-btn" onClick={() => void applyRangeSelection("add")} disabled={!pdfDoc || isBusy}>{tr("범위 추가", "Add range")}</button>
            <button className="ghost-btn" onClick={() => void applyRangeSelection("remove")} disabled={!pdfDoc || isBusy}>{tr("범위 제외", "Remove range")}</button>
          </div>

          <div className="action-group toolbar-block view-block">
            <button className="ghost-btn" onClick={() => movePage(-1)} disabled={!pdfDoc || isBusy || activePage <= 1}>{tr("이전", "Previous")}</button>
            <label className="inline-field page-field"><span>{tr("페이지", "Page")}</span>
              <input value={pageInput} onChange={(event) => setPageInput(event.currentTarget.value)} onBlur={goToPage} onKeyDown={(event) => { if (event.key === "Enter") goToPage(); }} inputMode="numeric" disabled={!pdfDoc || isBusy} />
            </label>
            <button className="ghost-btn" onClick={goToPage} disabled={!pdfDoc || isBusy}>{tr("이동", "Go")}</button>
            <button className="ghost-btn" onClick={() => movePage(1)} disabled={!pdfDoc || isBusy || activePage >= pageCount}>{tr("다음", "Next")}</button>
          </div>
          <div className="action-group">
            <label className="inline-field zoom-field">
              <span>{tr("확대", "Zoom")}</span>
              <button
                className="ghost-btn mini-btn"
                onClick={() => adjustZoom(-ZOOM_STEP)}
                disabled={!pdfDoc || isBusy}
                type="button"
              >
                -
              </button>
              <span className="zoom-value">{previewZoom}%</span>
              <button
                className="ghost-btn mini-btn"
                onClick={() => adjustZoom(ZOOM_STEP)}
                disabled={!pdfDoc || isBusy}
                type="button"
              >
                +
              </button>
              <button
                className="ghost-btn mini-btn"
                onClick={resetZoom}
                disabled={!pdfDoc || isBusy}
                type="button"
              >
                {tr("맞춤", "Fit")}
              </button>
            </label>
            <button
              className="ghost-btn"
              onClick={() => rotateActivePage(-90)}
              disabled={!pdfDoc || isBusy}
              type="button"
            >
              {tr("왼쪽 회전", "Rotate Left")}
            </button>
            <button
              className="ghost-btn"
              onClick={() => rotateActivePage(90)}
              disabled={!pdfDoc || isBusy}
              type="button"
            >
              {tr("오른쪽 회전", "Rotate Right")}
            </button>
          </div>

          <div className="action-group toolbar-block save-block">
            <label className="inline-field"><span>{tr("저장 형식", "Save type")}</span>
              <select value={saveType} onChange={(event) => setSaveType(event.currentTarget.value as SaveType)} disabled={!pdfDoc || isBusy}>
                <option value="pdf">PDF</option>
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
              </select>
            </label>
            <label className="inline-field">
              <span>{tr("저장후탐색기", "After save explorer")}</span>
              <select
                value={openExplorerAfterSave ? "open" : "no-open"}
                onChange={(event) => setOpenExplorerAfterSave(event.currentTarget.value === "open")}
                disabled={isBusy}
              >
                <option value="open">{tr("열기", "Open")}</option>
                <option value="no-open">{tr("안열기", "Do not open")}</option>
              </select>
            </label>
            <button className="primary-btn" onClick={() => void handleSaveSelection()} disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}>{tr("선택 저장", "Save selection")}</button>
          </div>

          <div className="action-group toolbar-block status-inline">
            <span>{statusText}</span>
            <span>{tr("선택", "Selected")} {selectedPageNumbers.length} / {tr("전체", "Total")} {pageCount}</span>
          </div>
        </div>
      </section>

      {errorText ? <section className="panel error-banner">{errorText}</section> : null}
      {toastText ? <section className="toast-banner">{toastText}</section> : null}

      <main className="workspace">
        <aside className="panel sidebar">
          <div className="sidebar-head">
            <strong>{pdfPath ? normalizeFileStem(pdfPath) : tr("불러온 PDF 없음", "No PDF loaded")}</strong>
            <span>{tr("대용량 PDF도 스크롤 구간만 썸네일 렌더링", "Only visible range thumbnails are rendered for large PDFs")}</span>
            <span>{tr("썸네일", "Thumbnails")} {loadedThumbCount}/{pageCount} ({tr("대기/처리", "queued/working")} {thumbQueueCount})</span>
          </div>
          <div
            className="thumbnail-viewport"
            ref={thumbViewportRef}
            tabIndex={0}
            onMouseDown={(event) => event.currentTarget.focus()}
            onKeyDown={handleArrowPageNavigation}
            onScroll={(event) => setThumbScrollTop(event.currentTarget.scrollTop)}
          >
            {pageCount === 0 ? <div className="empty-panel">{tr("PDF를 열면 페이지가 표시됩니다.", "Pages appear after opening a PDF.")}</div> : (
              <div className="thumbnail-inner" style={{ height: `${totalThumbHeight}px` }}>
                {visiblePageNumbers.map((pageNumber) => (
                  <article
                    key={pageNumber}
                    className={`thumb-card ${activePage === pageNumber ? "active" : ""} ${draggingPage === pageNumber ? "dragging" : ""} ${dropTargetPage === pageNumber ? "drop-target" : ""}`}
                    style={{ top: `${(pageOrderIndexMap[pageNumber] ?? 0) * THUMB_ITEM_HEIGHT}px` }}
                  >
                    <div className="thumb-head">
                      <span className="thumb-head-left">
                        <span
                          className="thumb-drag-handle"
                          title={tr("여기를 잡고 드래그하여 순서 이동", "Drag here to reorder")}
                          aria-label={tr("드래그 핸들", "Drag handle")}
                          onMouseDown={(event) => {
                            if (isBusy) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setIsPointerReordering(true);
                            setDraggingPage(pageNumber);
                            setDraggingPageIndex(pageOrderIndexMap[pageNumber] ?? null);
                            setDropTargetPage(pageNumber);
                          }}
                        >
                          |||
                        </span>
                        <span>{pageNumber}p</span>
                      </span>
                      <div className="thumb-actions" onClick={(event) => event.stopPropagation()}>
                        <label className="thumb-check">
                          <input type="checkbox" checked={selectedPages.has(pageNumber)} onChange={() => togglePageSelection(pageNumber)} />
                          {tr("선택", "Pick")}
                        </label>
                        <button
                          type="button"
                          className="thumb-trash-btn"
                          onClick={() => removePageFromSelection(pageNumber)}
                          disabled={!selectedPages.has(pageNumber) || isBusy}
                          title={tr("선택 해제", "Remove from selection")}
                        >
                          {tr("휴지통", "Trash")}
                        </button>
                      </div>
                    </div>
                    <button className="thumb-preview-btn" onClick={() => setActivePage(pageNumber)} type="button">
                      {thumbnailUrls[pageNumber] ? (
                        <img
                          src={thumbnailUrls[pageNumber]}
                          alt={`${tr("페이지", "Page")} ${pageNumber}`}
                          style={{
                            transform: `rotate(${pageRotations[pageNumber] ?? 0}deg)`,
                          }}
                        />
                      ) : (
                        <div className="thumb-loading">{tr("렌더링 중...", "Rendering...")}</div>
                      )}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="panel preview-panel" ref={previewHostRef}>
          {pdfDoc ? (
            <>
              <div
                className={`preview-canvas-wrap ${isPreviewFocused ? "focused" : ""}`}
                tabIndex={0}
                onFocus={() => setIsPreviewFocused(true)}
                onBlur={() => setIsPreviewFocused(false)}
                onMouseDown={(event) => event.currentTarget.focus()}
                onWheel={handlePreviewWheel}
                onKeyDown={handleArrowPageNavigation}
              >
                <canvas ref={previewCanvasRef} />
              </div>
            </>
          ) : (
            <div className="empty-panel">{tr("선택한 페이지가 오른쪽에 크게 표시됩니다.", "Large page preview appears here.")}</div>
          )}
        </section>
      </main>

      {showMergePdfModal ? (
        <div className="modal-backdrop" onClick={() => closeMergePdfModal()}>
          <section className="panel add-pdf-modal merge-pdf-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{tr("PDF 병합", "Merge PDFs")}</h2>
            <p>{tr("드래그앤드랍으로 병합 순서를 정하세요.", "Drag and drop to reorder merge files.")}</p>
            <div className="modal-row">
              <span>{tr("삽입 위치", "Insert position")}</span>
              <label>
                <input
                  type="radio"
                  name="merge-position"
                  value="front"
                  checked={mergeInsertPosition === "front"}
                  onChange={() => setMergeInsertPosition("front")}
                  disabled={isAddingPdf}
                />
                {tr("앞쪽", "Front")}
              </label>
              <label>
                <input
                  type="radio"
                  name="merge-position"
                  value="back"
                  checked={mergeInsertPosition === "back"}
                  onChange={() => setMergeInsertPosition("back")}
                  disabled={isAddingPdf}
                />
                {tr("뒤쪽", "Back")}
              </label>
              <label>
                <input
                  type="radio"
                  name="merge-position"
                  value="beforeActive"
                  checked={mergeInsertPosition === "beforeActive"}
                  onChange={() => setMergeInsertPosition("beforeActive")}
                  disabled={isAddingPdf || !pdfDoc}
                />
                {tr("현재 앞", "Before current")}
              </label>
              <label>
                <input
                  type="radio"
                  name="merge-position"
                  value="afterActive"
                  checked={mergeInsertPosition === "afterActive"}
                  onChange={() => setMergeInsertPosition("afterActive")}
                  disabled={isAddingPdf || !pdfDoc}
                />
                {tr("현재 뒤", "After current")}
              </label>
            </div>
            <div className="merge-list">
              {mergePdfPaths.map((path, index) => (
                <article
                  key={path}
                  className={`merge-item ${mergeDraggingPath === path ? "dragging" : ""} ${mergeDropPath === path ? "drop-target" : ""}`}
                  draggable={!isAddingPdf}
                  onDragStart={(event) => {
                    if (isAddingPdf) return;
                    setMergeDraggingPath(path);
                    setMergeDraggingIndex(index);
                    setMergeDropPath(null);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", path);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (mergeDraggingIndex === null || mergeDraggingIndex === index) return;
                    moveMergePdfPathByIndex(mergeDraggingIndex, index);
                    setMergeDraggingIndex(index);
                    setMergeDropPath(path);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setMergeDropPath(null);
                    setMergeDraggingPath(null);
                    setMergeDraggingIndex(null);
                  }}
                  onDragEnd={() => {
                    setMergeDropPath(null);
                    setMergeDraggingPath(null);
                    setMergeDraggingIndex(null);
                  }}
                >
                  <span className="merge-index">{index + 1}</span>
                  <span className="merge-name">{normalizeFileStem(path)}</span>
                </article>
              ))}
            </div>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => closeMergePdfModal()} disabled={isAddingPdf} type="button">
                {tr("취소", "Cancel")}
              </button>
              <button className="primary-btn" onClick={() => void handleApplyMergePdfs()} disabled={isAddingPdf || mergePdfPaths.length === 0} type="button">
                {isAddingPdf ? tr("병합 중...", "Merging...") : tr("병합 실행", "Merge")}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showAddPdfModal ? (
        <div className="modal-backdrop" onClick={() => closeAddPdfModal()}>
          <section className="panel add-pdf-modal" onClick={(event) => event.stopPropagation()}>
            <h2>{tr("PDF 추가", "Add PDF")}</h2>
            <p>
              {tr("파일", "File")}: <strong>{addPdfPath ? normalizeFileStem(addPdfPath) : "-"}</strong>
              {" · "}
              {tr("페이지", "Pages")} {addPdfPageCount}
            </p>
            <div className="modal-row">
              <span>{tr("추가 위치", "Insert position")}</span>
              <label>
                <input
                  type="radio"
                  name="add-position"
                  value="front"
                  checked={addInsertPosition === "front"}
                  onChange={() => setAddInsertPosition("front")}
                  disabled={isAddingPdf}
                />
                {tr("앞쪽으로", "To front")}
              </label>
              <label>
                <input
                  type="radio"
                  name="add-position"
                  value="back"
                  checked={addInsertPosition === "back"}
                  onChange={() => setAddInsertPosition("back")}
                  disabled={isAddingPdf}
                />
                {tr("뒤쪽으로", "To back")}
              </label>
            </div>
            <label className="modal-range-field">
              <span>{tr("추가 범위", "Pages to add")}</span>
              <input
                value={addRangeInput}
                onChange={(event) => setAddRangeInput(event.currentTarget.value)}
                placeholder="1-3, 5, 9"
                disabled={isAddingPdf}
              />
              <small>{tr("비워두면 전체 페이지를 추가합니다.", "Leave empty to add all pages.")}</small>
            </label>
            <div className="modal-actions">
              <button className="ghost-btn" onClick={() => closeAddPdfModal()} disabled={isAddingPdf} type="button">
                {tr("취소", "Cancel")}
              </button>
              <button className="primary-btn" onClick={() => void handleApplyAddPdf()} disabled={isAddingPdf} type="button">
                {isAddingPdf ? tr("추가 중...", "Adding...") : tr("추가 실행", "Add")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
