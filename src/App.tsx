import { join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { PDFDocument } from "pdf-lib";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type KeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddPdfModal from "./components/AddPdfModal";
import MergePdfModal from "./components/MergePdfModal";
import {
  APP_VERSION,
  IMAGE_EXPORT_SCALE,
  OUTLINE_LOAD_TIMEOUT_MS,
  OUTLINE_MAX_DEPTH,
  OUTLINE_SAVE_WAIT_POLL_MS,
  OUTLINE_SAVE_WAIT_TIMEOUT_MS,
  PROJECT_REPO_URL,
  THUMB_ITEM_HEIGHT,
  THUMB_OVERSCAN,
  THUMB_PREFETCH,
  THUMB_CACHE_LIMIT,
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_SCALE,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  appendPageWithRotation,
  applyOutlineEntriesToPdfDocument,
  buildPreviewTextSpans,
  clamp,
  cloneBytes,
  createExportUuid,
  createOutlineEntryId,
  detectLocale,
  extractOutlineCandidatesFromText,
  flattenPdfOutlineNodes,
  formatError,
  hasPdfHeader,
  normalizeFileStem,
  normalizeOutlineDepth,
  normalizeOutlineTitle,
  normalizeSelectionRect,
  parsePageSelectionSpec,
  parsePositiveInt,
  renderPageToBlob,
  type Locale,
  type OutlineEntry,
  type PdfOutlineNode,
  type OutlinePanelMode,
  type PreviewSelectionRect,
  type PreviewTextSpan,
  type SaveType,
  type SidebarTab,
  type StatusState,
} from "./app/app-helpers";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerSrc;

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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("thumbnails");
  const [outlinePanelMode, setOutlinePanelMode] = useState<OutlinePanelMode>("view");
  const [outlineEntries, setOutlineEntries] = useState<OutlineEntry[]>([]);
  const [isLoadingOutline, setIsLoadingOutline] = useState(false);
  const [isGeneratingOutline, setIsGeneratingOutline] = useState(false);
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
  const mergeListRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<StatusState>({ type: "ready" });
  const [errorText, setErrorText] = useState<string | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [showHelpInfo, setShowHelpInfo] = useState(false);
  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState<boolean>(() => window.localStorage.getItem("app.toolbarCollapsed") === "1");
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>({});
  const [thumbQueueCount, setThumbQueueCount] = useState(0);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const [thumbViewportHeight, setThumbViewportHeight] = useState(0);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [previewPageSize, setPreviewPageSize] = useState({ width: 0, height: 0 });
  const [previewTextSpans, setPreviewTextSpans] = useState<PreviewTextSpan[]>([]);
  const [selectedPreviewText, setSelectedPreviewText] = useState("");
  const [isAreaSelectMode, setIsAreaSelectMode] = useState(false);
  const [isAreaSelecting, setIsAreaSelecting] = useState(false);
  const [previewSelectionRect, setPreviewSelectionRect] = useState<PreviewSelectionRect | null>(null);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [isPreviewFocused, setIsPreviewFocused] = useState(false);
  const [draggingPage, setDraggingPage] = useState<number | null>(null);
  const [dropTargetPage, setDropTargetPage] = useState<number | null>(null);
  const [draggingPageIndex, setDraggingPageIndex] = useState<number | null>(null);
  const [isPointerReordering, setIsPointerReordering] = useState(false);
  const [isOutlinePointerReordering, setIsOutlinePointerReordering] = useState(false);
  const [draggingOutlineId, setDraggingOutlineId] = useState<string | null>(null);
  const [draggingOutlineIndex, setDraggingOutlineIndex] = useState<number | null>(null);
  const [outlineDropTargetId, setOutlineDropTargetId] = useState<string | null>(null);

  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const previewInteractionRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewTextLayerRef = useRef<HTMLDivElement | null>(null);
  const thumbViewportRef = useRef<HTMLDivElement | null>(null);
  const outlineListRef = useRef<HTMLDivElement | null>(null);
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
  const previewSelectionRectRef = useRef<PreviewSelectionRect | null>(null);
  const wheelPageDeltaRef = useRef(0);
  const lastWheelPageNavAtRef = useRef(0);
  const outlineEntriesRef = useRef<OutlineEntry[]>([]);
  const isLoadingOutlineRef = useRef(isLoadingOutline);

  const isBusy = isLoadingPdf || isSaving || isAddingPdf;
  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);
  const selectedPageNumbers = useMemo(() => pageOrder.filter((pageNumber) => selectedPages.has(pageNumber)), [pageOrder, selectedPages]);
  const validOutlineEntries = useMemo(
    () => outlineEntries
      .map((entry) => ({
        ...entry,
        title: normalizeOutlineTitle(entry.title),
        pageNumber: clamp(Math.floor(entry.pageNumber), 1, Math.max(1, pageCount)),
        depth: normalizeOutlineDepth(entry.depth),
      }))
      .filter((entry) => entry.title.length > 0),
    [outlineEntries, pageCount],
  );
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
    window.localStorage.setItem("app.toolbarCollapsed", isToolbarCollapsed ? "1" : "0");
  }, [isToolbarCollapsed]);

  useEffect(() => {
    pageRotationsRef.current = pageRotations;
  }, [pageRotations]);

  useEffect(() => {
    pageOrderRef.current = pageOrder;
  }, [pageOrder]);

  useEffect(() => {
    outlineEntriesRef.current = outlineEntries;
  }, [outlineEntries]);

  useEffect(() => {
    isLoadingOutlineRef.current = isLoadingOutline;
  }, [isLoadingOutline]);

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

  useEffect(() => {
    previewSelectionRectRef.current = previewSelectionRect;
  }, [previewSelectionRect]);

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
    setPreviewPageSize({ width: 0, height: 0 });
    setPreviewTextSpans([]);
    setSelectedPreviewText("");
    setPreviewSelectionRect(null);
    setIsAreaSelecting(false);
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

  const readOutlineEntriesFromDocument = useCallback(async (doc: PDFDocumentProxy): Promise<OutlineEntry[]> => {
    let timeoutHandle: number | null = null;
    const rawOutline = await Promise.race([
      doc.getOutline(),
      new Promise<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>((resolve) => {
        timeoutHandle = window.setTimeout(() => resolve([]), OUTLINE_LOAD_TIMEOUT_MS);
      }),
    ]);
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    if (!rawOutline || rawOutline.length === 0) return [];
    const entries: OutlineEntry[] = [];
    await flattenPdfOutlineNodes(doc, rawOutline as unknown as PdfOutlineNode[], 0, entries);
    return entries;
  }, []);

  useEffect(() => {
    if (!pdfDoc) {
      setOutlineEntries([]);
      setIsLoadingOutline(false);
      setIsGeneratingOutline(false);
      setSidebarTab("thumbnails");
      setOutlinePanelMode("view");
      return;
    }
    let cancelled = false;
    setIsLoadingOutline(true);
    void (async () => {
      try {
        const entries = await readOutlineEntriesFromDocument(pdfDoc);
        if (!cancelled) setOutlineEntries(entries);
      } catch (error) {
        if (!cancelled) setErrorText(`${tr("목차 로딩 실패", "Failed to load outline")}: ${formatError(error)}`);
      } finally {
        if (!cancelled) setIsLoadingOutline(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, readOutlineEntriesFromDocument, tr]);

  const reloadOutlineFromPdf = useCallback(async () => {
    if (!pdfDoc || isBusy) return;
    setErrorText(null);
    setIsLoadingOutline(true);
    try {
      const entries = await readOutlineEntriesFromDocument(pdfDoc);
      setOutlineEntries(entries);
      setSidebarTab("outline");
      setOutlinePanelMode("view");
      showToast(
        tr(
          `PDF 목차 ${entries.length}개를 불러왔습니다.`,
          `Loaded ${entries.length} outline items from PDF.`,
        ),
      );
    } catch (error) {
      setErrorText(`${tr("목차 로딩 실패", "Failed to load outline")}: ${formatError(error)}`);
    } finally {
      setIsLoadingOutline(false);
    }
  }, [isBusy, pdfDoc, readOutlineEntriesFromDocument, showToast, tr]);

  const addManualOutlineAtActivePage = useCallback(() => {
    if (pageCount === 0) return;
    setOutlineEntries((prev) => ([
      ...prev,
      {
        id: createOutlineEntryId(),
        title: tr(`새 목차 ${prev.length + 1}`, `New outline ${prev.length + 1}`),
        pageNumber: activePage,
        depth: 0,
        source: "manual",
      },
    ]));
    setSidebarTab("outline");
    setOutlinePanelMode("edit");
  }, [activePage, pageCount, tr]);

  const appendOutlineFromBodyText = useCallback(async () => {
    if (!pdfDoc || isBusy || isGeneratingOutline) return;
    setErrorText(null);
    setIsGeneratingOutline(true);
    try {
      const candidates = await extractOutlineCandidatesFromText(pdfDoc);
      if (candidates.length === 0) {
        showToast(tr("본문에서 목차 후보를 찾지 못했습니다.", "No outline candidates found from document text."));
        return;
      }
      setOutlineEntries((prev) => {
        const seen = new Set(prev.map((entry) => `${entry.pageNumber}:${normalizeOutlineTitle(entry.title).toLowerCase()}`));
        const next = [...prev];
        for (const candidate of candidates) {
          const key = `${candidate.pageNumber}:${candidate.title.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({
            id: createOutlineEntryId(),
            title: candidate.title,
            pageNumber: candidate.pageNumber,
            depth: 0,
            source: "text",
          });
        }
        return next;
      });
      setSidebarTab("outline");
      setOutlinePanelMode("edit");
      showToast(tr("본문 인식 텍스트로 목차를 추가했습니다.", "Added outline entries from detected body text."));
    } catch (error) {
      setErrorText(`${tr("본문 텍스트 분석 실패", "Failed to analyze body text")}: ${formatError(error)}`);
    } finally {
      setIsGeneratingOutline(false);
    }
  }, [isBusy, isGeneratingOutline, pdfDoc, showToast, tr]);

  const updateOutlineTitle = useCallback((entryId: string, nextTitle: string) => {
    setOutlineEntries((prev) => prev.map((entry) => (entry.id === entryId ? { ...entry, title: nextTitle } : entry)));
  }, []);

  const updateOutlinePageNumber = useCallback((entryId: string, nextPageText: string) => {
    const parsed = parsePositiveInt(nextPageText);
    if (!parsed) return;
    setOutlineEntries((prev) => prev.map((entry) => (
      entry.id === entryId
        ? { ...entry, pageNumber: clamp(parsed, 1, Math.max(1, pageCount)) }
        : entry
    )));
  }, [pageCount]);

  const updateOutlineDepth = useCallback((entryId: string, nextDepth: number) => {
    setOutlineEntries((prev) => prev.map((entry) => (
      entry.id === entryId
        ? { ...entry, depth: normalizeOutlineDepth(nextDepth) }
        : entry
    )));
  }, []);

  const removeOutlineEntry = useCallback((entryId: string) => {
    setOutlineEntries((prev) => prev.filter((entry) => entry.id !== entryId));
  }, []);

  const clearOutlineEntries = useCallback(() => {
    setIsOutlinePointerReordering(false);
    setDraggingOutlineId(null);
    setDraggingOutlineIndex(null);
    setOutlineDropTargetId(null);
    setOutlineEntries([]);
  }, []);

  const clearOutlineDragState = useCallback(() => {
    setIsOutlinePointerReordering(false);
    setDraggingOutlineId(null);
    setDraggingOutlineIndex(null);
    setOutlineDropTargetId(null);
  }, []);

  useEffect(() => {
    if (sidebarTab === "outline" && outlinePanelMode === "edit") return;
    clearOutlineDragState();
  }, [clearOutlineDragState, outlinePanelMode, sidebarTab]);

  const moveOutlineEntry = useCallback((entryId: string, delta: -1 | 1) => {
    setOutlineEntries((prev) => {
      const index = prev.findIndex((entry) => entry.id === entryId);
      if (index < 0) return prev;
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next;
    });
  }, []);

  const moveOutlineEntryByIndex = useCallback((sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    setOutlineEntries((prev) => {
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex >= prev.length || targetIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isOutlinePointerReordering) return;
    const move = (event: MouseEvent) => {
      if (draggingOutlineIndex === null) return;
      const listElement = outlineListRef.current;
      if (!listElement) return;
      const hovered = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const targetItem = hovered?.closest(".outline-item") as HTMLElement | null;
      const targetId = targetItem?.dataset.outlineId;
      if (!targetId) return;
      const targetIndex = outlineEntriesRef.current.findIndex((entry) => entry.id === targetId);
      if (targetIndex < 0 || targetIndex === draggingOutlineIndex) return;
      moveOutlineEntryByIndex(draggingOutlineIndex, targetIndex);
      setDraggingOutlineIndex(targetIndex);
      setOutlineDropTargetId(targetId);
    };
    const stop = () => {
      clearOutlineDragState();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [clearOutlineDragState, draggingOutlineIndex, isOutlinePointerReordering, moveOutlineEntryByIndex]);

  const jumpToOutlinePage = useCallback((pageNumber: number) => {
    if (pageCount === 0) return;
    setActivePage(clamp(pageNumber, 1, pageCount));
  }, [pageCount]);

  const addSelectedPreviewTextToOutline = useCallback(async () => {
    const text = normalizeOutlineTitle(selectedPreviewText);
    if (text.length === 0) {
      await message(tr("본문에서 텍스트를 먼저 선택해주세요.", "Select text in the page body first."), {
        title: tr("안내", "Notice"),
      });
      return;
    }
    setOutlineEntries((prev) => ([
      ...prev,
      {
        id: createOutlineEntryId(),
        title: text.length > 120 ? `${text.slice(0, 120).trimEnd()}...` : text,
        pageNumber: activePage,
        depth: 0,
        source: "text",
      },
    ]));
    setSidebarTab("outline");
    setOutlinePanelMode("edit");
    showToast(tr("선택한 본문 텍스트를 목차에 추가했습니다.", "Added selected body text to outline."));
  }, [activePage, selectedPreviewText, showToast, tr]);

  const handlePreviewTextLayerMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isAreaSelectMode || event.button !== 0) return;
    const layer = previewTextLayerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setIsAreaSelecting(true);
    setPreviewSelectionRect({ x1: x, y1: y, x2: x, y2: y });
    setSelectedPreviewText("");
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
    event.preventDefault();
  }, [isAreaSelectMode]);

  useEffect(() => {
    if (!isAreaSelecting) return;
    const move = (event: MouseEvent) => {
      const layer = previewTextLayerRef.current;
      if (!layer) return;
      const rect = layer.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setPreviewSelectionRect((prev) => (prev ? { ...prev, x2: x, y2: y } : prev));
    };
    const stop = () => {
      setIsAreaSelecting(false);
      const layer = previewTextLayerRef.current;
      const rectData = previewSelectionRectRef.current;
      if (!layer || !rectData) return;
      const normalized = normalizeSelectionRect(rectData);
      const selected: string[] = [];
      const layerRect = layer.getBoundingClientRect();
      const spans = Array.from(layer.querySelectorAll<HTMLElement>(".preview-text-span"));
      for (const span of spans) {
        const r = span.getBoundingClientRect();
        const left = r.left - layerRect.left;
        const top = r.top - layerRect.top;
        const right = left + r.width;
        const bottom = top + r.height;
        const intersects = !(right < normalized.left || left > normalized.right || bottom < normalized.top || top > normalized.bottom);
        if (!intersects) continue;
        const text = normalizeOutlineTitle(span.dataset.text ?? span.textContent ?? "");
        if (text.length > 0) selected.push(text);
      }
      setPreviewSelectionRect(null);
      const joined = normalizeOutlineTitle(selected.join(" "));
      if (joined.length > 0) setSelectedPreviewText(joined);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [isAreaSelecting]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (isAreaSelecting || isAreaSelectMode) return;
      const selection = window.getSelection();
      const layer = previewTextLayerRef.current;
      if (!selection || !layer) return;
      if (selection.isCollapsed) {
        setSelectedPreviewText("");
        return;
      }
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      const isInsideLayer = (node: Node | null) => !!node && (node === layer || layer.contains(node));
      if (!isInsideLayer(anchor) || !isInsideLayer(focus)) return;
      setSelectedPreviewText(normalizeOutlineTitle(selection.toString()));
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [isAreaSelecting, isAreaSelectMode]);

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
        const textContent = await page.getTextContent();
        if (cancelled) return;
        setPreviewPageSize({
          width: Math.max(1, Math.floor(viewport.width)),
          height: Math.max(1, Math.floor(viewport.height)),
        });
        setPreviewTextSpans(buildPreviewTextSpans(textContent.items, viewport.transform, viewport.scale));
        setSelectedPreviewText("");
        setPreviewSelectionRect(null);
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

  const resetPdfWorkspace = useCallback(async () => {
    clearOutlineDragState();
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
    setSidebarTab("thumbnails");
    setOutlinePanelMode("view");
    setOutlineEntries([]);
    setIsLoadingOutline(false);
    setIsGeneratingOutline(false);
    setQuickSelectInput("");
    setRangeFromInput("");
    setRangeToInput("");
    setPreviewZoom(100);
    setIsAreaSelectMode(false);
    setPageRotations({});
    pageRotationsRef.current = {};
  }, [clearOutlineDragState, clearPreviewCanvas, clearThumbnailPipeline, replacePdfDocument]);

  const loadPdfFromPath = useCallback(async (path: string) => {
    setIsLoadingPdf(true);
    setStatus({ type: "loadingPdf" });
    try {
      await resetPdfWorkspace();
      const fileBytes = new Uint8Array(await readFile(path));
      const previewBytes = cloneBytes(fileBytes);
      const stateBytes = cloneBytes(fileBytes);
      const task = getDocument({ data: previewBytes });
      const loadedDoc = await task.promise;
      await replacePdfDocument(loadedDoc);
      setPdfPath(path);
      setPdfBytes(stateBytes);
      setPageCount(loadedDoc.numPages);
      setPageOrder(Array.from({ length: loadedDoc.numPages }, (_, idx) => idx + 1));
      setActivePage(1);
      setPageInput("1");
      setSelectedPages(new Set([1]));
      setSidebarTab("thumbnails");
      setOutlinePanelMode("view");
      setRangeFromInput("");
      setRangeToInput("");
      setPreviewZoom(100);
      setIsAreaSelectMode(false);
      setPageRotations({});
      pageRotationsRef.current = {};
      setStatus({ type: "loaded", pages: loadedDoc.numPages });
      return true;
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfLoad" });
      setErrorText(`${tr("PDF 로딩 실패", "PDF loading failed")}: ${formatError(error)}`);
      return false;
    } finally {
      setIsLoadingPdf(false);
    }
  }, [replacePdfDocument, resetPdfWorkspace, tr]);

  const handleOpenPdf = useCallback(async () => {
    setErrorText(null);
    const selected = await open({
      multiple: false,
      directory: false,
      title: tr("PDF 파일 선택", "Select PDF file"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    await loadPdfFromPath(selected);
  }, [loadPdfFromPath, tr]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const initialPath = searchParams.get("open");
    if (initialPath) {
      void loadPdfFromPath(initialPath);
    }
    void (async () => {
      try {
        const pendingPath = await invoke<string | null>("take_next_pending_pdf_path");
        if (pendingPath) {
          await loadPdfFromPath(pendingPath);
        }
      } catch {
        // Ignore if command is temporarily unavailable.
      }
    })();
    let unlisten: (() => void) | null = null;
    void listen<string>("pdf-open-request", (event) => {
      void loadPdfFromPath(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [loadPdfFromPath]);

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

  useEffect(() => {
    if (mergeDraggingIndex === null) return;
    const move = (event: MouseEvent) => {
      const listElement = mergeListRef.current;
      if (!listElement) return;
      const rect = listElement.getBoundingClientRect();
      const relativeY = event.clientY - rect.top + listElement.scrollTop;
      // 첫 번째 merge-item의 실제 높이를 가져와서 사용
      const firstItem = listElement.querySelector('.merge-item') as HTMLElement;
      const itemHeight = firstItem ? firstItem.offsetHeight : 32; // 기본값 32px
      const rawIndex = Math.floor(relativeY / itemHeight);
      const targetIndex = clamp(rawIndex, 0, Math.max(0, mergePdfPaths.length - 1));
      if (targetIndex === mergeDraggingIndex) return;
      moveMergePdfPathByIndex(mergeDraggingIndex, targetIndex);
      setMergeDraggingIndex(targetIndex);
      setMergeDropPath(mergePdfPaths[targetIndex] ?? null);
    };
    const stop = () => {
      setMergeDropPath(null);
      setMergeDraggingPath(null);
      setMergeDraggingIndex(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [mergeDraggingIndex, mergePdfPaths, moveMergePdfPathByIndex]);

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
    await resetPdfWorkspace();
    setStatus({ type: "ready" });
  }, [resetPdfWorkspace]);

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
      if (!isPreviewFocused || !pdfDoc || isBusy) return;
      if (event.ctrlKey) {
        event.preventDefault();
        const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        setPreviewZoom((previous) => clamp(previous + delta, ZOOM_MIN, ZOOM_MAX));
        return;
      }
      if (pageCount === 0) return;
      event.preventDefault();
      wheelPageDeltaRef.current += event.deltaY;
      if (Math.abs(wheelPageDeltaRef.current) < 28) return;
      const now = Date.now();
      if (now - lastWheelPageNavAtRef.current < 140) return;
      const direction = wheelPageDeltaRef.current > 0 ? 1 : -1;
      wheelPageDeltaRef.current = 0;
      lastWheelPageNavAtRef.current = now;
      movePage(direction);
    },
    [isPreviewFocused, isBusy, movePage, pageCount, pdfDoc],
  );

  const toggleAreaSelectionMode = useCallback(() => {
    setIsAreaSelectMode((prev) => {
      const next = !prev;
      if (!next) {
        setIsAreaSelecting(false);
        setPreviewSelectionRect(null);
      }
      setSelectedPreviewText("");
      return next;
    });
  }, []);

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

  const waitForOutlineLoadToFinish = useCallback(async (timeoutMs = OUTLINE_SAVE_WAIT_TIMEOUT_MS): Promise<boolean> => {
    if (!isLoadingOutlineRef.current) return true;
    const startedAt = Date.now();
    while (isLoadingOutlineRef.current) {
      if (Date.now() - startedAt >= timeoutMs) return false;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, OUTLINE_SAVE_WAIT_POLL_MS);
      });
    }
    return true;
  }, []);

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
      const sourceToOutputPage = new Map<number, number>();
      for (const [targetIndex, sourcePageNumber] of selectedPageNumbers.entries()) {
        const extraRotation = pageRotationsRef.current[sourcePageNumber] ?? 0;
        await appendPageWithRotation(outputDocument, sourceDocument, sourcePageNumber - 1, extraRotation);
        sourceToOutputPage.set(sourcePageNumber, targetIndex + 1);
      }
      const mappedOutlineEntries = validOutlineEntries
        .filter((entry) => sourceToOutputPage.has(entry.pageNumber))
        .map((entry) => ({
          ...entry,
          id: createOutlineEntryId(),
          pageNumber: sourceToOutputPage.get(entry.pageNumber) ?? entry.pageNumber,
        }));
      if (mappedOutlineEntries.length > 0) {
        applyOutlineEntriesToPdfDocument(outputDocument, mappedOutlineEntries);
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
  }, [openExplorerAfterSave, pdfBytes, pdfPath, selectedPageNumbers, showToast, tr, validOutlineEntries]);

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
    if (saveType === "pdf") {
      let isOutlineReady = await waitForOutlineLoadToFinish();
      if (!isOutlineReady) {
        const timeoutSeconds = Math.round(OUTLINE_SAVE_WAIT_TIMEOUT_MS / 1000);
        const retry = await ask(
          tr(
            `목차 로딩이 ${timeoutSeconds}초 안에 완료되지 않았습니다. 다시 기다릴까요?`,
            `Outline loading did not complete within ${timeoutSeconds} seconds. Retry waiting?`,
          ),
          { title: tr("목차 로딩 지연", "Outline loading delay") },
        );
        if (!retry) {
          await message(
            tr("목차 로딩 미완료로 PDF 저장을 취소했습니다.", "Canceled PDF save because outline loading is not complete."),
            { title: tr("안내", "Notice") },
          );
          return;
        }
        isOutlineReady = await waitForOutlineLoadToFinish();
        if (!isOutlineReady) {
          await message(
            tr(
              "목차 로딩이 계속 지연되어 PDF 저장을 취소했습니다. 잠시 후 다시 시도해주세요.",
              "Outline loading is still delayed, so PDF save was canceled. Please try again shortly.",
            ),
            { title: tr("안내", "Notice") },
          );
          return;
        }
      }
      await handleSavePdf();
    } else {
      await handleSaveImages(saveType);
    }
  }, [pdfDoc, pdfBytes, selectedPageNumbers.length, saveType, handleSavePdf, handleSaveImages, tr, waitForOutlineLoadToFinish]);

  const openProjectRepo = useCallback(async () => {
    try {
      await openUrl(PROJECT_REPO_URL);
    } catch (error) {
      setErrorText(`${tr("링크 열기 실패", "Failed to open link")}: ${formatError(error)}`);
    }
  }, [tr]);

  const totalThumbHeight = pageOrder.length * THUMB_ITEM_HEIGHT;
  const normalizedPreviewSelectionRect = useMemo(
    () => (previewSelectionRect ? normalizeSelectionRect(previewSelectionRect) : null),
    [previewSelectionRect],
  );
  const addPdfLabel = useMemo(() => (addPdfPath ? normalizeFileStem(addPdfPath) : "-"), [addPdfPath]);
  const hasCurrentPdf = pdfDoc !== null;
  const handleMergeDragStart = useCallback((path: string, index: number) => {
    setMergeDraggingPath(path);
    setMergeDraggingIndex(index);
    setMergeDropPath(null);
  }, []);
  const applyMergeModal = useCallback(() => {
    void handleApplyMergePdfs();
  }, [handleApplyMergePdfs]);
  const applyAddModal = useCallback(() => {
    void handleApplyAddPdf();
  }, [handleApplyAddPdf]);

  return (
    <div className="app-shell">
      <section className="toolbar-grid">
        <div className="panel toolbar-head-row">
          <div className="toolbar-head-status">
            <div className="action-group head-file-actions">
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
            </div>
            <span>{statusText}</span>
            <span>{tr("선택", "Selected")} {selectedPageNumbers.length} / {tr("전체", "Total")} {pageCount}</span>
          </div>
          <div className="toolbar-head-actions">
            <button
              className="ghost-btn toolbar-toggle-btn"
              type="button"
              onClick={() => setIsToolbarCollapsed((prev) => !prev)}
              title={isToolbarCollapsed ? tr("툴바 펼치기", "Expand toolbar") : tr("툴바 접기", "Collapse toolbar")}
            >
              {isToolbarCollapsed ? tr("툴바 열기", "Show Toolbar") : tr("툴바 접기", "Hide Toolbar")}
            </button>
            <label className="locale-control">
              <span>{tr("언어", "Language")}</span>
              <select value={locale} onChange={(event) => setLocale(event.currentTarget.value as Locale)}>
                <option value="ko">{tr("한국어", "Korean")}</option>
                <option value="en">{tr("영어", "English")}</option>
              </select>
            </label>
            <div
              className={`help-wrap ${showHelpInfo ? "open" : ""}`}
              onMouseEnter={() => setShowHelpInfo(true)}
              onMouseLeave={() => setShowHelpInfo(false)}
            >
              <button
                className="help-btn"
                type="button"
                onClick={() => setShowHelpInfo((prev) => !prev)}
                aria-label={tr("프로젝트 정보", "Project info")}
                title={tr("프로젝트 정보", "Project info")}
              >
                ?
              </button>
              <div className="help-popover">
                <strong>{tr("프로젝트 정보", "Project Info")}</strong>
                <p>{tr("로컬 고성능 PDF 선택/병합/회전/저장 도구", "Local high-performance PDF split/merge/rotate/save tool")}</p>
                <p>{tr("버전", "Version")}: v{APP_VERSION}</p>
                <p className="help-link-row">
                  <span>Git:</span>
                  <button type="button" className="help-link-btn" onClick={() => void openProjectRepo()}>
                    {PROJECT_REPO_URL}
                  </button>
                </p>
              </div>
            </div>
          </div>
        </div>

        {!isToolbarCollapsed ? (
        <div className="panel toolbar-row">
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
          <div className="toolbar-line-break" aria-hidden="true" />

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

        </div>
        ) : null}
      </section>

      {errorText ? <section className="panel error-banner">{errorText}</section> : null}
      {toastText ? <section className="toast-banner">{toastText}</section> : null}

      <main className="workspace">
        <aside className="panel sidebar">
          <div className="sidebar-head">
            <strong>{pdfPath ? normalizeFileStem(pdfPath) : tr("불러온 PDF 없음", "No PDF loaded")}</strong>
            <div className="sidebar-tab-row">
              <button
                className={`ghost-btn micro-btn ${sidebarTab === "thumbnails" ? "tab-active" : ""}`}
                onClick={() => setSidebarTab("thumbnails")}
                type="button"
              >
                {tr("썸네일", "Thumbnails")}
              </button>
              <button
                className={`ghost-btn micro-btn ${sidebarTab === "outline" ? "tab-active" : ""}`}
                onClick={() => {
                  setSidebarTab("outline");
                  setOutlinePanelMode("view");
                }}
                type="button"
              >
                {tr("목차", "Outline")}
              </button>
            </div>
            <div className="sidebar-info-row">
              {sidebarTab === "thumbnails" ? (
                <>
                  <span className="sidebar-info-text">
                    {tr("썸네일", "Thumbnails")} {loadedThumbCount}/{pageCount} ({tr("대기/처리", "queued/working")} {thumbQueueCount})
                  </span>
                  <div className="sidebar-buttons">
                    <button
                      className="ghost-btn micro-btn"
                      onClick={() => setSelectedPages(new Set(pageNumbers))}
                      disabled={!pdfDoc || isBusy || pageCount === 0}
                      title={tr("전체 선택", "Select all")}
                    >
                      {tr("전체", "All")}
                    </button>
                    <button
                      className="ghost-btn micro-btn"
                      onClick={() => setSelectedPages(new Set())}
                      disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}
                      title={tr("선택 취소", "Clear selection")}
                    >
                      {tr("취소", "Clear")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="sidebar-info-text">{tr("목차 항목", "Outline entries")} {outlineEntries.length}</span>
                  <div className="sidebar-buttons">
                    <button
                      className="ghost-btn micro-btn"
                      onClick={() => setOutlinePanelMode(outlinePanelMode === "view" ? "edit" : "view")}
                      disabled={!pdfDoc || isBusy || isLoadingOutline}
                      type="button"
                      title={outlinePanelMode === "view" ? tr("수정/추가 모드", "Switch to edit/add mode") : tr("기본 보기 모드", "Switch to viewer mode")}
                    >
                      {outlinePanelMode === "view" ? tr("수정/추가", "Edit/Add") : tr("기본보기", "Viewer")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          {sidebarTab === "thumbnails" ? (
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
                            disabled={isBusy}
                            title={selectedPages.has(pageNumber) ? tr("선택 해제", "Remove from selection") : tr("선택되지 않음", "Not selected")}
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
          ) : (
            <div
              className="outline-viewport"
              tabIndex={0}
              onMouseDown={(event) => event.currentTarget.focus()}
              onKeyDown={handleArrowPageNavigation}
            >
              {pageCount === 0 ? <div className="empty-panel">{tr("PDF를 열면 목차 편집이 가능합니다.", "Open a PDF to edit outlines.")}</div> : null}
              {pageCount > 0 && isLoadingOutline ? <div className="empty-panel">{tr("목차를 불러오는 중...", "Loading outlines...")}</div> : null}
              {pageCount > 0 && !isLoadingOutline && outlineEntries.length === 0 ? (
                <div className="empty-panel">
                  {outlinePanelMode === "edit"
                    ? tr("목차가 없습니다. 아래 버튼으로 생성하세요.", "No outlines yet. Use buttons below to generate.")
                    : tr("목차가 없습니다. 수정/추가 모드에서 생성할 수 있습니다.", "No outlines. Create them in edit/add mode.")}
                </div>
              ) : null}
              {pageCount > 0 && !isLoadingOutline && outlineEntries.length > 0 && outlinePanelMode === "view" ? (
                <div className="outline-view-list">
                  {outlineEntries.map((entry) => (
                    <button
                      key={entry.id}
                      className={`outline-view-item ${activePage === entry.pageNumber ? "active" : ""}`}
                      type="button"
                      onClick={() => jumpToOutlinePage(entry.pageNumber)}
                      style={{ paddingLeft: `${10 + normalizeOutlineDepth(entry.depth) * 16}px` }}
                      title={`${entry.title} (${entry.pageNumber}p)`}
                    >
                      <span className="outline-view-title">{entry.title}</span>
                      <span className="outline-view-page">{entry.pageNumber}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {pageCount > 0 && !isLoadingOutline && outlinePanelMode === "edit" ? (
                <>
                  <div className="outline-toolbar">
                    <button
                      className="ghost-btn micro-btn"
                      onClick={() => void reloadOutlineFromPdf()}
                      disabled={!pdfDoc || isBusy || isLoadingOutline}
                      type="button"
                      title={tr("PDF 원본 목차를 다시 불러옵니다.", "Reload outline items from the PDF file.")}
                    >
                      {tr("PDF목차", "Load PDF Outline")}
                    </button>
                    <button
                      className="ghost-btn micro-btn"
                      onClick={() => void appendOutlineFromBodyText()}
                      disabled={!pdfDoc || isBusy || isGeneratingOutline}
                      type="button"
                      title={tr("본문 텍스트를 분석해 목차 후보를 추가합니다.", "Analyze page text and append outline candidates.")}
                    >
                      {isGeneratingOutline ? tr("분석중", "Analyzing...") : tr("본문추가", "Add from Text")}
                    </button>
                    <button
                      className="ghost-btn micro-btn"
                      onClick={addManualOutlineAtActivePage}
                      disabled={!pdfDoc || isBusy}
                      type="button"
                      title={tr("현재 페이지로 새 목차 항목을 추가합니다.", "Add a new outline entry for the current page.")}
                    >
                      {tr("현재추가", "Add Current")}
                    </button>
                    <button
                      className="ghost-btn micro-btn"
                      onClick={clearOutlineEntries}
                      disabled={!pdfDoc || isBusy || outlineEntries.length === 0}
                      type="button"
                      title={tr("현재 목차 항목을 모두 삭제합니다.", "Remove all current outline entries.")}
                    >
                      {tr("전체비움", "Clear All")}
                    </button>
                  </div>
                  {outlineEntries.length > 0 ? (
                    <div className="outline-list" ref={outlineListRef}>
                      {outlineEntries.map((entry, index) => (
                        <article
                          key={entry.id}
                          data-outline-id={entry.id}
                          className={`outline-item ${activePage === entry.pageNumber ? "active" : ""} ${draggingOutlineId === entry.id ? "dragging" : ""} ${outlineDropTargetId === entry.id ? "drop-target" : ""}`}
                        >
                          <div className="outline-item-top">
                            <span
                              className="outline-drag-handle"
                              title={tr("여기를 잡고 드래그하여 목차 순서 이동", "Drag here to reorder outline items")}
                              aria-label={tr("목차 드래그 핸들", "Outline drag handle")}
                              onMouseDown={(event) => {
                                if (isBusy) return;
                                event.preventDefault();
                                event.stopPropagation();
                                setIsOutlinePointerReordering(true);
                                setDraggingOutlineId(entry.id);
                                setDraggingOutlineIndex(index);
                                setOutlineDropTargetId(entry.id);
                              }}
                            >
                              |||
                            </span>
                            <button
                              className="ghost-btn micro-btn"
                              type="button"
                              onClick={() => jumpToOutlinePage(entry.pageNumber)}
                              title={tr(`이 목차 페이지(${entry.pageNumber}p)로 이동`, `Jump to this outline page (${entry.pageNumber}p)`)}
                            >
                              {entry.pageNumber}p
                            </button>
                            <span
                              className={`outline-source ${entry.source}`}
                              title={
                                entry.source === "pdf"
                                  ? tr("PDF 원본 목차에서 불러온 항목", "Imported from PDF outline")
                                  : entry.source === "text"
                                    ? tr("본문 텍스트 기반으로 생성된 항목", "Generated from body text")
                                    : tr("수동으로 추가한 항목", "Added manually")
                              }
                            >
                              {entry.source === "pdf" ? "PDF" : entry.source === "text" ? tr("본문", "Text") : tr("수동", "Manual")}
                            </span>
                            <button
                              className="ghost-btn micro-btn"
                              type="button"
                              onClick={() => moveOutlineEntry(entry.id, -1)}
                              disabled={index === 0}
                              title={tr("목차 순서를 한 칸 위로 이동", "Move this outline item one step up")}
                            >
                              ↑
                            </button>
                            <button
                              className="ghost-btn micro-btn"
                              type="button"
                              onClick={() => moveOutlineEntry(entry.id, 1)}
                              disabled={index === outlineEntries.length - 1}
                              title={tr("목차 순서를 한 칸 아래로 이동", "Move this outline item one step down")}
                            >
                              ↓
                            </button>
                          </div>
                          <div className="outline-edit-row">
                            <input
                              className="outline-title-input"
                              value={entry.title}
                              onChange={(event) => updateOutlineTitle(entry.id, event.currentTarget.value)}
                              placeholder={tr("목차 제목", "Outline title")}
                              title={tr("목차에 표시할 제목 문구를 입력", "Edit the visible outline title text")}
                            />
                          </div>
                          <div className="outline-meta-row">
                            <input
                              className="outline-page-input"
                              value={entry.pageNumber}
                              onChange={(event) => updateOutlinePageNumber(entry.id, event.currentTarget.value)}
                              inputMode="numeric"
                              title={tr("이 목차가 가리킬 페이지 번호", "Page number this outline item points to")}
                            />
                            <select
                              className="outline-depth-select"
                              value={entry.depth}
                              onChange={(event) => updateOutlineDepth(entry.id, Number.parseInt(event.currentTarget.value, 10))}
                              title={tr("목차 들여쓰기(레벨) 설정", "Set nesting/indent level")}
                            >
                              {Array.from({ length: OUTLINE_MAX_DEPTH + 1 }, (_, depth) => (
                                <option key={depth} value={depth}>
                                  L{depth}
                                </option>
                              ))}
                            </select>
                            <button
                              className="ghost-btn micro-btn"
                              type="button"
                              onClick={() => jumpToOutlinePage(entry.pageNumber)}
                              title={tr("설정된 페이지로 즉시 이동", "Go to the configured page")}
                            >
                              {tr("이동", "Go")}
                            </button>
                            <button
                              className="ghost-btn micro-btn"
                              type="button"
                              onClick={() => removeOutlineEntry(entry.id)}
                              title={tr("이 목차 항목 삭제", "Delete this outline item")}
                            >
                              {tr("삭제", "Del")}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          )}
        </aside>

        <section className="panel preview-panel" ref={previewHostRef}>
          {pdfDoc ? (
            <>
              <div
                className={`preview-canvas-wrap ${isPreviewFocused ? "focused" : ""}`}
                ref={previewInteractionRef}
                tabIndex={0}
                onFocus={() => setIsPreviewFocused(true)}
                onBlur={() => setIsPreviewFocused(false)}
                onMouseDown={(event) => event.currentTarget.focus()}
                onWheel={handlePreviewWheel}
                onKeyDown={handleArrowPageNavigation}
              >
                <div className="preview-tools">
                  <button
                    className="ghost-btn micro-btn"
                    onClick={addManualOutlineAtActivePage}
                    type="button"
                    disabled={isBusy}
                    title={tr("현재 페이지로 새 목차 항목을 추가합니다.", "Add a new outline entry for the current page.")}
                  >
                    {tr("현재추가", "Add Current")}
                  </button>
                  <button
                    className={`ghost-btn micro-btn ${isAreaSelectMode ? "tab-active" : ""}`}
                    onClick={toggleAreaSelectionMode}
                    type="button"
                    disabled={isBusy}
                    title={tr("영역 드래그로 텍스트 추출", "Drag area to extract text")}
                  >
                    {isAreaSelectMode ? tr("영역선택ON", "Area ON") : tr("영역선택", "Area Select")}
                  </button>
                  <button
                    className="ghost-btn micro-btn"
                    onClick={() => void addSelectedPreviewTextToOutline()}
                    type="button"
                    disabled={isBusy || normalizeOutlineTitle(selectedPreviewText).length === 0}
                    title={tr("선택 텍스트를 목차에 추가", "Add selected text to outline")}
                  >
                    {tr("선택→목차", "Sel->Outline")}
                  </button>
                  <span className="preview-selected-text" title={selectedPreviewText}>
                    {normalizeOutlineTitle(selectedPreviewText).length > 0
                      ? normalizeOutlineTitle(selectedPreviewText)
                      : tr("본문에서 텍스트 선택 또는 영역 드래그", "Select text or drag area in page body")}
                  </span>
                </div>
                <div
                  className="preview-page-stack"
                  style={{
                    width: `${previewPageSize.width}px`,
                    height: `${previewPageSize.height}px`,
                  }}
                >
                  <canvas ref={previewCanvasRef} />
                  <div
                    className={`preview-text-layer ${isAreaSelectMode ? "area-mode" : ""}`}
                    ref={previewTextLayerRef}
                    onMouseDown={handlePreviewTextLayerMouseDown}
                  >
                    {previewTextSpans.map((span) => (
                      <span
                        key={span.id}
                        className="preview-text-span"
                        data-text={span.text}
                        style={{
                          left: `${span.left}px`,
                          top: `${span.top}px`,
                          width: `${span.width}px`,
                          height: `${span.height}px`,
                          fontSize: `${span.fontSize}px`,
                          transform: `rotate(${span.angleDeg}deg)`,
                        }}
                      >
                        {span.text}
                      </span>
                    ))}
                    {normalizedPreviewSelectionRect ? (
                      <div
                        className="preview-selection-rect"
                        style={{
                          left: `${normalizedPreviewSelectionRect.left}px`,
                          top: `${normalizedPreviewSelectionRect.top}px`,
                          width: `${Math.max(0, normalizedPreviewSelectionRect.right - normalizedPreviewSelectionRect.left)}px`,
                          height: `${Math.max(0, normalizedPreviewSelectionRect.bottom - normalizedPreviewSelectionRect.top)}px`,
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-panel">{tr("선택한 페이지가 오른쪽에 크게 표시됩니다.", "Large page preview appears here.")}</div>
          )}
        </section>
      </main>

      <MergePdfModal
        isOpen={showMergePdfModal}
        tr={tr}
        mergeInsertPosition={mergeInsertPosition}
        setMergeInsertPosition={setMergeInsertPosition}
        isAddingPdf={isAddingPdf}
        hasCurrentPdf={hasCurrentPdf}
        mergePdfPaths={mergePdfPaths}
        mergeDraggingPath={mergeDraggingPath}
        mergeDropPath={mergeDropPath}
        mergeListRef={mergeListRef}
        normalizeFileStem={normalizeFileStem}
        onStartDrag={handleMergeDragStart}
        onClose={closeMergePdfModal}
        onApply={applyMergeModal}
      />

      <AddPdfModal
        isOpen={showAddPdfModal}
        tr={tr}
        addPdfLabel={addPdfLabel}
        addPdfPageCount={addPdfPageCount}
        addInsertPosition={addInsertPosition}
        setAddInsertPosition={setAddInsertPosition}
        addRangeInput={addRangeInput}
        setAddRangeInput={setAddRangeInput}
        isAddingPdf={isAddingPdf}
        onClose={closeAddPdfModal}
        onApply={applyAddModal}
      />
    </div>
  );
}

export default App;
