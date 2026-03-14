import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { PDFDocument, rgb } from "pdf-lib";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Suspense, lazy, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddPdfModal from "./components/AddPdfModal";
import MergePdfModal from "./components/MergePdfModal";
import PdfInfoModal, { type PdfInfoField } from "./components/PdfInfoModal";
import PdfSecurityModal from "./components/PdfSecurityModal";
import {
  buildPreviewCacheKey,
  imageMimeTypeFromPath,
  isEditableTarget,
  isImageFilePath,
  isPdfFilePath,
  isPdfJsDocumentTeardownError,
  measureImage,
  normalizePdfRect,
  normalizeSearchQuery,
  PAGE_LOAD_BATCH_DELAY_MS,
  PAGE_LOAD_BATCH_SIZE,
  PdfPageOverlay,
  PdfRect,
  PdfSecurityMode,
  PreviewTextLayer,
  readStoredZoom,
  rectHasArea,
  SHORTCUT_LABELS,
  ToolbarIcon,
  withShortcutHint,
} from "./app/app-view-helpers";
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
  buildSearchableTextSpans,
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
import { isTauriRuntime, loadAppSettings, saveAppSettings } from "./app/settings-store";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerSrc;

const AiChatPanel = lazy(() => import("./components/AiChatPanel"));

type InspectPdfSecurityResponse = {
  isEncrypted: boolean;
};

type PersistedAppSettings = {
  "app.locale": Locale;
  "app.toolbarCollapsed": boolean;
  "app.previewZoom": number;
  "app.previewZoomMode": "fit" | "manual";
  "app.previewSpreadMode": boolean;
  "app.openExplorerAfterSave": boolean;
  "app.openPdfInNewWindow": boolean;
  "app.showShortcuts": boolean;
  "ai.panelOpen": boolean;
};

function buildPersistedAppSettings(input: PersistedAppSettings): PersistedAppSettings {
  return input;
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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("thumbnails");
  const [outlinePanelMode, setOutlinePanelMode] = useState<OutlinePanelMode>("view");
  const [outlineEntries, setOutlineEntries] = useState<OutlineEntry[]>([]);
  const [hasLoadedOutlineOnce, setHasLoadedOutlineOnce] = useState(false);
  const [isLoadingOutline, setIsLoadingOutline] = useState(false);
  const [isGeneratingOutline, setIsGeneratingOutline] = useState(false);
  const [saveType, setSaveType] = useState<SaveType>("pdf");
  const [openExplorerAfterSave, setOpenExplorerAfterSave] = useState(true);
  const [openPdfInNewWindow, setOpenPdfInNewWindow] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
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
  const [showPdfInfoModal, setShowPdfInfoModal] = useState(false);
  const [pdfInfoTab, setPdfInfoTab] = useState<"metadata" | "fonts">("metadata");
  const [isLoadingPdfInfo, setIsLoadingPdfInfo] = useState(false);
  const [pdfInfoMetadataFields, setPdfInfoMetadataFields] = useState<PdfInfoField[]>([]);
  const [pdfInfoFontNames, setPdfInfoFontNames] = useState<string[]>([]);
  const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [hasHydratedStoredSettings, setHasHydratedStoredSettings] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>({});
  const [thumbQueueCount, setThumbQueueCount] = useState(0);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const [thumbViewportHeight, setThumbViewportHeight] = useState(0);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [previewPageSize, setPreviewPageSize] = useState({ width: 0, height: 0 });
  const [previewSecondaryPageSize, setPreviewSecondaryPageSize] = useState({ width: 0, height: 0 });
  const [previewTextSpans, setPreviewTextSpans] = useState<PreviewTextSpan[]>([]);
  const [selectedPreviewText, setSelectedPreviewText] = useState("");
  const [isAreaSelectMode, setIsAreaSelectMode] = useState(false);
  const [isAreaSelecting, setIsAreaSelecting] = useState(false);
  const [previewSelectionRect, setPreviewSelectionRect] = useState<PreviewSelectionRect | null>(null);
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ pageNumber: number; spanIndex: number; text: string }>>([]);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const [isSearchingDocument, setIsSearchingDocument] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(readStoredZoom);
  const [previewZoomMode, setPreviewZoomMode] = useState<"fit" | "manual">("fit");
  const [previewSpreadMode, setPreviewSpreadMode] = useState(false);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [isPreviewFocused, setIsPreviewFocused] = useState(false);
  const [isInitialPreviewReady, setIsInitialPreviewReady] = useState(false);
  const [pendingHydrationPageCount, setPendingHydrationPageCount] = useState(0);
  const [draggingPage, setDraggingPage] = useState<number | null>(null);
  const [dropTargetPage, setDropTargetPage] = useState<number | null>(null);
  const [draggingPageIndex, setDraggingPageIndex] = useState<number | null>(null);
  const [isPointerReordering, setIsPointerReordering] = useState(false);
  const [isOutlinePointerReordering, setIsOutlinePointerReordering] = useState(false);
  const [draggingOutlineId, setDraggingOutlineId] = useState<string | null>(null);
  const [draggingOutlineIndex, setDraggingOutlineIndex] = useState<number | null>(null);
  const [outlineDropTargetId, setOutlineDropTargetId] = useState<string | null>(null);
  const [pageOverlays, setPageOverlays] = useState<PdfPageOverlay[]>([]);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const [isCurrentPdfEncrypted, setIsCurrentPdfEncrypted] = useState(false);
  const [securityModalMode, setSecurityModalMode] = useState<PdfSecurityMode | null>(null);
  const [securityPassword, setSecurityPassword] = useState("");
  const [securityConfirmPassword, setSecurityConfirmPassword] = useState("");
  const [securityModalError, setSecurityModalError] = useState<string | null>(null);
  const [pendingProtectedPdfPath, setPendingProtectedPdfPath] = useState<string | null>(null);

  const previewHostRef = useRef<HTMLDivElement | null>(null);
  const previewInteractionRef = useRef<HTMLDivElement | null>(null);
  const previewPrimarySlotRef = useRef<HTMLDivElement | null>(null);
  const previewSecondarySlotRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasSecondaryRef = useRef<HTMLCanvasElement | null>(null);
  const previewTextLayerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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
  const selectedPagesRef = useRef<Set<number>>(new Set());
  const progressivePageLoadTokenRef = useRef(0);
  const progressivePageLoadTimerRef = useRef<number | null>(null);
  const previewRenderCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pageTextSearchCacheRef = useRef<Map<number, string[]>>(new Map());
  const searchTokenRef = useRef(0);
  const pendingAiCitationJumpRef = useRef<{ pageNumber: number; query: string } | null>(null);
  const pageOverlaysRef = useRef<PdfPageOverlay[]>([]);
  const primaryPreviewViewportRef = useRef<ReturnType<PDFPageProxy["getViewport"]> | null>(null);
  const secondaryPreviewViewportRef = useRef<ReturnType<PDFPageProxy["getViewport"]> | null>(null);
  const secondaryPreviewPageNumberRef = useRef<number | null>(null);
  const previewRenderGenerationRef = useRef(0);
  const hasPrefetchedPdfInfoRef = useRef(false);
  const persistedSettingsRef = useRef<PersistedAppSettings | null>(null);

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
  const normalizedSearchQuery = useMemo(() => normalizeSearchQuery(debouncedSearchQuery), [debouncedSearchQuery]);
  const currentPageSearchResults = useMemo(
    () => searchResults.filter((result) => result.pageNumber === activePage),
    [activePage, searchResults],
  );
  const currentPageMatchedSpanIndexes = useMemo(
    () => new Set(currentPageSearchResults.map((result) => result.spanIndex)),
    [currentPageSearchResults],
  );
  const activeSearchResult = useMemo(
    () => (searchResults.length > 0 ? searchResults[clamp(activeSearchResultIndex, 0, searchResults.length - 1)] : null),
    [activeSearchResultIndex, searchResults],
  );
  const secondaryPreviewPageNumber = useMemo(
    () => (previewSpreadMode && activePage < pageCount ? activePage + 1 : null),
    [activePage, pageCount, previewSpreadMode],
  );
  const activePageOverlays = useMemo(
    () => pageOverlays.filter((overlay) => overlay.pageNumber === activePage),
    [activePage, pageOverlays],
  );
  const secondaryPageOverlays = useMemo(
    () => (secondaryPreviewPageNumber ? pageOverlays.filter((overlay) => overlay.pageNumber === secondaryPreviewPageNumber) : []),
    [pageOverlays, secondaryPreviewPageNumber],
  );
  const activeSearchSpanIndex = useMemo(
    () => (activeSearchResult?.pageNumber === activePage ? activeSearchResult.spanIndex : null),
    [activePage, activeSearchResult],
  );
  const statusText = useMemo(() => {
    if (status.type === "ready") return tr("", "");
    if (status.type === "loadingPdf") {
      if (status.phase === "reading") return tr("PDF 파일 읽는 중...", "Reading PDF file...");
      if (status.phase === "opening") return tr("PDF 문서 여는 중...", "Opening PDF document...");
      if (status.phase === "firstPage") return tr("첫 페이지 표시 준비 중...", "Preparing first page...");
      return tr("PDF 로딩 중...", "Loading PDF...");
    }
    if (status.type === "loaded") return tr(`총 ${status.pages}페이지 로딩 완료`, `Loaded ${status.pages} pages`);
    if (status.type === "savingPdf") return tr("선택 페이지를 PDF로 저장 중...", "Saving selected pages to PDF...");
    if (status.type === "savedPdf") return tr(`PDF 저장 완료 (${status.pages}페이지)`, `PDF saved (${status.pages} pages)`);
    if (status.type === "savingImages") return tr(`이미지 저장 중... (${status.done}/${status.total})`, `Saving images... (${status.done}/${status.total})`);
    if (status.type === "savedImages") return tr(`이미지 저장 완료 (${status.total}개 파일)`, `Images saved (${status.total} files)`);
    if (status.reason === "pdfLoad") return tr("PDF 로딩 실패", "PDF loading failed");
    if (status.reason === "pdfSave") return tr("PDF 저장 실패", "PDF save failed");
    return tr("이미지 저장 실패", "Image save failed");
  }, [status, tr]);

  const currentPersistedSettings = useMemo(() => buildPersistedAppSettings({
    "app.locale": locale,
    "app.toolbarCollapsed": isToolbarCollapsed,
    "app.previewZoom": previewZoom,
    "app.previewZoomMode": previewZoomMode,
    "app.previewSpreadMode": previewSpreadMode,
    "app.openExplorerAfterSave": openExplorerAfterSave,
    "app.openPdfInNewWindow": openPdfInNewWindow,
    "app.showShortcuts": showShortcuts,
    "ai.panelOpen": showAiPanel,
  }), [
    isToolbarCollapsed,
    locale,
    openExplorerAfterSave,
    openPdfInNewWindow,
    previewSpreadMode,
    previewZoom,
    previewZoomMode,
    showAiPanel,
    showShortcuts,
  ]);

  useEffect(() => {
    let cancelled = false;
    void loadAppSettings()
      .then((bundle) => {
        if (cancelled) return;
        const settings = bundle.settings;
        const storedLocale = settings["app.locale"];
        const storedToolbarCollapsed = settings["app.toolbarCollapsed"];
        const storedPreviewZoom = settings["app.previewZoom"];
        const storedPreviewZoomMode = settings["app.previewZoomMode"];
        const storedPreviewSpreadMode = settings["app.previewSpreadMode"];
        const storedOpenExplorerAfterSave = settings["app.openExplorerAfterSave"];
        const storedOpenPdfInNewWindow = settings["app.openPdfInNewWindow"];
        const storedShowShortcuts = settings["app.showShortcuts"];
        const storedAiPanelOpen = settings["ai.panelOpen"];

        if (storedLocale === "ko" || storedLocale === "en") setLocale(storedLocale);
        if (typeof storedToolbarCollapsed === "boolean") setIsToolbarCollapsed(storedToolbarCollapsed);
        if (typeof storedPreviewZoom === "number") {
          setPreviewZoom(clamp(Math.round(storedPreviewZoom), ZOOM_MIN, ZOOM_MAX));
        }
        if (storedPreviewZoomMode === "fit" || storedPreviewZoomMode === "manual") {
          setPreviewZoomMode(storedPreviewZoomMode);
        }
        if (typeof storedPreviewSpreadMode === "boolean") setPreviewSpreadMode(storedPreviewSpreadMode);
        if (typeof storedOpenExplorerAfterSave === "boolean") setOpenExplorerAfterSave(storedOpenExplorerAfterSave);
        if (typeof storedOpenPdfInNewWindow === "boolean") setOpenPdfInNewWindow(storedOpenPdfInNewWindow);
        if (typeof storedShowShortcuts === "boolean") setShowShortcuts(storedShowShortcuts);
        if (typeof storedAiPanelOpen === "boolean") setShowAiPanel(storedAiPanelOpen);
        persistedSettingsRef.current = buildPersistedAppSettings({
          "app.locale": storedLocale === "ko" || storedLocale === "en" ? storedLocale : locale,
          "app.toolbarCollapsed": typeof storedToolbarCollapsed === "boolean" ? storedToolbarCollapsed : false,
          "app.previewZoom": typeof storedPreviewZoom === "number" ? clamp(Math.round(storedPreviewZoom), ZOOM_MIN, ZOOM_MAX) : 100,
          "app.previewZoomMode": storedPreviewZoomMode === "fit" || storedPreviewZoomMode === "manual" ? storedPreviewZoomMode : "fit",
          "app.previewSpreadMode": typeof storedPreviewSpreadMode === "boolean" ? storedPreviewSpreadMode : false,
          "app.openExplorerAfterSave": typeof storedOpenExplorerAfterSave === "boolean" ? storedOpenExplorerAfterSave : true,
          "app.openPdfInNewWindow": typeof storedOpenPdfInNewWindow === "boolean" ? storedOpenPdfInNewWindow : true,
          "app.showShortcuts": typeof storedShowShortcuts === "boolean" ? storedShowShortcuts : false,
          "ai.panelOpen": typeof storedAiPanelOpen === "boolean" ? storedAiPanelOpen : false,
        });
        setHasHydratedStoredSettings(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorText(`${tr("앱 설정 로딩 실패", "Failed to load app settings")}: ${formatError(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [tr]);

  useEffect(() => {
    if (!hasHydratedStoredSettings) return;
    const previous = persistedSettingsRef.current;
    const changedEntries = Object.entries(currentPersistedSettings).filter(([key, value]) => previous?.[key as keyof PersistedAppSettings] !== value);
    if (changedEntries.length === 0) return;

    const changedSettings = Object.fromEntries(changedEntries) as Record<string, string | number | boolean>;
    void saveAppSettings(changedSettings).then(() => {
      persistedSettingsRef.current = {
        ...(persistedSettingsRef.current ?? currentPersistedSettings),
        ...currentPersistedSettings,
      };
    }).catch((error) => {
      setErrorText(`${tr("앱 설정 저장 실패", "Failed to save app settings")}: ${formatError(error)}`);
    });
  }, [
    currentPersistedSettings,
    hasHydratedStoredSettings,
    tr,
  ]);

  useEffect(() => {
    if (!showSearchBar) return;
    const frameId = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [showSearchBar]);

  useEffect(() => {
    if (!showSearchBar) {
      setDebouncedSearchQuery("");
      return;
    }
    const committedQuery = searchQuery;
    const timerId = window.setTimeout(() => {
      setDebouncedSearchQuery(committedQuery);
    }, 1000);
    return () => window.clearTimeout(timerId);
  }, [searchQuery, showSearchBar]);

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

  useEffect(() => {
    selectedPagesRef.current = selectedPages;
  }, [selectedPages]);

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

  const focusPreviewArea = useCallback(() => {
    window.requestAnimationFrame(() => {
      previewInteractionRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    pageOverlaysRef.current = pageOverlays;
  }, [pageOverlays]);

  useEffect(() => {
    // Tauri 환경에서만 창 표시
    if (isTauriRuntime()) {
      void getCurrentWindow().show().catch(() => {
        // Ignore if the window is already visible.
      });
    }
  }, []);

  const revokeOverlayUrls = useCallback((overlays: PdfPageOverlay[]) => {
    overlays.forEach((overlay) => {
      if (overlay.kind === "image") URL.revokeObjectURL(overlay.previewUrl);
    });
  }, []);

  const inspectCurrentPdfSecurity = useCallback(async (bytes: Uint8Array) => {
    try {
      const result = await invoke<InspectPdfSecurityResponse>("inspect_pdf_security", {
        request: {
          pdfBytes: Array.from(bytes),
        },
      });
      setIsCurrentPdfEncrypted(result.isEncrypted);
    } catch {
      setIsCurrentPdfEncrypted(false);
    }
  }, []);

  const closePdfSecurityModal = useCallback(() => {
    if (isSaving) return;
    setSecurityModalMode(null);
    setSecurityPassword("");
    setSecurityConfirmPassword("");
    setSecurityModalError(null);
    setPendingProtectedPdfPath(null);
  }, [isSaving]);

  const openProtectPdfModal = useCallback(() => {
    setSecurityModalError(null);
    setSecurityPassword("");
    setSecurityConfirmPassword("");
    setSecurityModalMode("protect");
  }, []);

  const openUnprotectPdfModal = useCallback(() => {
    setSecurityModalError(null);
    setSecurityPassword("");
    setSecurityConfirmPassword("");
    setSecurityModalMode("unprotect");
  }, []);

  const isPdfPasswordRequiredError = useCallback((error: unknown) => {
    if (!(error instanceof Error)) return false;
    const messageText = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();
    return (
      errorName.includes("passwordexception")
      || messageText.includes("no password given")
      || messageText.includes("password required")
      || messageText.includes("incorrect password")
    );
  }, []);

  const toCssPointFromDragDropPosition = useCallback((position: { x: number; y: number }) => {
    const dpr = window.devicePixelRatio || 1;
    return {
      x: position.x / dpr,
      y: position.y / dpr,
    };
  }, []);

  const convertViewportRectToPdfRect = useCallback((
    viewport: ReturnType<PDFPageProxy["getViewport"]> | null,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): PdfRect | null => {
    if (!viewport) return null;
    const [x1, y1] = viewport.convertToPdfPoint(left, top);
    const [x2, y2] = viewport.convertToPdfPoint(right, bottom);
    return normalizePdfRect({ x1, y1, x2, y2 });
  }, []);

  const convertPdfRectToViewportRect = useCallback((
    viewport: ReturnType<PDFPageProxy["getViewport"]> | null,
    rect: PdfRect,
  ) => {
    if (!viewport) return null;
    const [left1, top1] = viewport.convertToViewportPoint(rect.x1, rect.y1);
    const [left2, top2] = viewport.convertToViewportPoint(rect.x2, rect.y2);
    const left = Math.min(left1, left2);
    const right = Math.max(left1, left2);
    const top = Math.min(top1, top2);
    const bottom = Math.max(top1, top2);
    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
  }, []);

  const getPreviewOverlayStyle = useCallback((
    overlay: PdfPageOverlay,
    viewport: ReturnType<PDFPageProxy["getViewport"]> | null,
  ) => {
    const rect = convertPdfRectToViewportRect(viewport, overlay.rect);
    if (!rect) return null;
    return {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${Math.max(1, rect.width)}px`,
      height: `${Math.max(1, rect.height)}px`,
    };
  }, [convertPdfRectToViewportRect]);

  const renderPreviewOverlayNodes = useCallback((
    overlays: PdfPageOverlay[],
    viewport: ReturnType<PDFPageProxy["getViewport"]> | null,
  ) => overlays.map((overlay) => {
    const style = getPreviewOverlayStyle(overlay, viewport);
    if (!style) return null;
    if (overlay.kind === "image") {
      return (
        <img
          key={overlay.id}
          className="preview-image-overlay"
          src={overlay.previewUrl}
          alt={overlay.sourceName}
          style={style}
        />
      );
    }
    return null;
  }), [getPreviewOverlayStyle]);

  const buildAiCitationSearchQuery = useCallback((text: string) => {
    const tokens = normalizeSearchQuery(text)
      .split(" ")
      .filter(Boolean)
      .slice(0, 6);
    return tokens.join(" ");
  }, []);

  useEffect(() => {
    activePageRef.current = activePage;
    setPageInput(String(activePage));
  }, [activePage]);

  useEffect(() => {
    previewSelectionRectRef.current = previewSelectionRect;
  }, [previewSelectionRect]);

  useEffect(() => {
    if (!previewSpreadMode) return;
    setIsAreaSelectMode(false);
    setIsAreaSelecting(false);
    setPreviewSelectionRect(null);
  }, [previewSpreadMode]);

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

  const cancelProgressivePageLoad = useCallback(() => {
    progressivePageLoadTokenRef.current += 1;
    if (progressivePageLoadTimerRef.current !== null) {
      window.clearTimeout(progressivePageLoadTimerRef.current);
      progressivePageLoadTimerRef.current = null;
    }
  }, []);

  const clearPreviewCanvas = useCallback(() => {
    const canvas = previewCanvasRef.current;
    const secondaryCanvas = previewCanvasSecondaryRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = "0px";
      canvas.style.height = "0px";
    }
    if (secondaryCanvas) {
      secondaryCanvas.width = 0;
      secondaryCanvas.height = 0;
      secondaryCanvas.style.width = "0px";
      secondaryCanvas.style.height = "0px";
    }
    setPreviewPageSize({ width: 0, height: 0 });
    setPreviewSecondaryPageSize({ width: 0, height: 0 });
    setPreviewTextSpans([]);
    setSelectedPreviewText("");
    setPreviewSelectionRect(null);
    setIsAreaSelecting(false);
    primaryPreviewViewportRef.current = null;
    secondaryPreviewViewportRef.current = null;
    secondaryPreviewPageNumberRef.current = null;
  }, []);

  const replacePdfDocument = useCallback(async (nextDoc: PDFDocumentProxy | null) => {
    previewRenderGenerationRef.current += 1;
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
    if (!pdfDoc) return;
    const frameId = window.requestAnimationFrame(() => {
      previewInteractionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [pdfDoc]);

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
    cancelProgressivePageLoad();
    clearThumbnailPipeline();
    revokeOverlayUrls(pageOverlaysRef.current);
    if (pdfDocRef.current) void pdfDocRef.current.destroy();
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, [cancelProgressivePageLoad, clearThumbnailPipeline, revokeOverlayUrls]);

  const hydratePageListInBackground = useCallback((totalPages: number) => {
    if (totalPages <= 1) return;
    const token = progressivePageLoadTokenRef.current;
    let nextPage = 2;

    const shouldContinueAutoSelect = (startPage: number) => {
      const current = selectedPagesRef.current;
      if (current.size !== startPage - 1) return false;
      for (let pageNumber = 1; pageNumber < startPage; pageNumber += 1) {
        if (!current.has(pageNumber)) return false;
      }
      return true;
    };

    const pump = () => {
      if (progressivePageLoadTokenRef.current !== token) return;
      const batchEnd = Math.min(totalPages, nextPage + PAGE_LOAD_BATCH_SIZE - 1);
      const batch: number[] = [];
      for (let pageNumber = nextPage; pageNumber <= batchEnd; pageNumber += 1) batch.push(pageNumber);
      if (batch.length === 0) {
        progressivePageLoadTimerRef.current = null;
        return;
      }

      setPageOrder((prev) => [...prev, ...batch]);
      if (shouldContinueAutoSelect(nextPage)) {
        setSelectedPages((prev) => {
          const next = new Set(prev);
          for (const pageNumber of batch) next.add(pageNumber);
          return next;
        });
      }

      nextPage = batchEnd + 1;
      if (nextPage <= totalPages) {
        progressivePageLoadTimerRef.current = window.setTimeout(pump, PAGE_LOAD_BATCH_DELAY_MS);
      } else {
        progressivePageLoadTimerRef.current = null;
      }
    };

    progressivePageLoadTimerRef.current = window.setTimeout(pump, PAGE_LOAD_BATCH_DELAY_MS);
  }, []);

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
      setHasLoadedOutlineOnce(false);
      setIsLoadingOutline(false);
      setIsGeneratingOutline(false);
      setSidebarTab("thumbnails");
      setOutlinePanelMode("view");
      return;
    }
    if (sidebarTab !== "outline" || hasLoadedOutlineOnce) return;
    let cancelled = false;
    setIsLoadingOutline(true);
    void (async () => {
      try {
        const entries = await readOutlineEntriesFromDocument(pdfDoc);
        if (!cancelled) {
          setOutlineEntries(entries);
          setHasLoadedOutlineOnce(true);
        }
      } catch (error) {
        if (!cancelled) setErrorText(`${tr("목차 로딩 실패", "Failed to load outline")}: ${formatError(error)}`);
      } finally {
        if (!cancelled) setIsLoadingOutline(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasLoadedOutlineOnce, pdfDoc, readOutlineEntriesFromDocument, sidebarTab, tr]);

  const reloadOutlineFromPdf = useCallback(async () => {
    if (!pdfDoc || isBusy) return;
    setErrorText(null);
    setIsLoadingOutline(true);
    try {
      const entries = await readOutlineEntriesFromDocument(pdfDoc);
      setOutlineEntries(entries);
      setHasLoadedOutlineOnce(true);
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
  }, [convertViewportRectToPdfRect, isAreaSelecting]);

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
    if (!pdfDoc || pageCount === 0 || !isInitialPreviewReady) return;
    enqueueThumbnailPages([activePage, ...visiblePageNumbers], true);
    const prefetch: number[] = [];
    for (let offset = 1; offset <= THUMB_PREFETCH; offset += 1) {
      const afterIndex = visibleEndIndex + offset;
      const beforeIndex = visibleStartIndex - offset;
      if (afterIndex >= 0 && afterIndex < pageOrder.length) prefetch.push(pageOrder[afterIndex]);
      if (beforeIndex >= 0 && beforeIndex < pageOrder.length) prefetch.push(pageOrder[beforeIndex]);
    }
    enqueueThumbnailPages(prefetch, false);
  }, [pdfDoc, pageCount, isInitialPreviewReady, activePage, visiblePageNumbers, visibleEndIndex, visibleStartIndex, pageOrder, enqueueThumbnailPages]);

  const drawCachedPreviewCanvas = useCallback((target: HTMLCanvasElement, source: HTMLCanvasElement, width: number, height: number) => {
    target.width = source.width;
    target.height = source.height;
    target.style.width = `${Math.floor(width)}px`;
    target.style.height = `${Math.floor(height)}px`;
    const context = target.getContext("2d", { alpha: false });
    if (!context) throw new Error("Cannot acquire preview canvas context.");
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0);
  }, []);

  const prefetchPreviewPages = useCallback(async (
    doc: PDFDocumentProxy,
    pages: Array<{ pageNumber: number; rotation: number; scale: number }>,
  ) => {
    for (const target of pages) {
      if (target.pageNumber < 1 || target.pageNumber > doc.numPages) continue;
      const key = buildPreviewCacheKey(target.pageNumber, target.rotation, target.scale);
      if (previewRenderCacheRef.current.has(key)) continue;
      try {
        const page = await doc.getPage(target.pageNumber);
        const viewport = page.getViewport({ scale: target.scale, rotation: target.rotation });
        const dpr = window.devicePixelRatio || 1;
        const cachedCanvas = document.createElement("canvas");
        cachedCanvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        cachedCanvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        const context = cachedCanvas.getContext("2d", { alpha: false });
        if (!context) continue;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        const task = page.render({ canvasContext: context, viewport, intent: "display" });
        await task.promise;
        previewRenderCacheRef.current.set(key, cachedCanvas);
      } catch {
        // Ignore prefetch failures; foreground render still handles actual display.
      }
    }
  }, []);

  const loadPageSearchItems = useCallback(async (doc: PDFDocumentProxy, pageNumber: number) => {
    const cached = pageTextSearchCacheRef.current.get(pageNumber);
    if (cached) return cached;
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = buildSearchableTextSpans(textContent.items);
    pageTextSearchCacheRef.current.set(pageNumber, items);
    return items;
  }, []);

  useEffect(() => {
    if (!pdfDoc || previewSize.width < 40 || previewSize.height < 40) return;
    const canvas = previewCanvasRef.current;
    const secondaryCanvas = previewCanvasSecondaryRef.current;
    if (!canvas) return;
    let renderTask: RenderTask | null = null;
    let secondaryRenderTask: RenderTask | null = null;
    let textLayerTimer: number | null = null;
    let cancelled = false;
    const renderGeneration = previewRenderGenerationRef.current;
    const run = async () => {
      try {
        const page = await pdfDoc.getPage(activePage);
        if (cancelled || renderGeneration !== previewRenderGenerationRef.current) return;
        const secondaryPageNumber = previewSpreadMode && activePage < pageCount ? activePage + 1 : null;
        const secondaryPage = secondaryPageNumber ? await pdfDoc.getPage(secondaryPageNumber) : null;
        if (cancelled || renderGeneration !== previewRenderGenerationRef.current) return;
        const rotation = pageRotationsRef.current[activePage] ?? 0;
        const secondaryRotation = secondaryPageNumber ? (pageRotationsRef.current[secondaryPageNumber] ?? 0) : 0;
        const base = page.getViewport({ scale: 1, rotation });
        const secondaryBase = secondaryPage ? secondaryPage.getViewport({ scale: 1, rotation: secondaryRotation }) : null;
        const spreadGap = secondaryBase ? 12 : 0;
        const fitW = Math.max(previewSize.width - 24, 140);
        const fitH = Math.max(previewSize.height - 64, 140);
        const targetWidth = secondaryBase ? base.width + spreadGap + secondaryBase.width : base.width;
        const targetHeight = secondaryBase ? Math.max(base.height, secondaryBase.height) : base.height;
        const fitScale = Math.max(0.1, Math.min(fitW / targetWidth, fitH / targetHeight));
        const cssScale = previewZoomMode === "fit"
          ? fitScale
          : Math.max(0.1, fitScale * (previewZoom / 100));
        const viewport = page.getViewport({ scale: cssScale, rotation });
        const secondaryViewport = secondaryPage ? secondaryPage.getViewport({ scale: cssScale, rotation: secondaryRotation }) : null;
        primaryPreviewViewportRef.current = viewport;
        secondaryPreviewViewportRef.current = secondaryViewport;
        secondaryPreviewPageNumberRef.current = secondaryPageNumber;
        const dpr = window.devicePixelRatio || 1;
        const cacheKey = buildPreviewCacheKey(activePage, rotation, cssScale);
        const cachedPrimary = previewRenderCacheRef.current.get(cacheKey);
        if (cachedPrimary) {
          drawCachedPreviewCanvas(canvas, cachedPrimary, viewport.width, viewport.height);
        } else {
          canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
          canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("Cannot acquire preview canvas context.");
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
          context.clearRect(0, 0, viewport.width, viewport.height);
          renderTask = page.render({ canvasContext: context, viewport, intent: "display" });
          await renderTask.promise;
          const cachedCanvas = document.createElement("canvas");
          cachedCanvas.width = canvas.width;
          cachedCanvas.height = canvas.height;
          const cachedContext = cachedCanvas.getContext("2d", { alpha: false });
          if (cachedContext) cachedContext.drawImage(canvas, 0, 0);
          previewRenderCacheRef.current.set(cacheKey, cachedCanvas);
        }
        if (secondaryCanvas && secondaryViewport && secondaryPage) {
          const secondaryCacheKey = buildPreviewCacheKey(secondaryPageNumber ?? activePage, secondaryRotation, cssScale);
          const cachedSecondary = previewRenderCacheRef.current.get(secondaryCacheKey);
          if (cachedSecondary) {
            drawCachedPreviewCanvas(secondaryCanvas, cachedSecondary, secondaryViewport.width, secondaryViewport.height);
          } else {
            secondaryCanvas.width = Math.max(1, Math.floor(secondaryViewport.width * dpr));
            secondaryCanvas.height = Math.max(1, Math.floor(secondaryViewport.height * dpr));
            secondaryCanvas.style.width = `${Math.floor(secondaryViewport.width)}px`;
            secondaryCanvas.style.height = `${Math.floor(secondaryViewport.height)}px`;
            const secondaryContext = secondaryCanvas.getContext("2d", { alpha: false });
            if (!secondaryContext) throw new Error("Cannot acquire preview canvas context.");
            secondaryContext.setTransform(dpr, 0, 0, dpr, 0, 0);
            secondaryContext.clearRect(0, 0, secondaryViewport.width, secondaryViewport.height);
            secondaryRenderTask = secondaryPage.render({ canvasContext: secondaryContext, viewport: secondaryViewport, intent: "display" });
            await secondaryRenderTask.promise;
            const cachedCanvas = document.createElement("canvas");
            cachedCanvas.width = secondaryCanvas.width;
            cachedCanvas.height = secondaryCanvas.height;
            const cachedContext = cachedCanvas.getContext("2d", { alpha: false });
            if (cachedContext) cachedContext.drawImage(secondaryCanvas, 0, 0);
            previewRenderCacheRef.current.set(secondaryCacheKey, cachedCanvas);
          }
        } else if (secondaryCanvas) {
          secondaryCanvas.width = 0;
          secondaryCanvas.height = 0;
          secondaryCanvas.style.width = "0px";
          secondaryCanvas.style.height = "0px";
        }
        setPreviewPageSize({
          width: Math.max(1, Math.floor(viewport.width)),
          height: Math.max(1, Math.floor(viewport.height)),
        });
        setPreviewSecondaryPageSize(
          secondaryViewport
            ? {
              width: Math.max(1, Math.floor(secondaryViewport.width)),
              height: Math.max(1, Math.floor(secondaryViewport.height)),
            }
            : { width: 0, height: 0 },
        );
        setPreviewTextSpans([]);
        setSelectedPreviewText("");
        setPreviewSelectionRect(null);
        textLayerTimer = window.setTimeout(async () => {
          try {
            const textContent = await page.getTextContent();
            if (cancelled || renderGeneration !== previewRenderGenerationRef.current) return;

            setPreviewTextSpans(buildPreviewTextSpans(textContent.items, viewport.transform, viewport.scale, textContent.styles as Record<string, { fontFamily?: string }>));
          } catch (error) {
            const known = error as { name?: string; message?: string };
            console.error("PDF.js 텍스트 레이어 로딩 에러:", error);

            if (
              known.name !== "RenderingCancelledException"
              && !cancelled
              && renderGeneration === previewRenderGenerationRef.current
              && !isPdfJsDocumentTeardownError(error)
            ) {
              setErrorText(`${tr("본문 텍스트 레이어 로딩 실패", "Failed to load text layer")}: ${formatError(error)}`);
            }
          }
        }, 120);
        if (activePage === 1 && !isInitialPreviewReady) {
          setIsInitialPreviewReady(true);
          setStatus({ type: "loaded", pages: pdfDoc.numPages });
        }
        void prefetchPreviewPages(
          pdfDoc,
          [activePage - 1, activePage + 1, activePage + 2]
            .filter((pageNumber) => pageNumber >= 1 && pageNumber <= pageCount)
            .map((pageNumber) => ({
              pageNumber,
              rotation: pageRotationsRef.current[pageNumber] ?? 0,
              scale: cssScale,
            })),
        );
      } catch (error) {
        const known = error as { name?: string };
        if (
          known.name !== "RenderingCancelledException"
          && !cancelled
          && renderGeneration === previewRenderGenerationRef.current
          && !isPdfJsDocumentTeardownError(error)
        ) {
          setErrorText(`${tr("미리보기 렌더링 실패", "Preview render failed")}: ${formatError(error)}`);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (textLayerTimer !== null) window.clearTimeout(textLayerTimer);
      if (renderTask) renderTask.cancel();
      if (secondaryRenderTask) secondaryRenderTask.cancel();
    };
  }, [drawCachedPreviewCanvas, pdfDoc, activePage, pageCount, pageRotations, prefetchPreviewPages, previewSize, previewSpreadMode, previewZoom, previewZoomMode, isInitialPreviewReady, tr]);

  useEffect(() => {
    if (!isInitialPreviewReady || pendingHydrationPageCount <= 1) return;
    hydratePageListInBackground(pendingHydrationPageCount);
    setPendingHydrationPageCount(0);
  }, [hydratePageListInBackground, isInitialPreviewReady, pendingHydrationPageCount]);

  useEffect(() => {
    if (!pdfDoc || normalizedSearchQuery.length === 0) {
      searchTokenRef.current += 1;
      setSearchResults([]);
      setActiveSearchResultIndex(0);
      setIsSearchingDocument(false);
      return;
    }
    let cancelled = false;
    const token = searchTokenRef.current + 1;
    searchTokenRef.current = token;
    setIsSearchingDocument(true);
    void (async () => {
      const results: Array<{ pageNumber: number; spanIndex: number; text: string }> = [];
      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
        if (cancelled || searchTokenRef.current !== token) return;
        const items = await loadPageSearchItems(pdfDoc, pageNumber);
        items.forEach((text, spanIndex) => {
          if (normalizeSearchQuery(text).includes(normalizedSearchQuery)) {
            results.push({ pageNumber, spanIndex, text });
          }
        });
        if (pageNumber % 4 === 0) {
          setSearchResults([...results]);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
      if (cancelled || searchTokenRef.current !== token) return;
      setSearchResults(results);
      setActiveSearchResultIndex(0);
      setIsSearchingDocument(false);
    })().catch((error) => {
      if (cancelled || searchTokenRef.current !== token) return;
      setIsSearchingDocument(false);
      setErrorText(`${tr("본문 검색 실패", "Find in document failed")}: ${formatError(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPageSearchItems, normalizedSearchQuery, pdfDoc, tr]);

  useEffect(() => {
    const pendingJump = pendingAiCitationJumpRef.current;
    if (!pendingJump || searchResults.length === 0) return;
    const targetIndex = searchResults.findIndex((result) => (
      result.pageNumber === pendingJump.pageNumber
      && normalizeSearchQuery(result.text).includes(pendingJump.query)
    ));
    const fallbackIndex = searchResults.findIndex((result) => result.pageNumber === pendingJump.pageNumber);
    const nextIndex = targetIndex >= 0 ? targetIndex : fallbackIndex;
    if (nextIndex < 0) return;
    const target = searchResults[nextIndex];
    pendingAiCitationJumpRef.current = null;
    setActivePage(target.pageNumber);
    setActiveSearchResultIndex(nextIndex);
    focusPreviewArea();
  }, [focusPreviewArea, searchResults]);

  const resetPdfWorkspace = useCallback(async () => {
    cancelProgressivePageLoad();
    previewRenderCacheRef.current.clear();
    pageTextSearchCacheRef.current.clear();
    searchTokenRef.current += 1;
    clearOutlineDragState();
    clearThumbnailPipeline();
    revokeOverlayUrls(pageOverlaysRef.current);
    pageOverlaysRef.current = [];
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
    setHasLoadedOutlineOnce(false);
    setIsLoadingOutline(false);
    setIsGeneratingOutline(false);
    setShowPdfInfoModal(false);
    setPdfInfoTab("metadata");
    setPdfInfoMetadataFields([]);
    setPdfInfoFontNames([]);
    setQuickSelectInput("");
    setRangeFromInput("");
    setRangeToInput("");
    setIsAreaSelectMode(false);
    setIsInitialPreviewReady(false);
    setPendingHydrationPageCount(0);
    setShowSearchBar(false);
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setSearchResults([]);
    setActiveSearchResultIndex(0);
    setIsSearchingDocument(false);
    setPageRotations({});
    pageRotationsRef.current = {};
    setPageOverlays([]);
    setIsFileDragActive(false);
    setIsCurrentPdfEncrypted(false);
      setSecurityModalMode(null);
      setSecurityPassword("");
      setSecurityConfirmPassword("");
      setSecurityModalError(null);
      setPendingProtectedPdfPath(null);
  }, [cancelProgressivePageLoad, clearOutlineDragState, clearPreviewCanvas, clearThumbnailPipeline, replacePdfDocument, revokeOverlayUrls]);

  const loadPdfFromPath = useCallback(async (path: string, password?: string) => {
    setIsLoadingPdf(true);
    setStatus({ type: "loadingPdf", phase: "reading" });
    try {
      setStatus({ type: "loadingPdf", phase: "reading" });
      const fileBytes = new Uint8Array(await readFile(path));
      const previewBytes = cloneBytes(fileBytes);
      const stateBytes = cloneBytes(fileBytes);
      setStatus({ type: "loadingPdf", phase: "opening" });
      const task = getDocument({ data: previewBytes, password });
      const loadedDoc = await task.promise;
      await resetPdfWorkspace();
      await replacePdfDocument(loadedDoc);
      setPdfPath(path);
      setPdfBytes(stateBytes);
      await inspectCurrentPdfSecurity(stateBytes);
      setPageCount(loadedDoc.numPages);
      setPageOrder(loadedDoc.numPages > 0 ? [1] : []);
      setActivePage(1);
      setPageInput("1");
      setSelectedPages(loadedDoc.numPages > 0 ? new Set([1]) : new Set());
      setSidebarTab("thumbnails");
      setOutlinePanelMode("view");
      setOutlineEntries([]);
      setHasLoadedOutlineOnce(false);
      setRangeFromInput("");
      setRangeToInput("");
      setIsAreaSelectMode(false);
      setIsInitialPreviewReady(false);
      setPendingHydrationPageCount(loadedDoc.numPages);
      setPageRotations({});
      pageRotationsRef.current = {};
      setPendingProtectedPdfPath(null);
      setStatus({ type: "loadingPdf", phase: "firstPage" });
      return true;
    } catch (error) {
      if (isPdfPasswordRequiredError(error)) {
        setPendingProtectedPdfPath(path);
        setSecurityModalMode("open");
        setSecurityConfirmPassword("");
        setSecurityPassword(password ?? "");
        setSecurityModalError(
          password
            ? tr("비밀번호가 올바르지 않습니다. 다시 입력해주세요.", "Incorrect password. Enter it again.")
            : tr("이 PDF는 비밀번호가 필요합니다.", "This PDF requires a password."),
        );
        setStatus({ type: "ready" });
        return false;
      }
      setStatus({ type: "failed", reason: "pdfLoad" });
      setErrorText(`${tr("PDF 로딩 실패", "PDF loading failed")}: ${formatError(error)}`);
      return false;
    } finally {
      setIsLoadingPdf(false);
    }
  }, [inspectCurrentPdfSecurity, isPdfPasswordRequiredError, replacePdfDocument, resetPdfWorkspace, tr]);

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

  const handleDroppedImagesOnPreview = useCallback(async (
    paths: string[],
    position: { x: number; y: number },
  ) => {
    if (!pdfDoc) {
      showToast(tr("이미지를 놓기 전에 PDF를 먼저 열어주세요.", "Open a PDF before dropping an image."));
      return;
    }
    const cssPoint = toCssPointFromDragDropPosition(position);
    const targets = [
      {
        pageNumber: activePage,
        slot: previewPrimarySlotRef.current,
        viewport: primaryPreviewViewportRef.current,
      },
      {
        pageNumber: secondaryPreviewPageNumberRef.current,
        slot: previewSecondarySlotRef.current,
        viewport: secondaryPreviewViewportRef.current,
      },
    ].filter((target): target is {
      pageNumber: number;
      slot: HTMLDivElement;
      viewport: ReturnType<PDFPageProxy["getViewport"]>;
    } => !!target.pageNumber && !!target.slot && !!target.viewport);

    const target = targets.find(({ slot }) => {
      const rect = slot.getBoundingClientRect();
      return cssPoint.x >= rect.left && cssPoint.x <= rect.right && cssPoint.y >= rect.top && cssPoint.y <= rect.bottom;
    });
    if (!target) {
      showToast(tr("이미지는 페이지 미리보기 위에 놓아주세요.", "Drop the image onto the page preview."));
      return;
    }

    setErrorText(null);
    try {
      const created: PdfPageOverlay[] = [];
      const slotRect = target.slot.getBoundingClientRect();
      for (const [index, path] of paths.entries()) {
        const mimeType = imageMimeTypeFromPath(path);
        if (!mimeType) continue;
        const rawBytes = new Uint8Array(await readFile(path));
        const bytes = cloneBytes(rawBytes);
        const blob = new Blob([bytes], { type: mimeType });
        const { width: imageWidth, height: imageHeight } = await measureImage(blob);
        const maxWidth = Math.max(64, slotRect.width * 0.35);
        const maxHeight = Math.max(64, slotRect.height * 0.35);
        const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
        const drawWidth = Math.max(32, imageWidth * scale);
        const drawHeight = Math.max(32, imageHeight * scale);
        const centerX = cssPoint.x - slotRect.left + index * 18;
        const centerY = cssPoint.y - slotRect.top + index * 18;
        const left = clamp(centerX - drawWidth / 2, 0, Math.max(0, slotRect.width - drawWidth));
        const top = clamp(centerY - drawHeight / 2, 0, Math.max(0, slotRect.height - drawHeight));
        const rect = convertViewportRectToPdfRect(
          target.viewport,
          left,
          top,
          left + drawWidth,
          top + drawHeight,
        );
        if (!rectHasArea(rect)) continue;
        created.push({
          id: createOutlineEntryId(),
          kind: "image",
          pageNumber: target.pageNumber,
          rect,
          mimeType,
          bytes,
          previewUrl: URL.createObjectURL(blob),
          sourceName: path.split(/[\\/]/).pop() ?? "image",
        });
      }
      if (created.length === 0) {
        showToast(tr("드롭한 이미지 형식을 처리하지 못했습니다.", "The dropped image format is not supported."));
        return;
      }
      setPageOverlays((prev) => [...prev, ...created]);
      showToast(
        tr(
          `${created.length}개 이미지를 페이지에 배치했습니다.`,
          `Placed ${created.length} image${created.length > 1 ? "s" : ""} on the page.`,
        ),
      );
    } catch (error) {
      setErrorText(`${tr("이미지 드롭 실패", "Image drop failed")}: ${formatError(error)}`);
    }
  }, [activePage, convertViewportRectToPdfRect, pdfDoc, showToast, toCssPointFromDragDropPosition, tr]);

  const handleNativeFileDrop = useCallback(async (
    paths: string[],
    position?: { x: number; y: number },
  ) => {
    const pdfPaths = paths.filter(isPdfFilePath);
    if (pdfPaths.length > 0) {
      await loadPdfFromPath(pdfPaths[0]);
      if (pdfPaths.length > 1) {
        showToast(tr("여러 PDF 중 첫 번째 파일만 열었습니다.", "Opened only the first PDF from the drop."));
      }
      return;
    }
    const imagePaths = paths.filter(isImageFilePath);
    if (imagePaths.length > 0) {
      if (!position) {
        showToast(tr("이미지 드롭 위치를 찾지 못했습니다.", "Could not determine the image drop position."));
        return;
      }
      await handleDroppedImagesOnPreview(imagePaths, position);
    }
  }, [handleDroppedImagesOnPreview, loadPdfFromPath, showToast, tr]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const initialPath = searchParams.get("open");
    if (initialPath) {
      void loadPdfFromPath(initialPath);
    }

    // Tauri 환경에서만 추가 작업 수행
    if (isTauriRuntime()) {
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
    }
  }, [loadPdfFromPath]);

  useEffect(() => {
    // Tauri 환경에서만 드래그 앤 드롭 이벤트 리스너 등록
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsFileDragActive(true);
        return;
      }
      if (event.payload.type === "leave") {
        setIsFileDragActive(false);
        return;
      }
      setIsFileDragActive(false);
      void handleNativeFileDrop(event.payload.paths, event.payload.position);
    }).then((dispose) => {
      unlisten = dispose;
    }).catch(() => {
      setIsFileDragActive(false);
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [handleNativeFileDrop]);

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
      setIsCurrentPdfEncrypted(false);
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
      setIsCurrentPdfEncrypted(false);

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
    setPreviewZoomMode("manual");
    setPreviewZoom((previous) => clamp(previous + delta, ZOOM_MIN, ZOOM_MAX));
  }, []);

  const openSearchBar = useCallback(() => {
    setShowSearchBar(true);
  }, []);

  const closeSearchBar = useCallback(() => {
    setShowSearchBar(false);
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setSearchResults([]);
    setActiveSearchResultIndex(0);
    setIsSearchingDocument(false);
    searchTokenRef.current += 1;
  }, []);

  const commitSearchQuery = useCallback((query: string) => {
    setDebouncedSearchQuery(query);
    setActiveSearchResultIndex(0);
  }, []);

  const handleJumpToAiCitation = useCallback((snippet: { pageNumber: number; content: string }) => {
    if (!pdfDoc) return;
    const query = buildAiCitationSearchQuery(snippet.content);
    setActivePage(clamp(snippet.pageNumber, 1, Math.max(1, pageCount)));
    if (query.length > 0) {
      pendingAiCitationJumpRef.current = {
        pageNumber: clamp(snippet.pageNumber, 1, Math.max(1, pageCount)),
        query: normalizeSearchQuery(query),
      };
      openSearchBar();
      setSearchQuery(query);
      commitSearchQuery(query);
    } else {
      pendingAiCitationJumpRef.current = null;
    }
    focusPreviewArea();
  }, [buildAiCitationSearchQuery, commitSearchQuery, focusPreviewArea, openSearchBar, pageCount, pdfDoc]);

  const moveSearchResult = useCallback((direction: 1 | -1) => {
    if (searchResults.length === 0) return;
    setActiveSearchResultIndex((previous) => {
      const next = (previous + direction + searchResults.length) % searchResults.length;
      const target = searchResults[next];
      if (target) setActivePage(target.pageNumber);
      return next;
    });
  }, [searchResults]);

  const resetZoom = useCallback(() => {
    setPreviewZoomMode("fit");
    setPreviewZoom(100);
  }, []);

  const handlePreviewWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!isPreviewFocused || !pdfDoc || isBusy) return;
      if (event.ctrlKey) {
        event.preventDefault();
        const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        setPreviewZoomMode("manual");
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

  const applyPageOverlaysToOutputDocument = useCallback(async (
    outputDocument: PDFDocument,
    sourceToOutputPage: Map<number, number>,
  ) => {
    const overlays = pageOverlaysRef.current.filter((overlay) => (
      overlay.kind === "image" && sourceToOutputPage.has(overlay.pageNumber)
    ));
    if (overlays.length === 0) return;
    for (const overlay of overlays) {
      const outputPageNumber = sourceToOutputPage.get(overlay.pageNumber);
      if (!outputPageNumber) continue;
      const page = outputDocument.getPage(outputPageNumber - 1);
      const rect = normalizePdfRect(overlay.rect);
      const width = Math.max(1, rect.x2 - rect.x1);
      const height = Math.max(1, rect.y2 - rect.y1);
      page.drawRectangle({
        x: rect.x1,
        y: rect.y1,
        width,
        height,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });
      if (overlay.kind === "image") {
        const image = overlay.mimeType === "image/png"
          ? await outputDocument.embedPng(overlay.bytes)
          : await outputDocument.embedJpg(overlay.bytes);
        page.drawImage(image, {
          x: rect.x1,
          y: rect.y1,
          width,
          height,
        });
      }
    }
  }, []);

  const buildSelectedPdfBytes = useCallback(async (): Promise<Uint8Array> => {
    if (!pdfBytes || selectedPageNumbers.length === 0) {
      throw new Error(tr("인쇄 또는 저장할 페이지가 없습니다.", "No pages selected to print or save."));
    }
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
    await applyPageOverlaysToOutputDocument(outputDocument, sourceToOutputPage);
    return new Uint8Array(await outputDocument.save());
  }, [applyPageOverlaysToOutputDocument, pdfBytes, pdfPath, selectedPageNumbers, tr, validOutlineEntries]);

  const buildWorkspacePdfBytes = useCallback(async (excludedPageNumbers?: Set<number>): Promise<Uint8Array> => {
    const existingOrder = pageOrder.length === pageCount
      ? pageOrder
      : Array.from({ length: pageCount }, (_, index) => index + 1);
    if (!pdfBytes || existingOrder.length === 0) {
      throw new Error(tr("현재 작업중인 페이지가 없습니다.", "There are no pages in the current workspace."));
    }
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

    const pagesToKeep = existingOrder.filter((pageNumber) => !excludedPageNumbers?.has(pageNumber));
    if (pagesToKeep.length === 0) {
      throw new Error(tr("삭제 후 남는 페이지가 없습니다.", "No pages remain after deletion."));
    }

    const sourceDocument = await PDFDocument.load(workingBytes, { updateMetadata: false });
    const outputDocument = await PDFDocument.create();
    const sourceToOutputPage = new Map<number, number>();
    for (const [targetIndex, sourcePageNumber] of pagesToKeep.entries()) {
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
    await applyPageOverlaysToOutputDocument(outputDocument, sourceToOutputPage);
    return new Uint8Array(await outputDocument.save());
  }, [applyPageOverlaysToOutputDocument, pageCount, pageOrder, pdfBytes, pdfPath, tr, validOutlineEntries]);

  const deletePageFromWorkspace = useCallback(async (pageNumber: number) => {
    if (!pdfDoc || !pdfBytes || isBusy) return;
    const existingOrder = pageOrder.length === pageCount
      ? pageOrder
      : Array.from({ length: pageCount }, (_, index) => index + 1);
    const remainingPages = existingOrder.filter((value) => value !== pageNumber);
    if (remainingPages.length === 0) {
      await resetPdfWorkspace();
      setStatus({ type: "ready" });
      showToast(tr("마지막 페이지를 삭제하여 작업을 초기화했습니다.", "Deleted the last page and cleared the workspace."));
      return;
    }

    setErrorText(null);
    setIsSaving(true);
    setStatus({ type: "savingPdf" });
    try {
      const outputBytes = await buildWorkspacePdfBytes(new Set([pageNumber]));
      const previewBytes = cloneBytes(outputBytes);
      const stateBytes = cloneBytes(outputBytes);
      const task = getDocument({ data: previewBytes });
      const nextDoc = await task.promise;
      const nextSelectedPages = new Set<number>();
      const nextOutlineEntries = validOutlineEntries
        .filter((entry) => remainingPages.includes(entry.pageNumber))
        .map((entry) => ({
          ...entry,
          pageNumber: remainingPages.indexOf(entry.pageNumber) + 1,
        }));
      remainingPages.forEach((oldPageNumber, index) => {
        if (selectedPagesRef.current.has(oldPageNumber)) nextSelectedPages.add(index + 1);
      });
      const currentIndex = existingOrder.indexOf(pageNumber);
      const fallbackIndex = Math.min(currentIndex, remainingPages.length - 1);
      const nextActivePage = clamp(fallbackIndex + 1, 1, remainingPages.length);

      clearThumbnailPipeline();
      revokeOverlayUrls(pageOverlaysRef.current);
      pageOverlaysRef.current = [];
      await replacePdfDocument(nextDoc);
      setPdfBytes(stateBytes);
      setIsCurrentPdfEncrypted(false);
      setPageCount(remainingPages.length);
      setPageOrder(Array.from({ length: remainingPages.length }, (_, index) => index + 1));
      setSelectedPages(nextSelectedPages);
      setActivePage(nextActivePage);
      setPageInput(String(nextActivePage));
      setPageRotations({});
      pageRotationsRef.current = {};
      setPageOverlays([]);
      setOutlineEntries(nextOutlineEntries);
      setHasLoadedOutlineOnce(nextOutlineEntries.length > 0);
      setStatus({ type: "loaded", pages: remainingPages.length });
      showToast(tr("페이지를 삭제하고 번호를 다시 정리했습니다.", "Deleted the page and renumbered the workspace."));
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfSave" });
      setErrorText(`${tr("페이지 삭제 실패", "Failed to delete page")}: ${formatError(error)}`);
    } finally {
      setIsSaving(false);
    }
  }, [
    buildWorkspacePdfBytes,
    clearThumbnailPipeline,
    isBusy,
    pageCount,
    pageOrder,
    pdfBytes,
    pdfDoc,
    replacePdfDocument,
    resetPdfWorkspace,
    revokeOverlayUrls,
    showToast,
    tr,
    validOutlineEntries,
  ]);

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
      const outputBytes = await buildSelectedPdfBytes();
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
  }, [buildSelectedPdfBytes, openExplorerAfterSave, pdfBytes, pdfPath, selectedPageNumbers.length, showToast, tr]);

  const handleSaveProtectedPdf = useCallback(async (password: string) => {
    setErrorText(null);
    if (!pdfDoc || !pdfBytes) {
      await message(tr("먼저 PDF를 열어주세요.", "Open a PDF first."), { title: tr("안내", "Notice") });
      return false;
    }
    if (selectedPageNumbers.length === 0) {
      await message(tr("암호 저장할 페이지를 하나 이상 선택해주세요.", "Select at least one page to save with password."), {
        title: tr("안내", "Notice"),
      });
      return false;
    }
    const isOutlineReady = await waitForOutlineLoadToFinish();
    if (!isOutlineReady) {
      await message(
        tr("목차 로딩이 끝난 뒤 다시 시도해주세요.", "Wait for outline loading to finish, then try again."),
        { title: tr("안내", "Notice") },
      );
      return false;
    }
    const sourceStem = normalizeFileStem(pdfPath ?? "document.pdf");
    const exportUuid = createExportUuid();
    const targetPath = await save({
      title: tr("암호 PDF 저장", "Save password-protected PDF"),
      defaultPath: `${sourceStem}_${exportUuid}_protected.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!targetPath) return false;

    setIsSaving(true);
    setStatus({ type: "savingPdf" });
    try {
      const outputBytes = await buildSelectedPdfBytes();
      await invoke("protect_pdf", {
        request: {
          pdfBytes: Array.from(outputBytes),
          outputPath: targetPath,
          password,
          ownerPassword: null,
        },
      });
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
          `암호가 걸린 PDF로 ${selectedPageNumbers.length}페이지를 저장했습니다.`,
          `Saved ${selectedPageNumbers.length} selected pages as a password-protected PDF.`,
        ),
      );
      return true;
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfSave" });
      setErrorText(`${tr("암호 PDF 저장 실패", "Failed to save password-protected PDF")}: ${formatError(error)}`);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    buildSelectedPdfBytes,
    openExplorerAfterSave,
    pdfBytes,
    pdfDoc,
    pdfPath,
    selectedPageNumbers.length,
    showToast,
    tr,
    waitForOutlineLoadToFinish,
  ]);

  const handleUnprotectPdf = useCallback(async (password: string) => {
    if (isBusy) return false;
    setErrorText(null);
    if (!pdfPath) return false;
    const targetPath = await save({
      title: tr("암호 해제 PDF 저장", "Save unlocked PDF"),
      defaultPath: `${normalizeFileStem(pdfPath)}_${createExportUuid()}_unlocked.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!targetPath) return false;

    setIsSaving(true);
    setStatus({ type: "savingPdf" });
    try {
      await invoke("unprotect_pdf", {
        request: {
          inputPath: pdfPath,
          outputPath: targetPath,
          password,
        },
      });
      if (openExplorerAfterSave) {
        try {
          await revealItemInDir(targetPath);
        } catch {
          // Ignore explorer open failures; save itself already succeeded.
        }
      }
      setStatus({ type: "savedPdf", pages: 1 });
      showToast(tr("보안 문서 암호를 해제하여 저장했습니다.", "Removed the PDF password and saved the file."));
      return true;
    } catch (error) {
      setStatus({ type: "failed", reason: "pdfSave" });
      setErrorText(`${tr("암호 해제 실패", "Failed to remove PDF password")}: ${formatError(error)}`);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [isBusy, openExplorerAfterSave, pdfPath, showToast, tr]);

  const submitPdfSecurityModal = useCallback(async () => {
    if (!securityModalMode) return;
    const trimmedPassword = securityPassword.trim();
    if (trimmedPassword.length === 0) {
      setSecurityModalError(tr("비밀번호를 입력해주세요.", "Enter a password."));
      return;
    }
    if (securityModalMode === "protect") {
      if (selectedPageNumbers.length === 0) {
        setSecurityModalError(tr("암호 저장할 페이지를 하나 이상 선택해주세요.", "Select at least one page to save with password."));
        return;
      }
      if (trimmedPassword !== securityConfirmPassword.trim()) {
        setSecurityModalError(tr("비밀번호 확인이 일치하지 않습니다.", "The confirmation password does not match."));
        return;
      }
      const didSave = await handleSaveProtectedPdf(trimmedPassword);
      if (didSave) closePdfSecurityModal();
      return;
    }
    if (securityModalMode === "open") {
      if (!pendingProtectedPdfPath) {
        setSecurityModalError(tr("열 PDF 경로를 찾지 못했습니다.", "Could not find the PDF to open."));
        return;
      }
      const didOpen = await loadPdfFromPath(pendingProtectedPdfPath, trimmedPassword);
      if (didOpen) closePdfSecurityModal();
      return;
    }
    const didUnlock = await handleUnprotectPdf(trimmedPassword);
    if (didUnlock) closePdfSecurityModal();
  }, [
    closePdfSecurityModal,
    handleSaveProtectedPdf,
    handleUnprotectPdf,
    loadPdfFromPath,
    pendingProtectedPdfPath,
    securityConfirmPassword,
    securityModalMode,
    securityPassword,
    selectedPageNumbers.length,
    tr,
  ]);

  const handlePrintSelection = useCallback(async () => {
    if (!pdfDoc || !pdfBytes) {
      await message(tr("먼저 PDF를 열어주세요.", "Open a PDF first."), { title: tr("안내", "Notice") });
      return;
    }
    if (selectedPageNumbers.length === 0) {
      await message(tr("인쇄할 페이지를 하나 이상 선택해주세요.", "Select at least one page to print."), {
        title: tr("안내", "Notice"),
      });
      return;
    }

    setErrorText(null);
    setIsSaving(true);
    try {
      const outputBytes = await buildSelectedPdfBytes();
      const blob = new Blob([outputBytes], { type: "application/pdf" });
      const blobUrl = URL.createObjectURL(blob);
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";

      await new Promise<void>((resolve, reject) => {
        let cleanedUp = false;
        let startupTimeoutId: number | null = window.setTimeout(() => {
          cleanup();
          reject(new Error(tr("인쇄 창을 열지 못했습니다.", "Failed to open the print frame.")));
        }, 15000);
        let cleanupFallbackId: number | null = null;

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (startupTimeoutId !== null) window.clearTimeout(startupTimeoutId);
          if (cleanupFallbackId !== null) window.clearTimeout(cleanupFallbackId);
          iframe.remove();
          URL.revokeObjectURL(blobUrl);
        };

        iframe.onload = () => {
          const targetWindow = iframe.contentWindow;
          if (!targetWindow) {
            cleanup();
            reject(new Error(tr("인쇄 창을 열지 못했습니다.", "Failed to open the print frame.")));
            return;
          }

          const finishCleanup = () => {
            targetWindow.removeEventListener("afterprint", finishCleanup);
            cleanup();
          };

          targetWindow.addEventListener("afterprint", finishCleanup, { once: true });
          window.setTimeout(() => {
            try {
              if (startupTimeoutId !== null) {
                window.clearTimeout(startupTimeoutId);
                startupTimeoutId = null;
              }
              targetWindow.focus();
              targetWindow.print();
              cleanupFallbackId = window.setTimeout(finishCleanup, 60000);
              resolve();
            } catch (error) {
              cleanup();
              reject(error);
            }
          }, 250);
        };

        iframe.src = blobUrl;
        document.body.appendChild(iframe);
      });

      showToast(
        tr(
          `선택한 ${selectedPageNumbers.length}페이지 인쇄 창을 열었습니다.`,
          `Opened the print dialog for ${selectedPageNumbers.length} selected pages.`,
        ),
      );
    } catch (error) {
      setErrorText(`${tr("인쇄 실패", "Print failed")}: ${formatError(error)}`);
    } finally {
      setIsSaving(false);
    }
  }, [buildSelectedPdfBytes, pdfBytes, pdfDoc, selectedPageNumbers.length, showToast, tr]);

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

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const shift = event.shiftKey;
      const editable = isEditableTarget(event.target);
      const key = event.key.toLowerCase();
      if (isBusy) return;

      if (ctrlOrMeta && !shift && key === "o") {
        event.preventDefault();
        void handleOpenPdf();
        return;
      }
      if (ctrlOrMeta && !shift && key === "f") {
        if (!pdfDoc) return;
        event.preventDefault();
        openSearchBar();
        return;
      }
      if (ctrlOrMeta && shift && key === "o") {
        if (editable) return;
        event.preventDefault();
        void handleOpenAddPdfModal();
        return;
      }
      if (ctrlOrMeta && shift && key === "m") {
        if (editable) return;
        event.preventDefault();
        void handleMergePdfs();
        return;
      }
      if (ctrlOrMeta && !shift && key === "w") {
        if (!pdfDoc) return;
        event.preventDefault();
        void handleClosePdf();
        return;
      }
      if (ctrlOrMeta && !shift && key === "p") {
        if (!pdfDoc || selectedPageNumbers.length === 0) return;
        event.preventDefault();
        void handlePrintSelection();
        return;
      }
      if (ctrlOrMeta && !shift && key === "s") {
        if (!pdfDoc || selectedPageNumbers.length === 0) return;
        event.preventDefault();
        void handleSaveSelection();
        return;
      }
      if (!editable && ctrlOrMeta && !shift && key === "a") {
        if (!pdfDoc || pageCount === 0) return;
        event.preventDefault();
        setSelectedPages(new Set(pageNumbers));
        return;
      }
      if (!editable && event.key === "Escape") {
        if (showSearchBar) {
          event.preventDefault();
          closeSearchBar();
          return;
        }
        if (selectedPageNumbers.length === 0) return;
        event.preventDefault();
        setSelectedPages(new Set());
        return;
      }
      if (!editable && ctrlOrMeta && !shift && key === "-") {
        if (!pdfDoc) return;
        event.preventDefault();
        void applyRangeSelection("remove");
        return;
      }
      if (!editable && event.key === "PageUp") {
        if (!pdfDoc || pageCount === 0) return;
        event.preventDefault();
        movePage(-1);
        return;
      }
      if (!editable && event.key === "PageDown") {
        if (!pdfDoc || pageCount === 0) return;
        event.preventDefault();
        movePage(1);
        return;
      }
      if (!editable && ctrlOrMeta && event.key === "[") {
        if (!pdfDoc || pageCount === 0) return;
        event.preventDefault();
        rotateActivePage(-90);
        return;
      }
      if (!editable && ctrlOrMeta && event.key === "]") {
        if (!pdfDoc || pageCount === 0) return;
        event.preventDefault();
        rotateActivePage(90);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    applyRangeSelection,
    closeSearchBar,
    handleClosePdf,
    handleMergePdfs,
    handleOpenAddPdfModal,
    handleOpenPdf,
    handlePrintSelection,
    handleSaveSelection,
    isBusy,
    movePage,
    openSearchBar,
    pageCount,
    pageNumbers,
    pdfDoc,
    rotateActivePage,
    selectedPageNumbers.length,
    showSearchBar,
  ]);

  const loadPdfInfo = useCallback(async () => {
    if (!pdfDoc) return;
    setIsLoadingPdfInfo(true);
    try {
      const metadata = await pdfDoc.getMetadata();
      const info = (metadata.info ?? {}) as Record<string, unknown>;
      const rawFields: Array<[string, unknown]> = [
        [tr("파일", "File"), pdfPath ?? "-"],
        [tr("페이지 수", "Pages"), pdfDoc.numPages],
        [tr("제목", "Title"), info.Title],
        [tr("저자", "Author"), info.Author],
        [tr("주제", "Subject"), info.Subject],
        [tr("키워드", "Keywords"), info.Keywords],
        [tr("작성 도구", "Creator"), info.Creator],
        [tr("생성 프로그램", "Producer"), info.Producer],
        [tr("생성일", "Creation Date"), info.CreationDate],
        [tr("수정일", "Modification Date"), info.ModDate],
        [tr("PDF 버전", "PDF Format Version"), info.PDFFormatVersion],
      ];
      setPdfInfoMetadataFields(
        rawFields
          .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
          .map(([label, value]) => ({ label, value: String(value) })),
      );

      const fonts = new Set<string>();
      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
        const page = await pdfDoc.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const styles = textContent.styles as Record<string, { fontFamily?: string }>;
        for (const item of textContent.items as Array<{ fontName?: string }>) {
          const fontName = item.fontName;
          const fontFamily = fontName ? styles[fontName]?.fontFamily : undefined;
          const displayName = normalizeOutlineTitle(fontFamily ?? fontName ?? "");
          if (displayName.length > 0) fonts.add(displayName);
        }
      }
      setPdfInfoFontNames(Array.from(fonts).sort((a, b) => a.localeCompare(b)));
    } catch (error) {
      setErrorText(`${tr("PDF 정보 로딩 실패", "Failed to load PDF info")}: ${formatError(error)}`);
    } finally {
      setIsLoadingPdfInfo(false);
    }
  }, [pdfDoc, pdfPath, tr]);

  useEffect(() => {
    hasPrefetchedPdfInfoRef.current = false;
  }, [pdfDoc, pdfPath]);

  useEffect(() => {
    const thumbnailsReady = pageCount > 0 && Object.keys(thumbnailUrls).length >= pageCount;
    const pagesReady = pageCount > 0 && pageOrder.length === pageCount && pendingHydrationPageCount === 0;
    if (!pdfDoc || isLoadingPdf || isSaving || isAddingPdf || isLoadingPdfInfo || hasPrefetchedPdfInfoRef.current) return;
    if (!pagesReady || !thumbnailsReady) return;
    hasPrefetchedPdfInfoRef.current = true;
    void loadPdfInfo();
  }, [
    isAddingPdf,
    isLoadingPdf,
    isLoadingPdfInfo,
    isSaving,
    loadPdfInfo,
    pageCount,
    pageOrder.length,
    pdfDoc,
    pendingHydrationPageCount,
    thumbnailUrls,
  ]);

  const openPdfInfoModal = useCallback(() => {
    if (!pdfDoc || isBusy) return;
    setPdfInfoTab("metadata");
    setShowPdfInfoModal(true);
    void loadPdfInfo();
  }, [isBusy, loadPdfInfo, pdfDoc]);

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
  const previewStackStyle = useMemo(() => ({
    width: `${previewPageSize.width + (previewSecondaryPageSize.width > 0 ? previewSecondaryPageSize.width + 12 : 0)}px`,
    height: `${Math.max(previewPageSize.height, previewSecondaryPageSize.height)}px`,
  }), [previewPageSize.height, previewPageSize.width, previewSecondaryPageSize.height, previewSecondaryPageSize.width]);
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
              <button
                className="primary-btn"
                onClick={() => void handleOpenPdf()}
                disabled={isBusy}
                title={withShortcutHint(tr("PDF 열기", "Open PDF"), showShortcuts ? SHORTCUT_LABELS.openPdf : undefined)}
              >
                <span className="btn-content">
                  <ToolbarIcon name="open" />
                  {tr("PDF 열기", "Open PDF")}
                  {showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.openPdf}</span>}
                </span>
              </button>
              <button
                className="ghost-btn"
                onClick={() => void handleOpenAddPdfModal()}
                disabled={!pdfDoc || !pdfBytes || isBusy}
                title={withShortcutHint(tr("PDF 추가", "Add PDF"), showShortcuts ? SHORTCUT_LABELS.addPdf : undefined)}
              >
                <span className="btn-content">
                  <ToolbarIcon name="add" />
                  {tr("PDF 추가", "Add PDF")}
                  {showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.addPdf}</span>}
                </span>
              </button>
              <button
                className="ghost-btn"
                onClick={() => void handleMergePdfs()}
                disabled={isBusy}
                title={withShortcutHint(tr("PDF 병합", "Merge PDFs"), showShortcuts ? SHORTCUT_LABELS.mergePdfs : undefined)}
              >
                <span className="btn-content">
                  <ToolbarIcon name="merge" />
                  {tr("PDF 병합", "Merge PDFs")}
                  {showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.mergePdfs}</span>}
                </span>
              </button>
              {pdfDoc ? (
                <>
                  <button
                    className="primary-btn"
                    onClick={() => void handleSaveSelection()}
                    disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}
                    title={withShortcutHint(tr("선택 저장", "Save selection"), showShortcuts ? SHORTCUT_LABELS.saveSelection : undefined)}
                  >
                    <span className="btn-content"><ToolbarIcon name="save" />{tr("선택 저장", "Save selection")}{showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.saveSelection}</span>}</span>
                  </button>
                  {isCurrentPdfEncrypted ? (
                    <button
                      className="ghost-btn"
                      onClick={openUnprotectPdfModal}
                      disabled={!pdfDoc || !pdfPath || isBusy}
                      title={tr("현재 열린 암호 PDF를 해제하여 새 파일로 저장합니다.", "Save the current encrypted PDF as a new unlocked file.")}
                    >
                      <span className="btn-content">{tr("보안해제", "Unlock PDF")}</span>
                    </button>
                  ) : (
                    <button
                      className="ghost-btn"
                      onClick={openProtectPdfModal}
                      disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}
                      title={tr("선택 페이지를 암호가 걸린 PDF로 저장합니다.", "Save selected pages as a password-protected PDF.")}
                    >
                      <span className="btn-content">{tr("암호저장", "Save Locked")}</span>
                    </button>
                  )}
                  <button
                    className="ghost-btn"
                    onClick={() => void handleClosePdf()}
                    disabled={isBusy}
                    title={withShortcutHint(tr("닫기", "Close"), showShortcuts ? SHORTCUT_LABELS.closePdf : undefined)}
                  >
                    <span className="btn-content">
                      <ToolbarIcon name="close" />
                      {tr("닫기", "Close")}
                      {showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.closePdf}</span>}
                    </span>
                  </button>
                </>
              ) : null}
            </div>
            <span>{statusText}</span>
            <span>{tr("선택", "Selected")} {selectedPageNumbers.length} / {tr("전체", "Total")} {pageCount}</span>
          </div>
          <div className="toolbar-head-actions">
            <button
              className={`ghost-btn toolbar-toggle-btn ${showAiPanel ? "tab-active" : ""}`}
              type="button"
              onClick={() => setShowAiPanel((prev) => !prev)}
              title={showAiPanel ? tr("AI 대화창 닫기", "Hide AI chat") : tr("AI 대화창 열기", "Show AI chat")}
            >
              {tr("AI대화", "AI Chat")}
            </button>
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
            <button
              className="ghost-btn"
              type="button"
              onClick={openPdfInfoModal}
              disabled={!pdfDoc || isBusy}
              title={tr("문서 메타정보와 사용 폰트를 확인", "View document metadata and detected fonts")}
            >
              {tr("PDF정보", "PDF Info")}
            </button>
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
            <button
              className="ghost-btn"
              onClick={() => void applyQuickSelection()}
              disabled={!pdfDoc || isBusy}
              title={withShortcutHint(tr("적용", "Apply"), showShortcuts ? SHORTCUT_LABELS.applyQuickSelection : undefined)}
            >
              <span className="btn-content"><ToolbarIcon name="apply" />{tr("적용", "Apply")}{showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.applyQuickSelection}</span>}</span>
            </button>
            <button
              className="ghost-btn"
              onClick={() => setSelectedPages(new Set(pageNumbers))}
              disabled={!pdfDoc || isBusy || pageCount === 0}
              title={withShortcutHint(tr("전체 선택", "Select all"), showShortcuts ? SHORTCUT_LABELS.selectAllPages : undefined)}
            >
              <span className="btn-content"><ToolbarIcon name="selectAll" />{tr("전체 선택", "Select all")}{showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.selectAllPages}</span>}</span>
            </button>
            <button
              className="ghost-btn"
              onClick={() => setSelectedPages(new Set())}
              disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}
              title={withShortcutHint(tr("선택 해제", "Clear selection"), showShortcuts ? SHORTCUT_LABELS.clearSelection : undefined)}
            >
              <span className="btn-content"><ToolbarIcon name="clear" />{tr("선택 해제", "Clear selection")}{showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.clearSelection}</span>}</span>
            </button>
            <button
              className="ghost-btn"
              onClick={() => void handlePrintSelection()}
              disabled={!pdfDoc || isBusy || selectedPageNumbers.length === 0}
              title={withShortcutHint(tr("선택 인쇄", "Print selection"), showShortcuts ? SHORTCUT_LABELS.printSelection : undefined)}
            >
              <span className="btn-content"><ToolbarIcon name="print" />{tr("선택 인쇄", "Print selection")}{showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.printSelection}</span>}</span>
            </button>
            <label className="inline-field range-field"><span>{tr("범위 선택", "Range select")}</span>
              <input value={rangeFromInput} onChange={(event) => setRangeFromInput(event.currentTarget.value)} placeholder={tr("시작", "Start")} inputMode="numeric" disabled={!pdfDoc || isBusy} />
              <span className="range-separator">~</span>
              <input value={rangeToInput} onChange={(event) => setRangeToInput(event.currentTarget.value)} placeholder={tr("끝", "End")} inputMode="numeric" disabled={!pdfDoc || isBusy} />
            </label>
            <button
              className="ghost-btn"
              onClick={() => void applyRangeSelection("remove")}
              disabled={!pdfDoc || isBusy}
              title={withShortcutHint(tr("범위 제거", "Remove range"), showShortcuts ? SHORTCUT_LABELS.removeRange : undefined)}
            >
              <span className="btn-content"><ToolbarIcon name="rangeRemove" />{tr("범위 제거", "Remove range")}{showShortcuts && <span className="btn-shortcut">{SHORTCUT_LABELS.removeRange}</span>}</span>
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
            <label className="inline-field">
              <span>{tr("PDF 연결", "PDF association")}</span>
              <select
                value={openPdfInNewWindow ? "new" : "existing"}
                onChange={(event) => setOpenPdfInNewWindow(event.currentTarget.value === "new")}
                disabled={isBusy}
              >
                <option value="new">{tr("새창열기", "New window")}</option>
                <option value="existing">{tr("기존창열기", "Existing window")}</option>
              </select>
            </label>
            <label className="inline-field">
              <span>{tr("단축키", "Shortcuts")}</span>
              <select
                value={showShortcuts ? "show" : "hide"}
                onChange={(event) => setShowShortcuts(event.currentTarget.value === "show")}
                disabled={isBusy}
              >
                <option value="show">{tr("보이기", "Show")}</option>
                <option value="hide">{tr("안보이기", "Hide")}</option>
              </select>
            </label>
          </div>
          <div className="toolbar-line-break" aria-hidden="true" />

          <div className="action-group toolbar-block view-block">
            <button className="ghost-btn" onClick={() => { movePage(-1); focusPreviewArea(); }} disabled={!pdfDoc || isBusy || activePage <= 1} title={withShortcutHint(tr("이전", "Previous"), showShortcuts ? SHORTCUT_LABELS.previousPage : undefined)}>{tr("이전", "Previous")}</button>
            <label className="inline-field page-field"><span>{tr("페이지", "Page")}</span>
              <input value={pageInput} onChange={(event) => setPageInput(event.currentTarget.value)} onBlur={goToPage} onKeyDown={(event) => { if (event.key === "Enter") goToPage(); }} inputMode="numeric" disabled={!pdfDoc || isBusy} />
            </label>
            <button className="ghost-btn" onClick={() => { goToPage(); focusPreviewArea(); }} disabled={!pdfDoc || isBusy}>{tr("이동", "Go")}</button>
            <button className="ghost-btn" onClick={() => { movePage(1); focusPreviewArea(); }} disabled={!pdfDoc || isBusy || activePage >= pageCount} title={withShortcutHint(tr("다음", "Next"), showShortcuts ? SHORTCUT_LABELS.nextPage : undefined)}>{tr("다음", "Next")}</button>
          </div>
          <div className="action-group">
            <label className="inline-field zoom-field">
              <span>{tr("확대", "Zoom")}</span>
              <button
                className="ghost-btn mini-btn"
                onClick={() => { adjustZoom(-ZOOM_STEP); focusPreviewArea(); }}
                disabled={!pdfDoc || isBusy}
                type="button"
              >
                -
              </button>
              <span className="zoom-value">{previewZoomMode === "fit" ? tr("맞춤", "Fit") : `${previewZoom}%`}</span>
              <button
                className="ghost-btn mini-btn"
                onClick={() => { adjustZoom(ZOOM_STEP); focusPreviewArea(); }}
                disabled={!pdfDoc || isBusy}
                type="button"
              >
                +
              </button>
              <button
                className="ghost-btn mini-btn"
                onClick={() => { resetZoom(); focusPreviewArea(); }}
                disabled={!pdfDoc || isBusy}
                type="button"
              >
                {tr("맞춤", "Fit")}
              </button>
              <button
                className={`ghost-btn mini-btn ${!previewSpreadMode ? "tab-active" : ""}`}
                onClick={() => { setPreviewSpreadMode(false); focusPreviewArea(); }}
                disabled={!pdfDoc || isBusy}
                type="button"
                title={tr("한 페이지씩 보기", "Show one page at a time")}
              >
                <span className="btn-content"><ToolbarIcon name="singlePage" />{tr("한페이지씩", "1-Up")}</span>
              </button>
              <button
                className={`ghost-btn mini-btn ${previewSpreadMode ? "tab-active" : ""}`}
                onClick={() => { setPreviewSpreadMode(true); focusPreviewArea(); }}
                disabled={!pdfDoc || isBusy}
                type="button"
                title={tr("두 페이지씩 보기", "Show two pages at a time")}
              >
                <span className="btn-content"><ToolbarIcon name="doublePage" />{tr("두페이지씩", "2-Up")}</span>
              </button>
            </label>
            <button
              className="ghost-btn"
              onClick={() => { rotateActivePage(-90); focusPreviewArea(); }}
              disabled={!pdfDoc || isBusy}
              type="button"
              title={withShortcutHint(tr("왼쪽 회전", "Rotate Left"), showShortcuts ? SHORTCUT_LABELS.rotateLeft : undefined)}
            >
              {tr("왼쪽 회전", "Rotate Left")}
            </button>
            <button
              className="ghost-btn"
              onClick={() => { rotateActivePage(90); focusPreviewArea(); }}
              disabled={!pdfDoc || isBusy}
              type="button"
              title={withShortcutHint(tr("오른쪽 회전", "Rotate Right"), showShortcuts ? SHORTCUT_LABELS.rotateRight : undefined)}
            >
              {tr("오른쪽 회전", "Rotate Right")}
            </button>
          </div>

        </div>
        ) : null}
      </section>

      {errorText ? <section className="panel error-banner">{errorText}</section> : null}
      {toastText ? <section className="toast-banner">{toastText}</section> : null}

      <main className={`workspace ${showAiPanel ? "with-ai" : ""}`}>
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
                            onClick={() => void deletePageFromWorkspace(pageNumber)}
                            disabled={isBusy}
                            title={tr("현재 작업본에서 이 페이지를 삭제합니다.", "Delete this page from the current workspace.")}
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
                      title={`${entry.title} (${tr("페이지", "Page")} ${entry.pageNumber})`}
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
                    className={`ghost-btn micro-btn ${showSearchBar ? "tab-active" : ""}`}
                    onClick={showSearchBar ? closeSearchBar : openSearchBar}
                    type="button"
                    disabled={isBusy}
                    title={withShortcutHint(tr("문서 검색", "Find in document"), showShortcuts ? SHORTCUT_LABELS.findInDocument : undefined)}
                  >
                    <ToolbarIcon name="search" />
                    {tr("검색", "Find")}
                  </button>
                  <button
                    className="ghost-btn micro-btn"
                    onClick={() => {
                      addManualOutlineAtActivePage();
                      focusPreviewArea();
                    }}
                    type="button"
                    disabled={isBusy}
                    title={tr("현재 페이지로 새 목차 항목을 추가합니다.", "Add a new outline entry for the current page.")}
                  >
                    {tr("현재추가", "Add Current")}
                  </button>
                  <button
                    className={`ghost-btn micro-btn ${isAreaSelectMode ? "tab-active" : ""}`}
                    onClick={() => {
                      toggleAreaSelectionMode();
                      focusPreviewArea();
                    }}
                    type="button"
                    disabled={isBusy}
                    title={tr("영역 드래그로 텍스트 추출", "Drag area to extract text")}
                  >
                    {isAreaSelectMode ? tr("영역선택ON", "Area ON") : tr("영역선택", "Area Select")}
                  </button>
                  <button
                    className="ghost-btn micro-btn"
                    onClick={() => {
                      void addSelectedPreviewTextToOutline();
                      focusPreviewArea();
                    }}
                    type="button"
                    disabled={isBusy || normalizeOutlineTitle(selectedPreviewText).length === 0}
                    title={tr("선택 텍스트를 목차에 추가", "Add selected text to outline")}
                  >
                    {tr("선택→목차", "Sel->Outline")}
                  </button>
                  {showSearchBar ? (
                    <>
                    <label className="inline-field preview-search-field">
                      <span>{tr("찾기", "Find")}</span>
                      <input
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(event) => {
                          setSearchQuery(event.currentTarget.value);
                          setActiveSearchResultIndex(0);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            if (searchQuery !== debouncedSearchQuery) {
                              commitSearchQuery(searchQuery);
                              return;
                            }
                            moveSearchResult(event.shiftKey ? -1 : 1);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            closeSearchBar();
                          }
                        }}
                        placeholder={tr("본문 검색어 입력", "Type text to find")}
                        disabled={!pdfDoc || isBusy}
                      />
                    </label>
                    <button
                      className="ghost-btn micro-btn"
                      type="button"
                      onClick={() => moveSearchResult(-1)}
                      disabled={searchResults.length === 0}
                      title={tr("이전 검색 결과", "Previous match")}
                    >
                      {tr("이전결과", "Prev")}
                    </button>
                    <button
                      className="ghost-btn micro-btn"
                      type="button"
                      onClick={() => moveSearchResult(1)}
                      disabled={searchResults.length === 0}
                      title={tr("다음 검색 결과", "Next match")}
                    >
                      {tr("다음결과", "Next")}
                    </button>
                    <button
                      className="ghost-btn micro-btn"
                      type="button"
                      onClick={closeSearchBar}
                      title={tr("검색 취소", "Cancel search")}
                    >
                      {tr("검색취소", "Cancel")}
                    </button>
                    <span className="preview-search-status">
                      {isSearchingDocument
                        ? tr("검색 중...", "Searching...")
                        : showSearchBar && searchQuery !== debouncedSearchQuery
                          ? tr("입력 대기...", "Waiting for pause...")
                        : searchResults.length > 0
                          ? `${activeSearchResult ? clamp(activeSearchResultIndex, 0, searchResults.length - 1) + 1 : 0}/${searchResults.length}`
                          : normalizedSearchQuery.length > 0
                            ? tr("결과 없음", "No results")
                            : tr("검색어 입력", "Enter query")}
                    </span>
                    </>
                  ) : (
                    <span className="preview-selected-text" title={selectedPreviewText}>
                      {normalizeOutlineTitle(selectedPreviewText).length > 0
                        ? normalizeOutlineTitle(selectedPreviewText)
                        : tr("본문에서 텍스트 선택 또는 영역 드래그", "Select text or drag area in page body")}
                    </span>
                  )}
                </div>
                {isFileDragActive ? (
                  <div className="file-drop-hint">
                    {tr(
                      "PDF를 놓으면 열고, 이미지를 페이지 위에 놓으면 해당 위치에 배치합니다.",
                      "Drop a PDF to open it, or drop an image onto a page to place it there.",
                    )}
                  </div>
                ) : null}
                <div
                  className={`preview-page-stack ${previewSecondaryPageSize.width > 0 ? "spread" : ""}`}
                  style={previewStackStyle}
                >
                  <div
                    className="preview-page-slot"
                    ref={previewPrimarySlotRef}
                    style={{
                      width: `${previewPageSize.width}px`,
                      height: `${previewPageSize.height}px`,
                    }}
                  >
                    <canvas ref={previewCanvasRef} />
                    <PreviewTextLayer
                      spans={previewTextSpans}
                      isAreaSelectMode={isAreaSelectMode}
                      onMouseDown={handlePreviewTextLayerMouseDown}
                      activeSpanIndex={activeSearchSpanIndex}
                      matchedSpanIndexes={currentPageMatchedSpanIndexes}
                      normalizedSelectionRect={normalizedPreviewSelectionRect}
                      layerRef={previewTextLayerRef}
                    />
                    <div className="preview-overlay-layer">
                      {renderPreviewOverlayNodes(activePageOverlays, primaryPreviewViewportRef.current)}
                    </div>
                  </div>
                  {previewSecondaryPageSize.width > 0 ? (
                    <div
                      className="preview-page-slot secondary"
                      ref={previewSecondarySlotRef}
                      style={{
                        width: `${previewSecondaryPageSize.width}px`,
                        height: `${previewSecondaryPageSize.height}px`,
                      }}
                    >
                      <canvas ref={previewCanvasSecondaryRef} />
                      <div className="preview-overlay-layer">
                        {renderPreviewOverlayNodes(secondaryPageOverlays, secondaryPreviewViewportRef.current)}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-panel">{tr("선택한 페이지가 오른쪽에 크게 표시됩니다.", "Large page preview appears here.")}</div>
          )}
        </section>

        {showAiPanel ? (
          <Suspense fallback={<aside className="panel ai-panel"><div className="empty-panel">{tr("AI 패널 로딩 중...", "Loading AI panel...")}</div></aside>}>
            <AiChatPanel
              tr={tr}
              pdfDoc={pdfDoc}
              pdfBytes={pdfBytes}
              pdfPath={pdfPath}
              isBusy={isBusy}
              onJumpToCitation={handleJumpToAiCitation}
            />
          </Suspense>
        ) : null}
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

      <PdfInfoModal
        isOpen={showPdfInfoModal}
        tr={tr}
        activeTab={pdfInfoTab}
        onChangeTab={setPdfInfoTab}
        onClose={() => setShowPdfInfoModal(false)}
        isLoading={isLoadingPdfInfo}
        metadataFields={pdfInfoMetadataFields}
        fontNames={pdfInfoFontNames}
      />

      <PdfSecurityModal
        isOpen={securityModalMode !== null}
        tr={tr}
        mode={securityModalMode ?? "protect"}
        password={securityPassword}
        confirmPassword={securityConfirmPassword}
        errorText={securityModalError}
        isSubmitting={isSaving}
        onChangePassword={(value) => {
          setSecurityPassword(value);
          if (securityModalError) setSecurityModalError(null);
        }}
        onChangeConfirmPassword={(value) => {
          setSecurityConfirmPassword(value);
          if (securityModalError) setSecurityModalError(null);
        }}
        onClose={closePdfSecurityModal}
        onSubmit={() => {
          void submitPdfSecurityModal();
        }}
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
