import { invoke } from "@tauri-apps/api/core";

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
  return invoke<SettingsBundle>("load_app_settings");
}

export async function saveAppSettings(settings: Record<string, JsonValue>): Promise<void> {
  await invoke("save_app_settings", { request: { settings } });
}

export async function saveChatSession(documentId: string, messages: StoredChatMessage[]): Promise<ChatSessionResponse> {
  return invoke<ChatSessionResponse>("save_chat_session", { request: { documentId, messages } });
}

export async function loadChatSession(documentId: string): Promise<ChatSessionResponse | null> {
  return invoke<ChatSessionResponse | null>("load_chat_session", { request: { documentId } });
}

export async function deleteChatSession(documentId: string): Promise<void> {
  await invoke("delete_chat_session", { request: { documentId } });
}

export async function saveAiEndpoint(endpoint: AiEndpoint): Promise<AiEndpoint> {
  return invoke<AiEndpoint>("save_ai_endpoint", { endpoint });
}

export async function deleteAiEndpoint(endpointId: string): Promise<void> {
  await invoke("delete_ai_endpoint", { request: { endpointId } });
}

export async function testAiEndpoint(endpoint: AiEndpoint): Promise<EndpointTestResponse> {
  return invoke<EndpointTestResponse>("test_ai_endpoint", { endpoint });
}

export async function getEndpointModelCatalog(endpoint: AiEndpoint): Promise<EndpointModelCatalogResponse> {
  return invoke<EndpointModelCatalogResponse>("get_endpoint_model_catalog", { endpoint });
}

export async function indexPdfDocument(request: IndexPdfDocumentRequest): Promise<IndexPdfDocumentResponse> {
  return invoke<IndexPdfDocumentResponse>("index_pdf_document", { request });
}

export async function chatWithPdf(request: ChatWithPdfRequest): Promise<ChatWithPdfResponse> {
  return invoke<ChatWithPdfResponse>("chat_with_pdf", { request });
}

export async function compactChatHistory(request: CompactChatHistoryRequest): Promise<CompactChatHistoryResponse> {
  return invoke<CompactChatHistoryResponse>("compact_chat_history", { request });
}
