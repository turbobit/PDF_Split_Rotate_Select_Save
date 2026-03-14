import { invoke } from "@tauri-apps/api/core";

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

function createEmptySettingsBundle(): SettingsBundle {
  return {
    settings: {},
    endpoints: [],
    configDir: "",
    databasePath: "",
  };
}

function isMissingTauriRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("__TAURI_INTERNALS__")
    || message.includes("__TAURI__")
    || message.includes("webview")
    || message.includes("not supported in this environment")
    || message.includes("Cannot read properties of undefined");
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AiProvider = "ollama" | "litellm" | "lmstudio" | "openai" | "anthropic" | "gemini";
export type ApiKeyStorage = "keychain" | "database";

export type AiEndpoint = {
  id: string;
  label: string;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string | null;
  hasApiKey: boolean;
  clearApiKey: boolean;
  chatModel: string;
  embeddingModel: string;
  enabled: boolean;
  isDefault: boolean;
  extraJson: JsonValue;
};

export type SettingsBundle = {
  settings: Record<string, JsonValue>;
  endpoints: AiEndpoint[];
  configDir: string;
  databasePath: string;
};

export type PdfChunkInput = {
  chunkId: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
};

export type IndexPdfDocumentRequest = {
  documentId: string;
  fingerprint: string;
  title: string;
  path?: string;
  chunkSignature: string;
  chunks: PdfChunkInput[];
  endpointId?: string;
  forceRebuild?: boolean;
};

export type IndexPdfDocumentResponse = {
  documentId: string;
  storedChunks: number;
  textUpdated: boolean;
  embeddingsUpdated: boolean;
  vectorReady: boolean;
  vectorDimensions?: number;
  searchMode: string;
  lastIndexedAt?: string;
  reusedExisting: boolean;
  databasePath: string;
};

export type ChatMessagePayload = {
  role: "user" | "assistant";
  content: string;
};

export type RetrievedSnippet = {
  chunkId: string;
  pageNumber: number;
  chunkIndex: number;
  content: string;
  score: number;
  sources: string[];
};

export type ChatWithPdfRequest = {
  documentId: string;
  endpointId: string;
  userMessage: string;
  history: ChatMessagePayload[];
  documentTitle?: string;
};

export type ChatWithPdfResponse = {
  content: string;
  citations: RetrievedSnippet[];
  searchMode: string;
  endpointLabel: string;
};

export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: RetrievedSnippet[];
  searchMode?: string;
  endpointLabel?: string;
  isError?: boolean;
};

export type ChatSessionResponse = {
  documentId: string;
  messages: StoredChatMessage[];
  updatedAt: string;
};

export type CompactChatHistoryRequest = {
  endpoint: AiEndpoint;
  documentTitle?: string;
  messages: StoredChatMessage[];
};

export type CompactChatHistoryResponse = {
  content: string;
  endpointLabel: string;
  compactedCount: number;
  keptRecentCount: number;
};

export type EndpointTestResponse = {
  ok: boolean;
  status: string;
  details: string;
  checkedChat: boolean;
  checkedEmbeddings: boolean;
  hasApiKey: boolean;
};

export type EndpointModelCatalogResponse = {
  provider: AiProvider;
  chatModels: string[];
  embeddingModels: string[];
  fetchedChat: boolean;
  fetchedEmbeddings: boolean;
  usedFallbackChat: boolean;
  usedFallbackEmbeddings: boolean;
};

export async function loadAppSettings(): Promise<SettingsBundle> {
  if (typeof window === "undefined") return createEmptySettingsBundle();
  try {
    return await invoke<SettingsBundle>("load_app_settings");
  } catch (error) {
    if (isMissingTauriRuntimeError(error)) return createEmptySettingsBundle();
    throw error;
  }
}

export async function saveAppSettings(settings: Record<string, JsonValue>): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await invoke("save_app_settings", { request: { settings } });
  } catch (error) {
    if (isMissingTauriRuntimeError(error)) return;
    throw error;
  }
}

export async function saveChatSession(documentId: string, messages: StoredChatMessage[]): Promise<ChatSessionResponse> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("Chat sessions are not supported in web mode");
  }
  return invoke<ChatSessionResponse>("save_chat_session", { request: { documentId, messages } });
}

export async function loadChatSession(documentId: string): Promise<ChatSessionResponse | null> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<ChatSessionResponse | null>("load_chat_session", { request: { documentId } });
}

export async function deleteChatSession(documentId: string): Promise<void> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("delete_chat_session", { request: { documentId } });
}

export async function saveAiEndpoint(endpoint: AiEndpoint): Promise<AiEndpoint> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("AI endpoints are not supported in web mode");
  }
  return invoke<AiEndpoint>("save_ai_endpoint", { endpoint });
}

export async function deleteAiEndpoint(endpointId: string): Promise<void> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("delete_ai_endpoint", { request: { endpointId } });
}

export async function testAiEndpoint(endpoint: AiEndpoint): Promise<EndpointTestResponse> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("AI endpoint testing is not supported in web mode");
  }
  return invoke<EndpointTestResponse>("test_ai_endpoint", { endpoint });
}

export async function getEndpointModelCatalog(endpoint: AiEndpoint): Promise<EndpointModelCatalogResponse> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("Model catalog is not supported in web mode");
  }
  return invoke<EndpointModelCatalogResponse>("get_endpoint_model_catalog", { endpoint });
}

export async function indexPdfDocument(request: IndexPdfDocumentRequest): Promise<IndexPdfDocumentResponse> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("PDF indexing is not supported in web mode");
  }
  return invoke<IndexPdfDocumentResponse>("index_pdf_document", { request });
}

export async function chatWithPdf(request: ChatWithPdfRequest): Promise<ChatWithPdfResponse> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("PDF chat is not supported in web mode");
  }
  return invoke<ChatWithPdfResponse>("chat_with_pdf", { request });
}

export async function compactChatHistory(request: CompactChatHistoryRequest): Promise<CompactChatHistoryResponse> {
  // 로컬 웹 모드에서는 지원하지 않음
  if (!isTauriRuntime()) {
    throw new Error("Chat history compaction is not supported in web mode");
  }
  return invoke<CompactChatHistoryResponse>("compact_chat_history", { request });
}
