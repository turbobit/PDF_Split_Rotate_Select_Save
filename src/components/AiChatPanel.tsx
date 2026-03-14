import { type PDFDocumentProxy } from "pdfjs-dist";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { extractPdfChunks, sha256Hex } from "../app/ai-helpers";
import { formatError, normalizeFileStem } from "../app/app-helpers";
import {
  chatWithPdf,
  compactChatHistory,
  deleteChatSession,
  deleteAiEndpoint,
  getEndpointModelCatalog,
  indexPdfDocument,
  loadChatSession,
  loadAppSettings,
  saveAiEndpoint,
  saveAppSettings,
  saveChatSession,
  testAiEndpoint,
  type AiEndpoint,
  type ChatSessionResponse,
  type EndpointModelCatalogResponse,
  type AiProvider,
  type ChatMessagePayload,
  type EndpointTestResponse,
  type RetrievedSnippet,
  type StoredChatMessage,
  type ApiKeyStorage,
  type JsonValue,
} from "../app/settings-store";

type TranslateFn = (ko: string, en: string) => string;

type AiChatPanelProps = {
  tr: TranslateFn;
  pdfDoc: PDFDocumentProxy | null;
  pdfBytes: Uint8Array | null;
  pdfPath: string | null;
  isBusy: boolean;
  canPrepareIndex?: boolean;
  onJumpToCitation?: (snippet: RetrievedSnippet) => void;
};

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: RetrievedSnippet[];
  searchMode?: string;
  endpointLabel?: string;
  isError?: boolean;
};

type CachedIndexState = {
  documentId: string;
  title: string;
  chunkSignature: string;
  chunkCount: number;
  searchMode: string;
  vectorReady: boolean;
  lastIndexedAt?: string;
  reusedExisting: boolean;
};

type EndpointTestState = {
  status: "idle" | "testing" | "connected" | "failed";
  details: string;
};

type EndpointModelCatalogState = EndpointModelCatalogResponse;

const PROVIDERS: AiProvider[] = ["lmstudio", "ollama", "litellm", "openai", "anthropic", "gemini"];

function providerLabel(provider: AiProvider): string {
  switch (provider) {
    case "ollama":
      return "Ollama";
    case "litellm":
      return "LiteLLM";
    case "lmstudio":
      return "LM Studio";
    case "openai":
      return "ChatGPT / OpenAI";
    case "anthropic":
      return "Claude / Anthropic";
    case "gemini":
      return "Gemini";
    default:
      return provider;
  }
}

function buildEndpointPreset(provider: AiProvider): AiEndpoint {
  const suffix = Date.now().toString(36);
  switch (provider) {
    case "ollama":
      return {
        id: `ollama-${suffix}`,
        label: `Ollama ${suffix}`,
        provider,
        baseUrl: "http://127.0.0.1:11434",
        apiKey: null,
        hasApiKey: false,
        clearApiKey: false,
        chatModel: "",
        embeddingModel: "",
        enabled: false,
        isDefault: false,
        extraJson: { kind: "local", apiKeyStorage: "keychain" },
      };
    case "litellm":
      return {
        id: `litellm-${suffix}`,
        label: `LiteLLM ${suffix}`,
        provider,
        baseUrl: "http://127.0.0.1:4000/v1",
        apiKey: null,
        hasApiKey: false,
        clearApiKey: false,
        chatModel: "",
        embeddingModel: "",
        enabled: false,
        isDefault: false,
        extraJson: { kind: "local", apiKeyStorage: "keychain" },
      };
    case "lmstudio":
      return {
        id: `lmstudio-${suffix}`,
        label: `LM Studio ${suffix}`,
        provider,
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: null,
        hasApiKey: false,
        clearApiKey: false,
        chatModel: "",
        embeddingModel: "",
        enabled: false,
        isDefault: false,
        extraJson: { kind: "local", openaiCompatible: true, apiKeyStorage: "keychain" },
      };
    case "openai":
      return {
        id: `openai-${suffix}`,
        label: `OpenAI ${suffix}`,
        provider,
        baseUrl: "https://api.openai.com/v1",
        apiKey: null,
        hasApiKey: false,
        clearApiKey: false,
        chatModel: "gpt-4.1-mini",
        embeddingModel: "text-embedding-3-small",
        enabled: false,
        isDefault: false,
        extraJson: { kind: "cloud", apiKeyStorage: "keychain" },
      };
    case "anthropic":
      return {
        id: `anthropic-${suffix}`,
        label: `Claude ${suffix}`,
        provider,
        baseUrl: "https://api.anthropic.com",
        apiKey: null,
        hasApiKey: false,
        clearApiKey: false,
        chatModel: "claude-sonnet-4-20250514",
        embeddingModel: "",
        enabled: false,
        isDefault: false,
        extraJson: { kind: "cloud", bm25Only: true, apiKeyStorage: "keychain" },
      };
    case "gemini":
      return {
        id: `gemini-${suffix}`,
        label: `Gemini ${suffix}`,
        provider,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: null,
        hasApiKey: false,
        clearApiKey: false,
        chatModel: "gemini-2.5-flash",
        embeddingModel: "gemini-embedding-001",
        enabled: false,
        isDefault: false,
        extraJson: { kind: "cloud", apiKeyStorage: "keychain" },
      };
    default:
      return buildEndpointPreset("ollama");
  }
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function compactHomePath(path: string): string {
  if (!path) return path;
  const normalized = path.replace(/\\/g, "/");
  const withHome = normalized
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^([A-Za-z]:)\/Users\/[^/]+/, "~");
  if (withHome.length <= 34) return withHome;
  const segments = withHome.split("/").filter(Boolean);
  if (segments.length <= 2) return withHome;
  const tail = segments.slice(-2).join("/");
  const head = withHome.startsWith("~") ? "~/" : "";
  return `${head}.../${tail}`;
}

function supportsEmbeddings(provider: AiProvider): boolean {
  return provider !== "anthropic";
}

function readApiKeyStorage(extraJson: unknown): ApiKeyStorage {
  if (
    extraJson
    && typeof extraJson === "object"
    && !Array.isArray(extraJson)
    && (extraJson as Record<string, unknown>).apiKeyStorage === "database"
  ) {
    return "database";
  }
  return "keychain";
}

function withApiKeyStorage(extraJson: unknown, storage: ApiKeyStorage): { [key: string]: JsonValue } {
  if (extraJson && typeof extraJson === "object" && !Array.isArray(extraJson)) {
    return { ...(extraJson as { [key: string]: JsonValue }), apiKeyStorage: storage };
  }
  return { apiKeyStorage: storage };
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function buildConversationMarkdown(title: string, messages: StoredChatMessage[]): string {
  const lines = [`# ${title}`, ""];
  for (const message of messages) {
    const heading = message.role === "assistant" ? "## AI" : "## User";
    lines.push(heading, "", message.content.trim() || "-", "");
    if (message.citations.length > 0) {
      lines.push("### Citations", "");
      for (const citation of message.citations) {
        lines.push(`- p.${citation.pageNumber} ${citation.sources.join("+")} ${citation.content}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

function formatIndexedAt(value: string | undefined): string {
  if (!value) return "No record";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(typeof navigator !== "undefined" ? navigator.language : "en-US");
}

function normalizeAiMarkdown(input: string): string {
  if (!input) return input;
  return input
    .replace(
      /(?<=[\p{L}\p{N}\p{Script=Hangul}\p{Script=Han}])(\*\*[^*\n]+?\*\*)/gu,
      "&#8203;$1",
    )
    .replace(
      /(\*\*[^*\n]+?\*\*)(?=[\p{L}\p{N}\p{Script=Hangul}\p{Script=Han}])/gu,
      "$1&#8203;",
    )
    .replace(
      /\b(\d{4})-(\d{2})-(\d{2})(?=[^\d]|$)/g,
      "$1\\-$2\\-$3",
    );
}

function AiCodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const raw = String(children ?? "").replace(/\n$/, "");
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(raw);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [raw]);

  if (!className) {
    return <code>{children}</code>;
  }

  return (
    <span className="ai-code-block-wrap">
      <button className="ghost-btn micro-btn ai-code-copy-btn" type="button" onClick={() => void handleCopy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <code className={className}>{children}</code>
    </span>
  );
}

export default function AiChatPanel({
  tr,
  pdfDoc,
  pdfBytes,
  pdfPath,
  isBusy,
  canPrepareIndex = true,
  onJumpToCitation,
}: AiChatPanelProps) {
  const [databasePath, setDatabasePath] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [endpoints, setEndpoints] = useState<AiEndpoint[]>([]);
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexStatus, setIndexStatus] = useState("");
  const [indexState, setIndexState] = useState<CachedIndexState | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [savingEndpointId, setSavingEndpointId] = useState<string | null>(null);
  const [deletingEndpointId, setDeletingEndpointId] = useState<string | null>(null);
  const [testingEndpointId, setTestingEndpointId] = useState<string | null>(null);
  const [messageStatus, setMessageStatus] = useState<string | null>(null);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [loadedSessionDocumentId, setLoadedSessionDocumentId] = useState<string | null>(null);
  const [endpointTests, setEndpointTests] = useState<Record<string, EndpointTestState>>({});
  const [expandedEndpointIds, setExpandedEndpointIds] = useState<string[]>([]);
  const [endpointModelCatalogs, setEndpointModelCatalogs] = useState<Record<string, EndpointModelCatalogState>>({});
  const [loadingModelCatalogIds, setLoadingModelCatalogIds] = useState<string[]>([]);

  const extractedCacheRef = useRef<{
    documentId: string;
    title: string;
    chunkSignature: string;
    chunks: Awaited<ReturnType<typeof extractPdfChunks>>["chunks"];
  } | null>(null);
  const lastIndexKeyRef = useRef<string | null>(null);
  const messagesViewportRef = useRef<HTMLDivElement | null>(null);
  const endpointCardRefs = useRef<Record<string, HTMLElement | null>>({});

  const activeEndpoint = useMemo(
    () => endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? null,
    [endpoints, selectedEndpointId],
  );
  const compactDatabasePath = useMemo(
    () => compactHomePath(databasePath),
    [databasePath],
  );
  const indexStatusLabel = useMemo(() => {
    if (isIndexing) return tr("인덱싱 중", "Indexing");
    if (indexStatus.trim().length === 0) return tr("인덱스 대기", "Index idle");
    if (indexStatus.includes("BM25 +")) return tr("BM25+벡터 준비 완료 ?", "BM25+vector ready ?");
    if (indexStatus.includes("BM25")) return tr("BM25 준비 완료 ?", "BM25 ready ?");
    return indexStatus;
  }, [indexStatus, isIndexing, tr]);
  const indexStatusTooltip = useMemo(() => {
    const lines = [
      tr("문서 인덱스", "Document Index"),
      `${tr("상태", "Status")}: ${indexStatusLabel}`,
      `${tr("마지막", "Last")}: ${formatIndexedAt(indexState?.lastIndexedAt)}`,
      `${tr("재사용", "Reuse")}: ${
        indexState
          ? (indexState.reusedExisting
            ? tr("기존 인덱스 재사용", "Reused existing index")
            : tr("새로 생성됨", "Newly created"))
          : "-"
      }`,
      `${tr("검색 모드", "Search Mode")}: ${indexState?.searchMode ?? "-"}`,
      `${tr("청크 수", "Chunks")}: ${indexState?.chunkCount ?? 0}`,
      `${tr("선택 서비스", "Selected Service")}: ${activeEndpoint?.label ?? tr("없음", "None")}`,
    ];
    return lines.join("\n");
  }, [activeEndpoint?.label, indexState, indexStatusLabel, tr]);

  useEffect(() => {
    let cancelled = false;
    void loadAppSettings()
      .then((bundle) => {
        if (cancelled) return;
        const storedEndpointId = readString(bundle.settings["ai.selectedEndpointId"]);
        setDatabasePath(bundle.databasePath);
        setEndpoints(bundle.endpoints);
        setExpandedEndpointIds((previous) => {
          if (previous.length > 0) return previous;
          const initial = bundle.endpoints
            .filter((endpoint) => endpoint.isDefault || endpoint.id === storedEndpointId)
            .map((endpoint) => endpoint.id);
          return initial.length > 0 ? initial : bundle.endpoints.slice(0, 1).map((endpoint) => endpoint.id);
        });
        setAiEnabled(readBoolean(bundle.settings["ai.enabled"]) ?? false);
        const fallbackEndpoint = bundle.endpoints.find((endpoint) => endpoint.isDefault) ?? null;
        setSelectedEndpointId(storedEndpointId ?? fallbackEndpoint?.id ?? null);
        setSettingsLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setPanelError(`${tr("AI 설정 로딩 실패", "Failed to load AI settings")}: ${formatError(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [tr]);

  useEffect(() => {
    if (endpoints.length === 0) {
      setSelectedEndpointId(null);
      return;
    }
    if (selectedEndpointId && !endpoints.some((endpoint) => endpoint.id === selectedEndpointId)) {
      const fallback = endpoints.find((endpoint) => endpoint.isDefault) ?? null;
      setSelectedEndpointId(fallback?.id ?? null);
    }
  }, [endpoints, selectedEndpointId]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const timerId = window.setTimeout(() => {
      void saveAppSettings({
        "ai.enabled": aiEnabled,
        "ai.selectedEndpointId": selectedEndpointId ?? "",
      }).catch((error) => {
        setPanelError(`${tr("AI 설정 저장 실패", "Failed to save AI settings")}: ${formatError(error)}`);
      });
    }, 140);
    return () => window.clearTimeout(timerId);
  }, [aiEnabled, selectedEndpointId, settingsLoaded, tr]);

  useEffect(() => {
    if (!messagesViewportRef.current) return;
    messagesViewportRef.current.scrollTop = messagesViewportRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    extractedCacheRef.current = null;
    lastIndexKeyRef.current = null;
    setMessages([]);
    setDraft("");
    setIndexState(null);
    setMessageStatus(null);
    setCurrentDocumentId(null);
    setLoadedSessionDocumentId(null);
    if (!pdfBytes || !canPrepareIndex) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const documentId = await sha256Hex(pdfBytes);
        if (cancelled) return;
        setCurrentDocumentId(documentId);
        const session: ChatSessionResponse | null = await loadChatSession(documentId);
        if (cancelled) return;
        setMessages(session?.messages ?? []);
        setLoadedSessionDocumentId(documentId);
        if (session && session.messages.length > 0) {
          setMessageStatus(tr("최근 대화 세션을 복원했습니다.", "Restored the recent conversation session."));
        }
      } catch (error) {
        if (cancelled) return;
        setPanelError(`${tr("대화 세션 로딩 실패", "Failed to load chat session")}: ${formatError(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canPrepareIndex, pdfBytes, pdfPath, tr]);

  useEffect(() => {
    if (!currentDocumentId || loadedSessionDocumentId !== currentDocumentId) return;
    if (messages.length === 0) {
      void deleteChatSession(currentDocumentId).catch((error) => {
        setPanelError(`${tr("대화 세션 삭제 실패", "Failed to delete chat session")}: ${formatError(error)}`);
      });
      return;
    }
    void saveChatSession(currentDocumentId, messages).catch((error) => {
      setPanelError(`${tr("대화 세션 저장 실패", "Failed to save chat session")}: ${formatError(error)}`);
    });
  }, [currentDocumentId, loadedSessionDocumentId, messages, tr]);

  const prepareIndex = useCallback(async (forceRebuild = false) => {
    if (!aiEnabled) {
      setIndexState(null);
      setIndexStatus(tr("AI 기능이 꺼져 있습니다.", "AI features are turned off."));
      return false;
    }
    if (!canPrepareIndex) {
      setIndexStatus(tr("첫 페이지 표시 후 AI 인덱스를 준비합니다.", "AI index starts after the first page is shown."));
      return false;
    }
    if (!pdfDoc || !pdfBytes) {
      setIndexState(null);
      setIndexStatus(tr("PDF를 열면 AI 검색 인덱스를 준비합니다.", "Open a PDF to prepare the AI search index."));
      return false;
    }
    try {
      setIsIndexing(true);
      setPanelError(null);
      const documentId = await sha256Hex(pdfBytes);
      const title = normalizeFileStem(pdfPath ?? "document.pdf");
      let cached = extractedCacheRef.current;
      if (!cached || cached.documentId !== documentId) {
        setIndexStatus(tr("PDF 본문 추출 중...", "Extracting PDF text..."));
        const extracted = await extractPdfChunks(pdfDoc, (pageNumber, totalPages) => {
          setIndexStatus(
            tr(`PDF 본문 추출 중... ${pageNumber}/${totalPages}`, `Extracting PDF text... ${pageNumber}/${totalPages}`),
          );
        });
        cached = {
          documentId,
          title,
          chunkSignature: extracted.chunkSignature,
          chunks: extracted.chunks,
        };
        extractedCacheRef.current = cached;
      }

      const endpointId = activeEndpoint && activeEndpoint.enabled ? activeEndpoint.id : undefined;
      const serviceKind = activeEndpoint && activeEndpoint.enabled ? activeEndpoint.provider : "bm25";
      const indexKey = `${documentId}:${serviceKind}:${activeEndpoint?.embeddingModel ?? ""}`;
      if (!forceRebuild && lastIndexKeyRef.current === indexKey && indexState?.documentId === documentId) {
        return true;
      }

      setIndexStatus(
        forceRebuild
          ? tr("문서 인덱스 다시 생성 중...", "Rebuilding document index...")
          : tr("문서 인덱스 저장 중...", "Saving document index..."),
      );
      const response = await indexPdfDocument({
        documentId,
        fingerprint: documentId,
        title,
        path: pdfPath ?? undefined,
        chunkSignature: cached.chunkSignature,
        chunks: cached.chunks,
        endpointId,
        forceRebuild,
      });
      lastIndexKeyRef.current = indexKey;
      setIndexState({
        documentId,
        title,
        chunkSignature: cached.chunkSignature,
        chunkCount: cached.chunks.length,
        searchMode: response.searchMode,
        vectorReady: response.vectorReady,
        lastIndexedAt: response.lastIndexedAt,
        reusedExisting: response.reusedExisting,
      });
      setIndexStatus(
        response.vectorReady
          ? tr("BM25 + 벡터 인덱스 준비 완료", "BM25 + vector index ready")
          : tr("BM25 인덱스 준비 완료", "BM25 index ready"),
      );
      return true;
    } catch (error) {
      setIndexState(null);
      setPanelError(`${tr("AI 인덱스 준비 실패", "Failed to prepare AI index")}: ${formatError(error)}`);
      setIndexStatus(tr("AI 인덱스 준비 실패", "AI index preparation failed"));
      return false;
    } finally {
      setIsIndexing(false);
    }
  }, [activeEndpoint, aiEnabled, canPrepareIndex, indexState?.documentId, pdfBytes, pdfDoc, pdfPath, tr]);

  useEffect(() => {
    if (showSettings || !canPrepareIndex) return;
    let cancelled = false;
    void (async () => {
      const ok = await prepareIndex(false);
      if (cancelled || ok) return;
    })();

    return () => {
      cancelled = true;
    };
  }, [canPrepareIndex, prepareIndex, showSettings]);

  const updateEndpoint = useCallback((endpointId: string, patch: Partial<AiEndpoint>) => {
    setEndpoints((previous) => previous.map((endpoint) => (endpoint.id === endpointId ? { ...endpoint, ...patch } : endpoint)));
  }, []);

  const updateEndpointTestState = useCallback((endpointId: string, next: EndpointTestState) => {
    setEndpointTests((previous) => ({ ...previous, [endpointId]: next }));
  }, []);

  const loadEndpointModelCatalog = useCallback(async (endpointId: string, forceRefresh = false) => {
    if (!forceRefresh && endpointModelCatalogs[endpointId]) {
      return endpointModelCatalogs[endpointId];
    }
    const endpoint = endpoints.find((item) => item.id === endpointId);
    if (!endpoint) return null;
    setLoadingModelCatalogIds((previous) => (
      previous.includes(endpointId) ? previous : [...previous, endpointId]
    ));
    try {
      const catalog = await getEndpointModelCatalog(endpoint);
      setEndpointModelCatalogs((previous) => ({ ...previous, [endpointId]: catalog }));
      return catalog;
    } catch (error) {
      setPanelError(`${tr("모델 목록 조회 실패", "Failed to load model catalog")}: ${formatError(error)}`);
      return null;
    } finally {
      setLoadingModelCatalogIds((previous) => previous.filter((id) => id !== endpointId));
    }
  }, [endpointModelCatalogs, endpoints, tr]);

  const revealEndpointSettings = useCallback((endpointId: string, collapseOthers = false) => {
    setSelectedEndpointId(endpointId);
    setShowSettings(true);
    setExpandedEndpointIds((previous) => {
      if (collapseOthers) return [endpointId];
      return previous.includes(endpointId) ? previous : [...previous, endpointId];
    });
    window.requestAnimationFrame(() => {
      endpointCardRefs.current[endpointId]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  }, []);

  const toggleEndpointExpanded = useCallback((endpointId: string) => {
    setExpandedEndpointIds((previous) => (
      previous.includes(endpointId)
        ? previous.filter((id) => id !== endpointId)
        : [...previous, endpointId]
    ));
  }, []);

  const handleAddEndpoint = useCallback((provider: AiProvider) => {
    const next = buildEndpointPreset(provider);
    setEndpoints((previous) => [...previous, next]);
    revealEndpointSettings(next.id, true);
    updateEndpointTestState(next.id, {
      status: "idle",
      details: tr("저장 후 연결 테스트를 실행하세요.", "Save and run a connection test."),
    });
  }, [revealEndpointSettings, tr, updateEndpointTestState]);

  const handleSaveEndpoint = useCallback(async (endpointId: string) => {
    const endpoint = endpoints.find((item) => item.id === endpointId);
    if (!endpoint) return;
    try {
      setSavingEndpointId(endpointId);
      const saved = await saveAiEndpoint({
        ...endpoint,
        clearApiKey: endpoint.clearApiKey && !(endpoint.apiKey ?? "").trim(),
      });
      setEndpoints((previous) => previous.map((item) => (item.id === endpointId ? saved : item)));
      setSelectedEndpointId(saved.id);
      updateEndpointTestState(saved.id, {
        status: "idle",
        details: tr("저장됨. 연결 테스트로 상태를 확인하세요.", "Saved. Run a connection test to verify status."),
      });
      setEndpointModelCatalogs((previous) => {
        const next = { ...previous };
        delete next[saved.id];
        return next;
      });
      setMessageStatus(tr("AI 엔드포인트를 저장했습니다.", "Saved AI endpoint."));
    } catch (error) {
      setPanelError(`${tr("AI 엔드포인트 저장 실패", "Failed to save AI endpoint")}: ${formatError(error)}`);
    } finally {
      setSavingEndpointId(null);
    }
  }, [endpoints, tr, updateEndpointTestState]);

  const handleDeleteEndpoint = useCallback(async (endpointId: string) => {
    try {
      setDeletingEndpointId(endpointId);
      await deleteAiEndpoint(endpointId);
      setEndpoints((previous) => previous.filter((endpoint) => endpoint.id !== endpointId));
      setExpandedEndpointIds((previous) => previous.filter((id) => id !== endpointId));
      setEndpointModelCatalogs((previous) => {
        const next = { ...previous };
        delete next[endpointId];
        return next;
      });
      if (selectedEndpointId === endpointId) {
        setSelectedEndpointId(null);
      }
      setEndpointTests((previous) => {
        const next = { ...previous };
        delete next[endpointId];
        return next;
      });
      setMessageStatus(tr("AI 엔드포인트를 삭제했습니다.", "Deleted AI endpoint."));
    } catch (error) {
      setPanelError(`${tr("AI 엔드포인트 삭제 실패", "Failed to delete AI endpoint")}: ${formatError(error)}`);
    } finally {
      setDeletingEndpointId(null);
    }
  }, [selectedEndpointId, tr]);

  const handleClearApiKey = useCallback((endpointId: string) => {
    updateEndpoint(endpointId, { apiKey: null, hasApiKey: false, clearApiKey: true });
    const endpoint = endpoints.find((item) => item.id === endpointId);
    const storage = readApiKeyStorage(endpoint?.extraJson);
    updateEndpointTestState(endpointId, {
      status: "idle",
      details: storage === "database"
        ? tr("저장하면 SQLite DB에서 API 키를 제거합니다.", "Save to remove the API key from SQLite.")
        : tr("저장하면 OS 키체인에서 API 키를 제거합니다.", "Save to remove the API key from the OS keychain."),
    });
  }, [endpoints, tr, updateEndpoint, updateEndpointTestState]);

  const handleTestEndpoint = useCallback(async (endpointId: string) => {
    const endpoint = endpoints.find((item) => item.id === endpointId);
    if (!endpoint) return;
    try {
      setTestingEndpointId(endpointId);
      updateEndpointTestState(endpointId, {
        status: "testing",
        details: tr("연결 및 모델 응답 확인 중...", "Checking connection and model responses..."),
      });
      const response: EndpointTestResponse = await testAiEndpoint(endpoint);
      updateEndpoint(endpointId, { hasApiKey: response.hasApiKey, clearApiKey: false, apiKey: null });
      updateEndpointTestState(endpointId, {
        status: response.ok ? "connected" : "failed",
        details: response.details,
      });
      setMessageStatus(tr("엔드포인트 연결 확인이 완료되었습니다.", "Endpoint connection check completed."));
    } catch (error) {
      updateEndpointTestState(endpointId, {
        status: "failed",
        details: formatError(error),
      });
      setPanelError(`${tr("엔드포인트 테스트 실패", "Endpoint test failed")}: ${formatError(error)}`);
    } finally {
      setTestingEndpointId(null);
    }
  }, [endpoints, tr, updateEndpoint, updateEndpointTestState]);

  const chatDisabledReason = useMemo(() => {
    if (!aiEnabled) return tr("상단 ON 스위치를 켜세요.", "Turn the AI switch on.");
    if (!pdfDoc || !pdfBytes) return tr("먼저 PDF를 여세요.", "Open a PDF first.");
    if (!activeEndpoint) return tr("AI 엔드포인트를 선택하세요.", "Choose an AI endpoint.");
    if (!activeEndpoint.enabled) return tr("선택한 엔드포인트가 비활성화되어 있습니다.", "Selected endpoint is disabled.");
    if (activeEndpoint.chatModel.trim().length === 0) return tr("채팅 모델 이름을 설정하세요.", "Set a chat model name.");
    if (!canPrepareIndex) return tr("첫 페이지 표시가 끝나면 AI 인덱스를 준비합니다.", "AI index starts after the first page is shown.");
    if (isIndexing) return tr("문서 인덱스를 준비 중입니다.", "Document index is still being prepared.");
    if (!indexState?.documentId) return tr("문서 인덱스가 아직 없습니다.", "Document index is not ready yet.");
    if (isBusy) return tr("PDF 작업이 끝난 뒤 다시 시도하세요.", "Try again after the PDF task finishes.");
    return null;
  }, [activeEndpoint, aiEnabled, canPrepareIndex, indexState?.documentId, isBusy, isIndexing, pdfBytes, pdfDoc, tr]);

  const registeredEndpoints = useMemo(
    () => [...endpoints].sort((left, right) => {
      if (left.id === "lmstudio-local" && right.id !== "lmstudio-local") return -1;
      if (right.id === "lmstudio-local" && left.id !== "lmstudio-local") return 1;
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      return left.label.localeCompare(right.label);
    }),
    [endpoints],
  );

  const handleSend = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || chatDisabledReason || !activeEndpoint || !indexState) return;

    const history: ChatMessagePayload[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const userEntry: UiMessage = {
      id: createMessageId(),
      role: "user",
      content: trimmed,
      citations: [],
    };

    setDraft("");
    setMessages((previous) => [...previous, userEntry]);
    setIsSending(true);
    setPanelError(null);
    setMessageStatus(null);

    try {
      const response = await chatWithPdf({
        documentId: indexState.documentId,
        endpointId: activeEndpoint.id,
        userMessage: trimmed,
        history,
        documentTitle: indexState.title,
      });
      setMessages((previous) => [
        ...previous,
        {
          id: createMessageId(),
          role: "assistant",
          content: response.content,
          citations: response.citations,
          searchMode: response.searchMode,
          endpointLabel: response.endpointLabel,
        },
      ]);
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          id: createMessageId(),
          role: "assistant",
          content: `${tr("AI 응답 실패", "AI response failed")}: ${formatError(error)}`,
          citations: [],
          endpointLabel: activeEndpoint.label,
          isError: true,
        },
      ]);
    } finally {
      setIsSending(false);
    }
  }, [activeEndpoint, chatDisabledReason, draft, indexState, messages, tr]);

  const handleDraftKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleExportConversation = useCallback(async () => {
    if (messages.length === 0) return;
    try {
      const title = normalizeFileStem(pdfPath ?? "conversation.md");
      const targetPath = await save({
        title: tr("대화 내보내기", "Export conversation"),
        defaultPath: `${title}_ai_chat.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!targetPath) return;
      const markdown = buildConversationMarkdown(title, messages);
      await writeFile(targetPath, new TextEncoder().encode(markdown));
      setMessageStatus(tr("대화를 Markdown으로 내보냈습니다.", "Exported the conversation as Markdown."));
    } catch (error) {
      setPanelError(`${tr("대화 내보내기 실패", "Failed to export conversation")}: ${formatError(error)}`);
    }
  }, [messages, pdfPath, tr]);

  const handleDeleteConversation = useCallback(async () => {
    if (!currentDocumentId) return;
    try {
      const confirmed = await ask(
        tr("현재 PDF의 저장된 대화 세션과 화면의 대화를 모두 삭제할까요?", "Delete the saved and visible conversation for this PDF?"),
        { title: tr("대화 삭제", "Delete conversation") },
      );
      if (!confirmed) return;
      await deleteChatSession(currentDocumentId);
      setMessages([]);
      setMessageStatus(tr("대화 세션을 삭제했습니다.", "Deleted the conversation session."));
    } catch (error) {
      setPanelError(`${tr("대화 세션 삭제 실패", "Failed to delete chat session")}: ${formatError(error)}`);
    }
  }, [currentDocumentId, tr]);

  const handleCompactConversation = useCallback(async () => {
    if (!activeEndpoint) return;
    if (messages.length <= 6) {
      setMessageStatus(tr("대화가 아직 짧아서 compact할 내용이 없습니다.", "The conversation is already short enough."));
      return;
    }

    try {
      setIsCompacting(true);
      setPanelError(null);
      setMessageStatus(null);
      const response = await compactChatHistory({
        endpoint: activeEndpoint,
        documentTitle: indexState?.title,
        messages,
      });
      const keptRecentCount = Math.max(0, response.keptRecentCount);
      const recentMessages = messages.slice(-keptRecentCount);
      const summaryEntry: UiMessage = {
        id: createMessageId(),
        role: "assistant",
        content: `## ${tr("대화 요약", "Conversation Summary")}\n\n${response.content.trim()}`,
        citations: [],
        endpointLabel: response.endpointLabel,
      };
      setMessages([summaryEntry, ...recentMessages]);
      setMessageStatus(
        tr(
          `이전 대화 ${response.compactedCount}개를 요약 1개로 compact했습니다.`,
          `Compacted ${response.compactedCount} earlier messages into one summary.`,
        ),
      );
    } catch (error) {
      setPanelError(`${tr("대화 compact 실패", "Failed to compact conversation")}: ${formatError(error)}`);
    } finally {
      setIsCompacting(false);
    }
  }, [activeEndpoint, indexState?.title, messages, tr]);

  return (
    <aside className="panel ai-panel">
      <div className="ai-panel-head">
        <div className="ai-panel-head-meta">
          <div className="ai-panel-head-title-row">
            <strong>{tr("AI대화", "AI Chat")}</strong>
            <span
              className={`ai-index-pill ${isIndexing ? "busy" : ""}`}
              title={indexStatusTooltip}
              aria-label={indexStatusTooltip}
            >
              {indexStatusLabel}
            </span>
          </div>
          <p>{compactDatabasePath || tr("SQLite 설정 DB 준비중...", "Preparing SQLite settings DB...")}</p>
        </div>
        <label className="ai-power-toggle">
          <span>{aiEnabled ? "ON" : "OFF"}</span>
          <input
            type="checkbox"
            checked={aiEnabled}
            onChange={(event) => setAiEnabled(event.currentTarget.checked)}
          />
        </label>
      </div>

      <div className="ai-toolbar-row">
        <label className="inline-field ai-endpoint-select">
          <span>{tr("서비스", "Service")}</span>
          <select
            value={selectedEndpointId ?? ""}
            onChange={(event) => {
              const endpointId = event.currentTarget.value || null;
              if (!endpointId) {
                setSelectedEndpointId(null);
                return;
              }
              revealEndpointSettings(endpointId, true);
            }}
            disabled={endpoints.length === 0}
          >
            {endpoints.length === 0 ? <option value="">{tr("없음", "None")}</option> : null}
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`ghost-btn micro-btn ${showSettings ? "tab-active" : ""}`}
          type="button"
          onClick={() => setShowSettings((previous) => !previous)}
        >
          {showSettings ? tr("설정닫기", "Hide Settings") : tr("AI설정", "AI Settings")}
        </button>
        <button
          className="ghost-btn micro-btn"
          type="button"
          onClick={() => void handleCompactConversation()}
          disabled={messages.length === 0 || !activeEndpoint || isCompacting || isSending}
        >
          {isCompacting ? tr("Compact중", "Compacting") : "Compact"}
        </button>
        <button
          className="ghost-btn micro-btn"
          type="button"
          onClick={() => void handleExportConversation()}
          disabled={messages.length === 0}
        >
          {tr("내보내기", "Export")}
        </button>
        <button
          className="ghost-btn micro-btn danger-btn"
          type="button"
          onClick={() => void handleDeleteConversation()}
          disabled={!currentDocumentId}
        >
          {tr("대화삭제", "Delete Chat")}
        </button>
      </div>

      {showSettings ? (
        <div className="ai-settings-panel">
          <div className="ai-settings-section-head">
            <strong>{tr("기본 서비스", "Default Services")}</strong>
            <span>{tr("LM Studio 포함", "Includes LM Studio")}</span>
          </div>
          <div className="ai-settings-add-row">
            {PROVIDERS.map((provider) => (
              <button
                key={provider}
                className="ghost-btn micro-btn"
                type="button"
                onClick={() => handleAddEndpoint(provider)}
              >
                + {providerLabel(provider)}
              </button>
            ))}
          </div>
          <div className="ai-settings-section-head">
            <strong>{tr("등록된 서비스", "Registered Services")}</strong>
            <span>{registeredEndpoints.length}</span>
          </div>
          <div className="ai-endpoint-list">
            {registeredEndpoints.map((endpoint) => {
              const isExpanded = expandedEndpointIds.includes(endpoint.id);
              const modelCatalog = endpointModelCatalogs[endpoint.id];
              const isLoadingModels = loadingModelCatalogIds.includes(endpoint.id);
              return (
              <article
                key={endpoint.id}
                className={`ai-endpoint-card ${selectedEndpointId === endpoint.id ? "selected" : ""}`}
                ref={(element) => {
                  endpointCardRefs.current[endpoint.id] = element;
                }}
              >
                <div className="ai-endpoint-card-head">
                  <button
                    className="ai-endpoint-summary"
                    type="button"
                    onClick={() => toggleEndpointExpanded(endpoint.id)}
                  >
                    <span className="ai-endpoint-summary-main">
                      <strong>{endpoint.label || providerLabel(endpoint.provider)}</strong>
                      <span className="ai-endpoint-meta">
                        {endpoint.isDefault ? tr("기본", "Default") : tr("등록됨", "Saved")}
                        {" · "}
                        {endpoint.enabled ? tr("활성", "Enabled") : tr("비활성", "Disabled")}
                        {" · "}
                        {providerLabel(endpoint.provider)}
                      </span>
                    </span>
                    <span className="ai-endpoint-summary-side">
                      <span className="ai-endpoint-capability">
                        {supportsEmbeddings(endpoint.provider) ? "BM25+Vec" : "BM25"}
                      </span>
                      <span className="ai-endpoint-chevron" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
                    </span>
                  </button>
                  <div className="ai-endpoint-head-actions">
                    <span className={`ai-endpoint-test-pill ${(endpointTests[endpoint.id]?.status ?? "idle")}`}>
                      {endpointTests[endpoint.id]?.status === "connected"
                        ? tr("연결됨", "Connected")
                        : endpointTests[endpoint.id]?.status === "failed"
                          ? tr("실패", "Failed")
                          : endpointTests[endpoint.id]?.status === "testing"
                            ? tr("확인중", "Testing")
                            : tr("미확인", "Unchecked")}
                    </span>
                    <button
                      className="ghost-btn micro-btn danger-btn"
                      type="button"
                      onClick={() => void handleDeleteEndpoint(endpoint.id)}
                      disabled={deletingEndpointId === endpoint.id}
                      title={tr("이 서비스를 삭제합니다.", "Delete this service.")}
                    >
                      {deletingEndpointId === endpoint.id ? tr("삭제중", "Deleting") : tr("삭제", "Delete")}
                    </button>
                  </div>
                </div>
                {isExpanded ? (
                  <>
                <label className="ai-field-grid">
                  <span>{tr("표시이름", "Label")}</span>
                  <input
                    value={endpoint.label}
                    onChange={(event) => updateEndpoint(endpoint.id, { label: event.currentTarget.value })}
                  />
                </label>
                <label className="ai-field-grid">
                  <span>{tr("공급자", "Provider")}</span>
                  <select
                    value={endpoint.provider}
                    onChange={(event) => updateEndpoint(endpoint.id, { provider: event.currentTarget.value as AiProvider })}
                  >
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>{providerLabel(provider)}</option>
                    ))}
                  </select>
                </label>
                <label className="ai-field-grid">
                  <span>{tr("기본 URL", "Base URL")}</span>
                  <input
                    value={endpoint.baseUrl}
                    onChange={(event) => updateEndpoint(endpoint.id, { baseUrl: event.currentTarget.value })}
                  />
                </label>
                <label className="ai-field-grid">
                  <span>{tr("API 키", "API Key")}</span>
                  <div className="ai-secret-field">
                    <select
                      value={readApiKeyStorage(endpoint.extraJson)}
                      onChange={(event) => updateEndpoint(endpoint.id, {
                        extraJson: withApiKeyStorage(endpoint.extraJson, event.currentTarget.value as ApiKeyStorage),
                        clearApiKey: false,
                      })}
                    >
                      <option value="keychain">{tr("OS 키체인", "OS Keychain")}</option>
                      <option value="database">{tr("SQLite DB", "SQLite DB")}</option>
                    </select>
                    <input
                      type="password"
                      value={endpoint.apiKey ?? ""}
                      onChange={(event) => updateEndpoint(endpoint.id, {
                        apiKey: event.currentTarget.value || null,
                        clearApiKey: false,
                      })}
                      placeholder={endpoint.hasApiKey
                        ? tr("새 키를 입력하면 교체", "Enter a new key to replace the stored one")
                        : tr("없으면 비워둠", "Leave blank if not needed")}
                    />
                    <div className="ai-secret-meta">
                      <span>
                        {endpoint.hasApiKey
                          ? (readApiKeyStorage(endpoint.extraJson) === "database"
                            ? tr("SQLite DB에 저장됨", "Stored in SQLite DB")
                            : tr("OS 키체인에 저장됨", "Stored in OS keychain"))
                          : tr("저장된 키 없음", "No stored key")}
                      </span>
                      <button
                        className="ghost-btn micro-btn"
                        type="button"
                        onClick={() => handleClearApiKey(endpoint.id)}
                        disabled={!endpoint.hasApiKey && !(endpoint.apiKey ?? "").trim()}
                      >
                        {tr("키 제거", "Clear Key")}
                      </button>
                    </div>
                  </div>
                </label>
                <label className="ai-field-grid">
                  <span className="ai-field-row">
                    <span>{tr("채팅 모델", "Chat Model")}</span>
                    <button
                      className="ghost-btn micro-btn"
                      type="button"
                      onClick={() => void loadEndpointModelCatalog(endpoint.id, true)}
                      disabled={isLoadingModels}
                    >
                      {isLoadingModels ? tr("불러오는중", "Loading") : tr("모델목록", "Models")}
                    </button>
                  </span>
                  <select
                    value={endpoint.chatModel}
                    onFocus={() => void loadEndpointModelCatalog(endpoint.id)}
                    onChange={(event) => updateEndpoint(endpoint.id, { chatModel: event.currentTarget.value })}
                  >
                    <option value="">{tr("직접 입력 또는 선택", "Type manually or select")}</option>
                    {(modelCatalog?.chatModels ?? []).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                  <input
                    value={endpoint.chatModel}
                    onFocus={() => void loadEndpointModelCatalog(endpoint.id)}
                    onChange={(event) => updateEndpoint(endpoint.id, { chatModel: event.currentTarget.value })}
                    placeholder={tr("직접 입력도 가능", "Manual entry is also supported")}
                    list={`chat-models-${endpoint.id}`}
                  />
                  <datalist id={`chat-models-${endpoint.id}`}>
                    {(modelCatalog?.chatModels ?? []).map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <span className="ai-model-meta">
                    {modelCatalog
                      ? modelCatalog.fetchedChat
                        ? tr(`지원 모델 ${modelCatalog.chatModels.length}개`, `${modelCatalog.chatModels.length} supported models`)
                        : tr("원격 조회 실패, 폴백 목록 사용 중", "Remote lookup unavailable, using fallback list")
                      : tr("모델목록 버튼이나 입력 포커스로 목록을 불러옵니다.", "Load the model list with the button or by focusing the field.")}
                  </span>
                </label>
                <label className="ai-field-grid">
                  <span className="ai-field-row">
                    <span>{tr("임베딩 모델", "Embedding Model")}</span>
                    <button
                      className="ghost-btn micro-btn"
                      type="button"
                      onClick={() => void loadEndpointModelCatalog(endpoint.id, true)}
                      disabled={!supportsEmbeddings(endpoint.provider) || isLoadingModels}
                    >
                      {isLoadingModels ? tr("불러오는중", "Loading") : tr("모델목록", "Models")}
                    </button>
                  </span>
                  <select
                    value={endpoint.embeddingModel}
                    onFocus={() => void loadEndpointModelCatalog(endpoint.id)}
                    onChange={(event) => updateEndpoint(endpoint.id, { embeddingModel: event.currentTarget.value })}
                    disabled={!supportsEmbeddings(endpoint.provider)}
                  >
                    <option value="">
                      {supportsEmbeddings(endpoint.provider)
                        ? tr("직접 입력 또는 선택", "Type manually or select")
                        : tr("Claude는 현재 BM25 전용", "Claude currently uses BM25 only")}
                    </option>
                    {(modelCatalog?.embeddingModels ?? []).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                  <input
                    value={endpoint.embeddingModel}
                    onFocus={() => void loadEndpointModelCatalog(endpoint.id)}
                    onChange={(event) => updateEndpoint(endpoint.id, { embeddingModel: event.currentTarget.value })}
                    placeholder={supportsEmbeddings(endpoint.provider) ? tr("직접 입력도 가능", "Manual entry is also supported") : tr("Claude는 현재 BM25 전용", "Claude currently uses BM25 only")}
                    disabled={!supportsEmbeddings(endpoint.provider)}
                    list={`embedding-models-${endpoint.id}`}
                  />
                  <datalist id={`embedding-models-${endpoint.id}`}>
                    {(modelCatalog?.embeddingModels ?? []).map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <span className="ai-model-meta">
                    {!supportsEmbeddings(endpoint.provider)
                      ? tr("이 공급자는 현재 임베딩 어댑터가 없습니다.", "This provider currently has no embedding adapter.")
                      : modelCatalog
                        ? modelCatalog.fetchedEmbeddings
                          ? tr(`지원 모델 ${modelCatalog.embeddingModels.length}개`, `${modelCatalog.embeddingModels.length} supported models`)
                          : tr("원격 조회 실패, 폴백 목록 사용 중", "Remote lookup unavailable, using fallback list")
                        : tr("모델목록 버튼이나 입력 포커스로 목록을 불러옵니다.", "Load the model list with the button or by focusing the field.")}
                  </span>
                </label>
                <div className="ai-endpoint-toggle-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={endpoint.enabled}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        updateEndpoint(endpoint.id, { enabled: checked });
                      }}
                    />
                    {tr("활성", "Enabled")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={endpoint.isDefault}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setEndpoints((previous) => previous.map((item) => ({
                          ...item,
                          isDefault: item.id === endpoint.id ? checked : false,
                        })));
                      }}
                    />
                    {tr("기본", "Default")}
                  </label>
                </div>
                <div className="ai-endpoint-actions">
                  <button
                    className="ghost-btn micro-btn"
                    type="button"
                    onClick={() => void handleTestEndpoint(endpoint.id)}
                    disabled={testingEndpointId === endpoint.id}
                  >
                    {testingEndpointId === endpoint.id ? tr("테스트중", "Testing") : tr("연결테스트", "Test")}
                  </button>
                  <button
                    className="primary-btn micro-btn"
                    type="button"
                    onClick={() => void handleSaveEndpoint(endpoint.id)}
                    disabled={savingEndpointId === endpoint.id}
                  >
                    {savingEndpointId === endpoint.id ? tr("저장중", "Saving") : tr("저장", "Save")}
                  </button>
                </div>
                {endpointTests[endpoint.id]?.details ? (
                  <div className="ai-inline-note">
                    {endpointTests[endpoint.id]?.details}
                  </div>
                ) : null}
                  </>
                ) : null}
              </article>
            );
            })}
          </div>
        </div>
      ) : null}

      {panelError ? <div className="panel error-banner ai-error-banner">{panelError}</div> : null}
      {messageStatus ? <div className="ai-inline-note">{messageStatus}</div> : null}

      {!aiEnabled ? (
        <div className="empty-panel">{tr("상단 스위치를 OFF로 두면 인덱싱과 AI 호출이 모두 멈춥니다.", "When the top switch is OFF, indexing and AI calls stop.")}</div>
      ) : !pdfDoc ? (
        <div className="empty-panel">{tr("열린 PDF가 있어야 AI 대화를 시작할 수 있습니다.", "Open a PDF to start AI chat.")}</div>
      ) : (
        <>
          <div className="ai-message-list" ref={messagesViewportRef}>
            {messages.length === 0 ? (
              <div className="empty-panel ai-empty-chat">
                {tr("질문을 입력하면 현재 열린 PDF의 텍스트를 BM25/벡터 검색으로 찾아 답합니다.", "Ask a question and the app answers from the current PDF using BM25/vector retrieval.")}
              </div>
            ) : null}
            {messages.map((message) => (
              <article
                key={message.id}
                className={`ai-message ${message.role === "assistant" ? "assistant" : "user"} ${message.isError ? "error" : ""}`}
              >
                <header>
                  <strong>{message.role === "assistant" ? (message.endpointLabel ?? tr("AI응답", "AI")) : tr("나", "You")}</strong>
                  {message.searchMode ? <span>{message.searchMode}</span> : null}
                </header>
                <div className="ai-markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ className, children }: { className?: string; children?: React.ReactNode }) {
                        return <AiCodeBlock className={className} children={children} />;
                      },
                    }}
                  >
                    {normalizeAiMarkdown(message.content)}
                  </ReactMarkdown>
                </div>
                {message.citations.length > 0 ? (
                  <div className="ai-citation-list">
                    {message.citations.slice(0, 4).map((snippet) => (
                      <button
                        key={`${message.id}-${snippet.chunkId}`}
                        className="ai-citation-chip"
                        type="button"
                        onClick={() => onJumpToCitation?.(snippet)}
                      >
                        <span>{`p.${snippet.pageNumber}`}</span>
                        <span>{snippet.sources.join("+")}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          <div className="ai-compose-box">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={handleDraftKeyDown}
              placeholder={tr("현재 PDF 내용에 대해 질문하세요.", "Ask about the current PDF.")}
              disabled={Boolean(chatDisabledReason) || isSending}
            />
            <div className="ai-compose-actions">
              <span>{chatDisabledReason ?? (isSending ? tr("응답 생성 중...", "Generating answer...") : tr("준비 완료", "Ready"))}</span>
              <button
                className="primary-btn"
                type="button"
                onClick={() => void handleSend()}
                disabled={Boolean(chatDisabledReason) || isSending || draft.trim().length === 0}
              >
                {isSending ? tr("전송중", "Sending") : tr("전송", "Send")}
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
