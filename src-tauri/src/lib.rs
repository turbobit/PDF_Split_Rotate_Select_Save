use anyhow::{anyhow, Context};
use chrono::Utc;
use keyring_core::{Entry, Error as KeyringError};
use lopdf::encryption::{EncryptionState, EncryptionVersion, Permissions};
use lopdf::Document as LoDocument;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use rusqlite::ffi::sqlite3_auto_extension;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, Once};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri::{Manager, State};
use tauri_plugin_window_state::Builder as WindowStateBuilder;

const CONFIG_DIR_NAME: &str = "PDF_Split_Rotate_Select_Save";
const DATABASE_FILE_NAME: &str = "database.sqlite";
const SECRET_SERVICE_NAME: &str = "PDF_Split_Rotate_Select_Save.ai";
const API_KEY_STORAGE_KEYCHAIN: &str = "keychain";
const API_KEY_STORAGE_DATABASE: &str = "database";
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;
const CHAT_HISTORY_LIMIT: usize = 10;
const CHAT_COMPACT_KEEP_RECENT: usize = 6;
const SEARCH_LIMIT: usize = 8;
const RRF_K: f64 = 60.0;
const EMBEDDING_BATCH_SIZE: usize = 16;

static SQLITE_VEC_REGISTER: Once = Once::new();

#[derive(Default)]
struct PendingPdfPaths {
    queue: Mutex<Vec<String>>,
}

struct AppState {
    config_dir: PathBuf,
    database_path: PathBuf,
    http: reqwest::Client,
}

#[cfg(target_os = "macos")]
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiEndpoint {
    id: String,
    label: String,
    provider: String,
    base_url: String,
    api_key: Option<String>,
    has_api_key: bool,
    clear_api_key: bool,
    chat_model: String,
    embedding_model: String,
    enabled: bool,
    is_default: bool,
    extra_json: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsBundle {
    settings: HashMap<String, Value>,
    endpoints: Vec<AiEndpoint>,
    config_dir: String,
    database_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsRequest {
    settings: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteAiEndpointRequest {
    endpoint_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfChunkInput {
    chunk_id: String,
    page_number: i64,
    chunk_index: i64,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexPdfDocumentRequest {
    document_id: String,
    fingerprint: String,
    title: String,
    path: Option<String>,
    chunk_signature: String,
    chunks: Vec<PdfChunkInput>,
    endpoint_id: Option<String>,
    force_rebuild: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexPdfDocumentResponse {
    document_id: String,
    stored_chunks: usize,
    text_updated: bool,
    embeddings_updated: bool,
    vector_ready: bool,
    vector_dimensions: Option<usize>,
    search_mode: String,
    last_indexed_at: Option<String>,
    reused_existing: bool,
    database_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessagePayload {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatWithPdfRequest {
    document_id: String,
    endpoint_id: String,
    user_message: String,
    history: Vec<ChatMessagePayload>,
    document_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrievedSnippet {
    chunk_id: String,
    page_number: i64,
    chunk_index: i64,
    content: String,
    score: f64,
    sources: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatWithPdfResponse {
    content: String,
    citations: Vec<RetrievedSnippet>,
    search_mode: String,
    endpoint_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredChatMessage {
    id: String,
    role: String,
    content: String,
    #[serde(default)]
    citations: Vec<RetrievedSnippet>,
    #[serde(default)]
    search_mode: Option<String>,
    #[serde(default)]
    endpoint_label: Option<String>,
    #[serde(default)]
    is_error: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSessionResponse {
    document_id: String,
    messages: Vec<StoredChatMessage>,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveChatSessionRequest {
    document_id: String,
    messages: Vec<StoredChatMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadChatSessionRequest {
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteChatSessionRequest {
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactChatHistoryRequest {
    endpoint: AiEndpoint,
    document_title: Option<String>,
    messages: Vec<StoredChatMessage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtectPdfRequest {
    pdf_bytes: Vec<u8>,
    output_path: String,
    password: String,
    owner_password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnprotectPdfRequest {
    input_path: String,
    output_path: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectPdfSecurityRequest {
    pdf_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectPdfSecurityResponse {
    is_encrypted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfTextEditRequest {
    page_number: u32,
    search_text: String,
    replacement_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyPdfTextEditsRequest {
    pdf_bytes: Vec<u8>,
    edits: Vec<PdfTextEditRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyPdfTextEditsResponse {
    pdf_bytes: Vec<u8>,
    applied_edits: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactChatHistoryResponse {
    content: String,
    endpoint_label: String,
    compacted_count: usize,
    kept_recent_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointTestResponse {
    ok: bool,
    status: String,
    details: String,
    checked_chat: bool,
    checked_embeddings: bool,
    has_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointModelCatalogResponse {
    provider: String,
    chat_models: Vec<String>,
    embedding_models: Vec<String>,
    fetched_chat: bool,
    fetched_embeddings: bool,
    used_fallback_chat: bool,
    used_fallback_embeddings: bool,
}

#[derive(Debug, Clone)]
struct VectorIndexRecord {
    vector_dimensions: usize,
    vec_table_name: String,
    chunk_signature: String,
    chunk_count: usize,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct RankedSnippet {
    chunk_id: String,
    page_number: i64,
    chunk_index: i64,
    content: String,
    sources: HashSet<&'static str>,
    score: f64,
}

fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn collect_pdf_paths(args: impl IntoIterator<Item = OsString>) -> Vec<String> {
    args.into_iter()
        .filter_map(|arg| {
            let path = Path::new(&arg);
            if is_pdf_path(path) {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect()
}

fn ensure_pdf_file_id(document: &mut LoDocument, pdf_bytes: &[u8]) {
    if document.trailer.has(b"ID") {
        return;
    }

    let digest = Sha256::digest(pdf_bytes);
    let file_id = digest[..16].to_vec();
    document.trailer.set(
        b"ID",
        lopdf::Object::Array(vec![
            lopdf::Object::String(file_id.clone(), lopdf::StringFormat::Hexadecimal),
            lopdf::Object::String(file_id, lopdf::StringFormat::Hexadecimal),
        ]),
    );
}

fn enqueue_pdf_paths(state: &State<'_, PendingPdfPaths>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut queue) = state.queue.lock() {
        queue.extend(paths);
    }
}

#[cfg(target_os = "macos")]
fn create_main_like_window(app: &AppHandle) {
    let label = format!("main-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title("PDF 자르고 추기하고 돌려고 선택하여 저장하기")
        .inner_size(800.0, 600.0)
        .visible(false)
        .build();
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn register_sqlite_vec() {
    SQLITE_VEC_REGISTER.call_once(|| unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

fn initialize_secret_store() {
    let _ = keyring::use_native_store(true);
}

fn secret_entry(endpoint_id: &str) -> anyhow::Result<Entry> {
    Entry::new(SECRET_SERVICE_NAME, endpoint_id)
        .with_context(|| format!("failed to access secret storage for endpoint {endpoint_id}"))
}

fn load_api_key_from_secret_store(endpoint_id: &str) -> anyhow::Result<Option<String>> {
    let entry = secret_entry(endpoint_id)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(anyhow::Error::new(error))
            .with_context(|| format!("failed to read API key for endpoint {endpoint_id}")),
    }
}

fn store_api_key_in_secret_store(endpoint_id: &str, api_key: &str) -> anyhow::Result<()> {
    let entry = secret_entry(endpoint_id)?;
    entry
        .set_password(api_key)
        .with_context(|| format!("failed to save API key for endpoint {endpoint_id}"))?;
    Ok(())
}

fn delete_api_key_from_secret_store(endpoint_id: &str) -> anyhow::Result<()> {
    let entry = secret_entry(endpoint_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(anyhow::Error::new(error))
            .with_context(|| format!("failed to delete API key for endpoint {endpoint_id}")),
    }
}

fn resolve_storage_paths() -> anyhow::Result<(PathBuf, PathBuf)> {
    let config_root = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .or_else(|| std::env::var_os("LOCALAPPDATA"))
            .map(PathBuf::from)
            .context("APPDATA or LOCALAPPDATA environment variable is not set")?
    } else if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME").context("HOME environment variable is not set")?;
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
            })
            .context("XDG_CONFIG_HOME or HOME environment variable is not set")?
    };
    let config_dir = config_root.join(CONFIG_DIR_NAME);
    std::fs::create_dir_all(&config_dir).with_context(|| {
        format!(
            "failed to create config directory: {}",
            config_dir.display()
        )
    })?;
    let database_path = config_dir.join(DATABASE_FILE_NAME);
    Ok((config_dir, database_path))
}

fn open_database(path: &Path) -> anyhow::Result<Connection> {
    register_sqlite_vec();
    let flags = OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_FULL_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags)
        .with_context(|| format!("failed to open sqlite database: {}", path.display()))?;
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "wal_autocheckpoint", 1000_i64)?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_endpoints (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            provider TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            chat_model TEXT NOT NULL DEFAULT '',
            embedding_model TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            extra_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pdf_documents (
            document_id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            title TEXT NOT NULL,
            path TEXT,
            chunk_signature TEXT NOT NULL,
            chunk_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pdf_chunks (
            chunk_id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(document_id) REFERENCES pdf_documents(document_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_pdf_chunks_document_page
            ON pdf_chunks(document_id, page_number, chunk_index);

        CREATE VIRTUAL TABLE IF NOT EXISTS pdf_chunks_fts USING fts5(
            document_id UNINDEXED,
            chunk_id UNINDEXED,
            content,
            tokenize='unicode61'
        );

        CREATE TABLE IF NOT EXISTS pdf_endpoint_indexes (
            document_id TEXT NOT NULL,
            endpoint_id TEXT NOT NULL,
            embedding_model TEXT NOT NULL,
            vector_dimensions INTEGER NOT NULL,
            vec_table_name TEXT NOT NULL,
            chunk_signature TEXT NOT NULL,
            chunk_count INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(document_id, endpoint_id, embedding_model)
        );

        CREATE TABLE IF NOT EXISTS pdf_chat_sessions (
            document_id TEXT PRIMARY KEY,
            messages_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

fn to_hex_prefix(bytes: &[u8], count: usize) -> String {
    let mut output = String::with_capacity(count * 2);
    for byte in bytes.iter().take(count) {
        output.push_str(&format!("{:02x}", byte));
    }
    output
}

fn build_vector_table_name(
    document_id: &str,
    service_kind: &str,
    embedding_model: &str,
    dimensions: usize,
) -> String {
    let digest = Sha256::digest(
        format!("{document_id}:{service_kind}:{embedding_model}:{dimensions}").as_bytes(),
    );
    format!("vec_idx_{}", to_hex_prefix(&digest, 12))
}

fn vector_service_key(endpoint: &AiEndpoint) -> &str {
    endpoint.provider.as_str()
}

fn normalize_provider(provider: &str) -> anyhow::Result<String> {
    let normalized = provider.trim().to_lowercase();
    let canonical = match normalized.as_str() {
        "ollama" => "ollama",
        "litellm" => "litellm",
        "lmstudio" | "lm-studio" => "lmstudio",
        "openai" | "chatgpt" => "openai",
        "anthropic" | "claude" => "anthropic",
        "gemini" | "google" => "gemini",
        _ => return Err(anyhow!("unsupported provider: {provider}")),
    };
    Ok(canonical.to_string())
}

fn provider_supports_embeddings(provider: &str) -> bool {
    matches!(
        provider,
        "ollama" | "litellm" | "lmstudio" | "openai" | "gemini"
    )
}

fn generate_endpoint_id(provider: &str, label: &str) -> String {
    let seed = format!("{provider}:{label}:{}", now_iso());
    let digest = Sha256::digest(seed.as_bytes());
    format!("ep_{}", to_hex_prefix(&digest, 10))
}

fn default_endpoints() -> Vec<AiEndpoint> {
    vec![
        AiEndpoint {
            id: "ollama-local".to_string(),
            label: "Ollama (Local)".to_string(),
            provider: "ollama".to_string(),
            base_url: "http://127.0.0.1:11434".to_string(),
            api_key: None,
            has_api_key: false,
            clear_api_key: false,
            chat_model: String::new(),
            embedding_model: String::new(),
            enabled: false,
            is_default: false,
            extra_json: json!({ "kind": "local", "apiKeyStorage": "keychain" }),
        },
        AiEndpoint {
            id: "litellm-local".to_string(),
            label: "LiteLLM (Local)".to_string(),
            provider: "litellm".to_string(),
            base_url: "http://127.0.0.1:4000/v1".to_string(),
            api_key: None,
            has_api_key: false,
            clear_api_key: false,
            chat_model: String::new(),
            embedding_model: String::new(),
            enabled: false,
            is_default: false,
            extra_json: json!({ "kind": "local", "apiKeyStorage": "keychain" }),
        },
        AiEndpoint {
            id: "lmstudio-local".to_string(),
            label: "LM Studio (Local)".to_string(),
            provider: "lmstudio".to_string(),
            base_url: "http://127.0.0.1:1234/v1".to_string(),
            api_key: None,
            has_api_key: false,
            clear_api_key: false,
            chat_model: String::new(),
            embedding_model: String::new(),
            enabled: false,
            is_default: false,
            extra_json: json!({ "kind": "local", "openaiCompatible": true, "apiKeyStorage": "keychain" }),
        },
        AiEndpoint {
            id: "openai-cloud".to_string(),
            label: "ChatGPT / OpenAI".to_string(),
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: None,
            has_api_key: false,
            clear_api_key: false,
            chat_model: "gpt-4.1-mini".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            enabled: false,
            is_default: false,
            extra_json: json!({ "kind": "cloud", "apiKeyStorage": "keychain" }),
        },
        AiEndpoint {
            id: "claude-cloud".to_string(),
            label: "Claude / Anthropic".to_string(),
            provider: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            api_key: None,
            has_api_key: false,
            clear_api_key: false,
            chat_model: "claude-sonnet-4-20250514".to_string(),
            embedding_model: String::new(),
            enabled: false,
            is_default: false,
            extra_json: json!({ "kind": "cloud", "bm25Only": true, "apiKeyStorage": "keychain" }),
        },
        AiEndpoint {
            id: "gemini-cloud".to_string(),
            label: "Gemini".to_string(),
            provider: "gemini".to_string(),
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
            api_key: None,
            has_api_key: false,
            clear_api_key: false,
            chat_model: "gemini-2.5-flash".to_string(),
            embedding_model: "gemini-embedding-001".to_string(),
            enabled: false,
            is_default: false,
            extra_json: json!({ "kind": "cloud", "apiKeyStorage": "keychain" }),
        },
    ]
}

fn endpoint_api_key_storage(extra_json: &Value) -> &'static str {
    if extra_json
        .get("apiKeyStorage")
        .and_then(Value::as_str)
        .map(|value| value.eq_ignore_ascii_case(API_KEY_STORAGE_DATABASE))
        .unwrap_or(false)
    {
        API_KEY_STORAGE_DATABASE
    } else {
        API_KEY_STORAGE_KEYCHAIN
    }
}

fn ensure_endpoint_secret_config(mut endpoint: AiEndpoint) -> AiEndpoint {
    let storage = endpoint_api_key_storage(&endpoint.extra_json);
    if let Some(map) = endpoint.extra_json.as_object_mut() {
        map.insert(
            "apiKeyStorage".to_string(),
            Value::String(storage.to_string()),
        );
    } else {
        endpoint.extra_json = json!({ "apiKeyStorage": storage });
    }
    endpoint
}

fn ensure_default_endpoints(conn: &mut Connection) -> anyhow::Result<()> {
    let tx = conn.transaction()?;
    for endpoint in default_endpoints() {
        let now = now_iso();
        tx.execute(
            r#"
            INSERT INTO ai_endpoints(
                id, label, provider, base_url, api_key, chat_model,
                embedding_model, enabled, is_default, extra_json, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO NOTHING
            "#,
            params![
                endpoint.id,
                endpoint.label,
                endpoint.provider,
                endpoint.base_url,
                endpoint.api_key,
                endpoint.chat_model,
                endpoint.embedding_model,
                if endpoint.enabled { 1_i64 } else { 0_i64 },
                if endpoint.is_default { 1_i64 } else { 0_i64 },
                endpoint.extra_json.to_string(),
                now,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn row_to_endpoint(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiEndpoint> {
    let extra_json_raw: String = row.get("extra_json")?;
    Ok(ensure_endpoint_secret_config(AiEndpoint {
        id: row.get("id")?,
        label: row.get("label")?,
        provider: row.get("provider")?,
        base_url: row.get("base_url")?,
        api_key: row.get("api_key")?,
        has_api_key: false,
        clear_api_key: false,
        chat_model: row.get("chat_model")?,
        embedding_model: row.get("embedding_model")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        is_default: row.get::<_, i64>("is_default")? != 0,
        extra_json: serde_json::from_str(&extra_json_raw).unwrap_or_else(|_| json!({})),
    }))
}

fn hydrate_endpoint_secret_state(mut endpoint: AiEndpoint) -> anyhow::Result<AiEndpoint> {
    endpoint = ensure_endpoint_secret_config(endpoint);
    endpoint.has_api_key =
        if endpoint_api_key_storage(&endpoint.extra_json) == API_KEY_STORAGE_DATABASE {
            endpoint
                .api_key
                .as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        } else {
            load_api_key_from_secret_store(&endpoint.id)?.is_some()
        };
    endpoint.api_key = None;
    endpoint.clear_api_key = false;
    Ok(endpoint)
}

fn runtime_endpoint(mut endpoint: AiEndpoint) -> anyhow::Result<AiEndpoint> {
    endpoint = ensure_endpoint_secret_config(endpoint);
    if endpoint_api_key_storage(&endpoint.extra_json) == API_KEY_STORAGE_KEYCHAIN {
        endpoint.api_key = load_api_key_from_secret_store(&endpoint.id)?;
    } else {
        endpoint.api_key = endpoint
            .api_key
            .take()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    endpoint.has_api_key = endpoint.api_key.is_some();
    endpoint.clear_api_key = false;
    Ok(endpoint)
}

fn load_database_api_key(conn: &Connection, endpoint_id: &str) -> anyhow::Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT api_key FROM ai_endpoints WHERE id = ?1",
            [endpoint_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn load_saved_api_key_anywhere(
    state: &AppState,
    endpoint_id: &str,
) -> anyhow::Result<Option<String>> {
    let conn = open_database(&state.database_path)?;
    if let Some(value) = load_database_api_key(&conn, endpoint_id)? {
        return Ok(Some(value));
    }
    load_api_key_from_secret_store(endpoint_id)
}

fn load_settings_bundle_inner(state: &AppState) -> anyhow::Result<SettingsBundle> {
    let mut conn = open_database(&state.database_path)?;
    ensure_default_endpoints(&mut conn)?;

    let mut settings = HashMap::new();
    let mut stmt = conn.prepare("SELECT key, value_json FROM app_settings ORDER BY key")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for item in rows {
        let (key, raw_value) = item?;
        let parsed = serde_json::from_str(&raw_value).unwrap_or(Value::String(raw_value));
        settings.insert(key, parsed);
    }

    let mut endpoint_stmt = conn.prepare(
        r#"
        SELECT id, label, provider, base_url, api_key, chat_model,
               embedding_model, enabled, is_default, extra_json
        FROM ai_endpoints
        ORDER BY is_default DESC, enabled DESC, label COLLATE NOCASE ASC
        "#,
    )?;
    let endpoints = endpoint_stmt
        .query_map([], row_to_endpoint)?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(hydrate_endpoint_secret_state)
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(SettingsBundle {
        settings,
        endpoints,
        config_dir: state.config_dir.to_string_lossy().to_string(),
        database_path: state.database_path.to_string_lossy().to_string(),
    })
}

fn save_settings_inner(state: &AppState, request: SaveSettingsRequest) -> anyhow::Result<()> {
    let mut conn = open_database(&state.database_path)?;
    let tx = conn.transaction()?;
    let now = now_iso();
    for (key, value) in request.settings {
        tx.execute(
            r#"
            INSERT INTO app_settings(key, value_json, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            "#,
            params![key, value.to_string(), now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn save_chat_session_inner(
    state: &AppState,
    request: SaveChatSessionRequest,
) -> anyhow::Result<ChatSessionResponse> {
    if request.document_id.trim().is_empty() {
        return Err(anyhow!("documentId is required"));
    }
    let mut conn = open_database(&state.database_path)?;
    let tx = conn.transaction()?;
    let updated_at = now_iso();
    tx.execute(
        r#"
        INSERT INTO pdf_chat_sessions(document_id, messages_json, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(document_id) DO UPDATE SET
            messages_json = excluded.messages_json,
            updated_at = excluded.updated_at
        "#,
        params![
            request.document_id,
            serde_json::to_string(&request.messages)?,
            updated_at,
        ],
    )?;
    tx.commit()?;
    Ok(ChatSessionResponse {
        document_id: request.document_id,
        messages: request.messages,
        updated_at,
    })
}

fn load_chat_session_inner(
    state: &AppState,
    request: LoadChatSessionRequest,
) -> anyhow::Result<Option<ChatSessionResponse>> {
    if request.document_id.trim().is_empty() {
        return Err(anyhow!("documentId is required"));
    }
    let conn = open_database(&state.database_path)?;
    let row = conn
        .query_row(
            "SELECT messages_json, updated_at FROM pdf_chat_sessions WHERE document_id = ?1",
            [&request.document_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    match row {
        Some((messages_json, updated_at)) => Ok(Some(ChatSessionResponse {
            document_id: request.document_id,
            messages: serde_json::from_str(&messages_json).unwrap_or_default(),
            updated_at,
        })),
        None => Ok(None),
    }
}

fn delete_chat_session_inner(
    state: &AppState,
    request: DeleteChatSessionRequest,
) -> anyhow::Result<()> {
    if request.document_id.trim().is_empty() {
        return Err(anyhow!("documentId is required"));
    }
    let conn = open_database(&state.database_path)?;
    conn.execute(
        "DELETE FROM pdf_chat_sessions WHERE document_id = ?1",
        [&request.document_id],
    )?;
    Ok(())
}

fn sanitize_endpoint(mut endpoint: AiEndpoint) -> anyhow::Result<AiEndpoint> {
    endpoint.provider = normalize_provider(&endpoint.provider)?;
    endpoint.id = if endpoint.id.trim().is_empty() {
        generate_endpoint_id(&endpoint.provider, &endpoint.label)
    } else {
        endpoint.id.trim().to_string()
    };
    endpoint.label = endpoint.label.trim().to_string();
    endpoint.base_url = endpoint.base_url.trim().trim_end_matches('/').to_string();
    endpoint.api_key = endpoint
        .api_key
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    endpoint.chat_model = endpoint.chat_model.trim().to_string();
    endpoint.embedding_model = endpoint.embedding_model.trim().to_string();
    if endpoint.label.is_empty() {
        return Err(anyhow!("endpoint label is required"));
    }
    if endpoint.base_url.is_empty() {
        return Err(anyhow!("endpoint base URL is required"));
    }
    if endpoint.extra_json.is_null() {
        endpoint.extra_json = json!({});
    }
    Ok(ensure_endpoint_secret_config(endpoint))
}

fn save_ai_endpoint_inner(state: &AppState, endpoint: AiEndpoint) -> anyhow::Result<AiEndpoint> {
    let endpoint = sanitize_endpoint(endpoint)?;
    let secret_storage = endpoint_api_key_storage(&endpoint.extra_json);
    let should_clear_api_key = endpoint.clear_api_key;
    let existing_api_key = if endpoint.api_key.is_none() && !should_clear_api_key {
        load_saved_api_key_anywhere(state, &endpoint.id)?
    } else {
        None
    };
    let effective_api_key = endpoint.api_key.clone().or(existing_api_key);
    let database_api_key = if !should_clear_api_key && secret_storage == API_KEY_STORAGE_DATABASE {
        effective_api_key.clone()
    } else {
        None
    };
    let mut conn = open_database(&state.database_path)?;
    let tx = conn.transaction()?;
    if endpoint.is_default {
        tx.execute("UPDATE ai_endpoints SET is_default = 0", [])?;
    }
    tx.execute(
        r#"
        INSERT INTO ai_endpoints(
            id, label, provider, base_url, api_key, chat_model,
            embedding_model, enabled, is_default, extra_json, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            provider = excluded.provider,
            base_url = excluded.base_url,
            api_key = excluded.api_key,
            chat_model = excluded.chat_model,
            embedding_model = excluded.embedding_model,
            enabled = excluded.enabled,
            is_default = excluded.is_default,
            extra_json = excluded.extra_json,
            updated_at = excluded.updated_at
        "#,
        params![
            endpoint.id,
            endpoint.label,
            endpoint.provider,
            endpoint.base_url,
            database_api_key,
            endpoint.chat_model,
            endpoint.embedding_model,
            if endpoint.enabled { 1_i64 } else { 0_i64 },
            if endpoint.is_default { 1_i64 } else { 0_i64 },
            endpoint.extra_json.to_string(),
            now_iso(),
        ],
    )?;
    tx.commit()?;

    if should_clear_api_key || secret_storage == API_KEY_STORAGE_DATABASE {
        delete_api_key_from_secret_store(&endpoint.id)?;
    } else if let Some(api_key) = effective_api_key {
        store_api_key_in_secret_store(&endpoint.id, &api_key)?;
    }

    let conn = open_database(&state.database_path)?;
    let saved = conn
        .query_row(
            r#"
            SELECT id, label, provider, base_url, api_key, chat_model,
                   embedding_model, enabled, is_default, extra_json
            FROM ai_endpoints
            WHERE id = ?1
            "#,
            [&endpoint.id],
            row_to_endpoint,
        )
        .with_context(|| format!("failed to reload endpoint {}", endpoint.id))?;
    hydrate_endpoint_secret_state(saved)
}

fn delete_ai_endpoint_inner(
    state: &AppState,
    request: DeleteAiEndpointRequest,
) -> anyhow::Result<()> {
    let mut conn = open_database(&state.database_path)?;
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM ai_endpoints WHERE id = ?1",
        [&request.endpoint_id],
    )?;
    tx.commit()?;
    delete_api_key_from_secret_store(&request.endpoint_id)?;
    Ok(())
}

fn get_endpoint_by_id(conn: &Connection, endpoint_id: &str) -> anyhow::Result<AiEndpoint> {
    let endpoint = conn
        .query_row(
            r#"
            SELECT id, label, provider, base_url, api_key, chat_model,
                   embedding_model, enabled, is_default, extra_json
            FROM ai_endpoints
            WHERE id = ?1
            "#,
            [endpoint_id],
            row_to_endpoint,
        )
        .with_context(|| format!("AI endpoint not found: {endpoint_id}"))?;
    runtime_endpoint(endpoint)
}

fn upsert_document_chunks(
    conn: &mut Connection,
    request: &IndexPdfDocumentRequest,
) -> anyhow::Result<bool> {
    let existing = conn
        .query_row(
            "SELECT chunk_signature, chunk_count FROM pdf_documents WHERE document_id = ?1",
            [&request.document_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;

    let chunk_count = i64::try_from(request.chunks.len()).unwrap_or(i64::MAX);
    let force_rebuild = request.force_rebuild.unwrap_or(false);
    let unchanged = !force_rebuild
        && matches!(
            existing,
            Some((ref signature, existing_count))
                if signature == &request.chunk_signature && existing_count == chunk_count
        );
    if unchanged {
        return Ok(false);
    }

    let tx = conn.transaction()?;
    tx.execute(
        r#"
        INSERT INTO pdf_documents(document_id, fingerprint, title, path, chunk_signature, chunk_count, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(document_id) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            title = excluded.title,
            path = excluded.path,
            chunk_signature = excluded.chunk_signature,
            chunk_count = excluded.chunk_count,
            updated_at = excluded.updated_at
        "#,
        params![
            request.document_id,
            request.fingerprint,
            request.title,
            request.path,
            request.chunk_signature,
            chunk_count,
            now_iso(),
        ],
    )?;
    tx.execute(
        "DELETE FROM pdf_chunks_fts WHERE document_id = ?1",
        [&request.document_id],
    )?;
    tx.execute(
        "DELETE FROM pdf_chunks WHERE document_id = ?1",
        [&request.document_id],
    )?;

    {
        let mut chunk_stmt = tx.prepare(
            r#"
            INSERT INTO pdf_chunks(chunk_id, document_id, page_number, chunk_index, content, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
        )?;
        let mut fts_stmt = tx.prepare(
            "INSERT INTO pdf_chunks_fts(document_id, chunk_id, content) VALUES (?1, ?2, ?3)",
        )?;
        let now = now_iso();
        for chunk in &request.chunks {
            chunk_stmt.execute(params![
                chunk.chunk_id,
                request.document_id,
                chunk.page_number,
                chunk.chunk_index,
                chunk.content,
                now,
            ])?;
            fts_stmt.execute(params![request.document_id, chunk.chunk_id, chunk.content])?;
        }
    }
    tx.commit()?;
    Ok(true)
}

fn load_vector_index_record(
    conn: &Connection,
    document_id: &str,
    service_kind: &str,
    embedding_model: &str,
) -> anyhow::Result<Option<VectorIndexRecord>> {
    conn.query_row(
        r#"
        SELECT embedding_model, vector_dimensions, vec_table_name, chunk_signature, chunk_count, updated_at
        FROM pdf_endpoint_indexes
        WHERE document_id = ?1 AND endpoint_id = ?2 AND embedding_model = ?3
        "#,
        params![document_id, service_kind, embedding_model],
        |row| {
            Ok(VectorIndexRecord {
                vector_dimensions: row.get::<_, i64>(1)? as usize,
                vec_table_name: row.get(2)?,
                chunk_signature: row.get(3)?,
                chunk_count: row.get::<_, i64>(4)? as usize,
                updated_at: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn ensure_vector_table(
    conn: &Connection,
    table_name: &str,
    dimensions: usize,
    drop_existing: bool,
) -> anyhow::Result<()> {
    if drop_existing {
        conn.execute_batch(&format!("DROP TABLE IF EXISTS {table_name};"))?;
    }
    conn.execute_batch(&format!(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS {table_name} USING vec0(
            embedding float[{dimensions}],
            +chunk_id text,
            +document_id text,
            +page_number integer,
            +chunk_index integer,
            +content text
        );
        "#,
    ))?;
    Ok(())
}

fn upsert_vector_index_metadata(
    conn: &Connection,
    document_id: &str,
    service_kind: &str,
    embedding_model: &str,
    dimensions: usize,
    vec_table_name: &str,
    chunk_signature: &str,
    chunk_count: usize,
) -> anyhow::Result<()> {
    conn.execute(
        r#"
        INSERT INTO pdf_endpoint_indexes(
            document_id, endpoint_id, embedding_model, vector_dimensions,
            vec_table_name, chunk_signature, chunk_count, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(document_id, endpoint_id, embedding_model) DO UPDATE SET
            vector_dimensions = excluded.vector_dimensions,
            vec_table_name = excluded.vec_table_name,
            chunk_signature = excluded.chunk_signature,
            chunk_count = excluded.chunk_count,
            updated_at = excluded.updated_at
        "#,
        params![
            document_id,
            service_kind,
            embedding_model,
            dimensions as i64,
            vec_table_name,
            chunk_signature,
            chunk_count as i64,
            now_iso(),
        ],
    )?;
    Ok(())
}

fn load_document_index_updated_at(
    conn: &Connection,
    document_id: &str,
) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT updated_at FROM pdf_documents WHERE document_id = ?1",
        [document_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

async fn ensure_embeddings_for_document(
    state: &AppState,
    endpoint: &AiEndpoint,
    request: &IndexPdfDocumentRequest,
) -> anyhow::Result<(bool, bool, Option<usize>)> {
    if !endpoint.enabled {
        return Ok((false, false, None));
    }
    if !provider_supports_embeddings(&endpoint.provider) {
        return Ok((false, false, None));
    }
    if endpoint.embedding_model.trim().is_empty() {
        return Ok((false, false, None));
    }

    let conn = open_database(&state.database_path)?;
    let service_kind = vector_service_key(endpoint);
    let existing = load_vector_index_record(
        &conn,
        &request.document_id,
        service_kind,
        &endpoint.embedding_model,
    )?;
    let matches_existing = existing.as_ref().is_some_and(|record| {
        record.chunk_signature == request.chunk_signature
            && record.chunk_count == request.chunks.len()
            && !request.force_rebuild.unwrap_or(false)
    });
    if matches_existing {
        return Ok((false, true, existing.map(|record| record.vector_dimensions)));
    }

    let texts = request
        .chunks
        .iter()
        .map(|chunk| chunk.content.clone())
        .collect::<Vec<_>>();
    if texts.is_empty() {
        return Ok((false, false, None));
    }

    let embeddings = embed_texts_for_endpoint(&state.http, endpoint, &texts).await?;
    let first = embeddings
        .first()
        .context("embedding response did not include vectors")?;
    let dimensions = first.len();
    if dimensions == 0 {
        return Err(anyhow!("embedding vector is empty"));
    }
    if embeddings.len() != request.chunks.len() {
        return Err(anyhow!(
            "embedding count mismatch: expected {}, received {}",
            request.chunks.len(),
            embeddings.len()
        ));
    }

    let table_name = build_vector_table_name(
        &request.document_id,
        service_kind,
        &endpoint.embedding_model,
        dimensions,
    );
    let drop_existing = existing
        .as_ref()
        .map(|record| record.vec_table_name != table_name || record.vector_dimensions != dimensions)
        .unwrap_or(false);
    let mut conn = open_database(&state.database_path)?;
    ensure_vector_table(&conn, &table_name, dimensions, drop_existing)?;
    let tx = conn.transaction()?;
    tx.execute(&format!("DELETE FROM {table_name}"), [])?;
    let insert_sql = format!(
        "INSERT INTO {table_name}(embedding, chunk_id, document_id, page_number, chunk_index, content) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    );
    {
        let mut stmt = tx.prepare(&insert_sql)?;
        for (chunk, embedding) in request.chunks.iter().zip(embeddings.iter()) {
            stmt.execute(params![
                serde_json::to_string(embedding)?,
                chunk.chunk_id,
                request.document_id,
                chunk.page_number,
                chunk.chunk_index,
                chunk.content,
            ])?;
        }
    }
    if let Some(record) = existing {
        if record.vec_table_name != table_name {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS {}", record.vec_table_name))?;
        }
    }
    upsert_vector_index_metadata(
        &tx,
        &request.document_id,
        service_kind,
        &endpoint.embedding_model,
        dimensions,
        &table_name,
        &request.chunk_signature,
        request.chunks.len(),
    )?;
    tx.commit()?;

    Ok((true, true, Some(dimensions)))
}

fn build_fts_query(query: &str) -> Option<String> {
    let tokens = query
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
        .map(str::trim)
        .filter(|token| token.len() >= 2)
        .map(|token| format!("\"{}\"", token.replace('"', "")))
        .take(12)
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" OR "))
    }
}

fn search_bm25(
    conn: &Connection,
    document_id: &str,
    query: &str,
    limit: usize,
) -> anyhow::Result<Vec<RetrievedSnippet>> {
    let Some(fts_query) = build_fts_query(query) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        r#"
        SELECT c.chunk_id, c.page_number, c.chunk_index, c.content, bm25(pdf_chunks_fts) AS rank_score
        FROM pdf_chunks_fts
        JOIN pdf_chunks AS c ON c.chunk_id = pdf_chunks_fts.chunk_id
        WHERE pdf_chunks_fts MATCH ?1 AND pdf_chunks_fts.document_id = ?2
        ORDER BY rank_score ASC
        LIMIT ?3
        "#,
    )?;
    let rows = stmt.query_map(params![fts_query, document_id, limit as i64], |row| {
        Ok(RetrievedSnippet {
            chunk_id: row.get(0)?,
            page_number: row.get(1)?,
            chunk_index: row.get(2)?,
            content: row.get(3)?,
            score: row.get::<_, f64>(4)?,
            sources: vec!["bm25".to_string()],
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn search_vector(
    conn: &Connection,
    record: &VectorIndexRecord,
    embedding_json: &str,
    limit: usize,
) -> anyhow::Result<Vec<RetrievedSnippet>> {
    let sql = format!(
        "SELECT chunk_id, page_number, chunk_index, content, distance FROM {} WHERE embedding MATCH ?1 ORDER BY distance ASC LIMIT ?2",
        record.vec_table_name
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![embedding_json, limit as i64], |row| {
        Ok(RetrievedSnippet {
            chunk_id: row.get(0)?,
            page_number: row.get(1)?,
            chunk_index: row.get(2)?,
            content: row.get(3)?,
            score: row.get::<_, f64>(4)?,
            sources: vec!["vector".to_string()],
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn fuse_ranked_results(
    bm25: &[RetrievedSnippet],
    vector: &[RetrievedSnippet],
    limit: usize,
) -> Vec<RetrievedSnippet> {
    let mut merged: HashMap<String, RankedSnippet> = HashMap::new();

    for (rank, item) in bm25.iter().enumerate() {
        let entry = merged
            .entry(item.chunk_id.clone())
            .or_insert_with(|| RankedSnippet {
                chunk_id: item.chunk_id.clone(),
                page_number: item.page_number,
                chunk_index: item.chunk_index,
                content: item.content.clone(),
                sources: HashSet::new(),
                score: 0.0,
            });
        entry.sources.insert("bm25");
        entry.score += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    for (rank, item) in vector.iter().enumerate() {
        let entry = merged
            .entry(item.chunk_id.clone())
            .or_insert_with(|| RankedSnippet {
                chunk_id: item.chunk_id.clone(),
                page_number: item.page_number,
                chunk_index: item.chunk_index,
                content: item.content.clone(),
                sources: HashSet::new(),
                score: 0.0,
            });
        entry.sources.insert("vector");
        entry.score += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    let mut combined = merged
        .into_values()
        .map(|item| RetrievedSnippet {
            chunk_id: item.chunk_id,
            page_number: item.page_number,
            chunk_index: item.chunk_index,
            content: item.content,
            score: item.score,
            sources: item
                .sources
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>(),
        })
        .collect::<Vec<_>>();
    combined.sort_by(|a, b| b.score.total_cmp(&a.score));
    combined.truncate(limit);
    combined
}

async fn retrieve_context_for_query(
    state: &AppState,
    endpoint: &AiEndpoint,
    document_id: &str,
    user_message: &str,
) -> anyhow::Result<(Vec<RetrievedSnippet>, String)> {
    let conn = open_database(&state.database_path)?;
    let bm25 = search_bm25(&conn, document_id, user_message, SEARCH_LIMIT)?;

    let mut vector_results = Vec::new();
    if provider_supports_embeddings(&endpoint.provider)
        && !endpoint.embedding_model.trim().is_empty()
    {
        if let Some(record) = load_vector_index_record(
            &conn,
            document_id,
            vector_service_key(endpoint),
            &endpoint.embedding_model,
        )? {
            let query_embedding =
                embed_texts_for_endpoint(&state.http, endpoint, &[user_message.to_string()])
                    .await?;
            if let Some(vector) = query_embedding.first() {
                vector_results = search_vector(
                    &conn,
                    &record,
                    &serde_json::to_string(vector)?,
                    SEARCH_LIMIT,
                )?;
            }
        }
    }

    let search_mode = if !vector_results.is_empty() {
        "bm25+vector"
    } else if !bm25.is_empty() {
        "bm25"
    } else if provider_supports_embeddings(&endpoint.provider)
        && !endpoint.embedding_model.trim().is_empty()
    {
        "vector"
    } else {
        "bm25"
    };

    let fused = fuse_ranked_results(&bm25, &vector_results, SEARCH_LIMIT);
    Ok((fused, search_mode.to_string()))
}

fn truncate_history(history: &[ChatMessagePayload]) -> Vec<ChatMessagePayload> {
    let mut cleaned = history
        .iter()
        .filter_map(|message| {
            let role = message.role.trim().to_lowercase();
            let content = message.content.trim();
            if content.is_empty() {
                return None;
            }
            let normalized_role = match role.as_str() {
                "assistant" | "model" => "assistant",
                _ => "user",
            };
            Some(ChatMessagePayload {
                role: normalized_role.to_string(),
                content: content.to_string(),
            })
        })
        .collect::<Vec<_>>();
    if cleaned.len() > CHAT_HISTORY_LIMIT {
        cleaned.drain(0..cleaned.len() - CHAT_HISTORY_LIMIT);
    }
    cleaned
}

fn prepare_runtime_endpoint(
    state: &AppState,
    mut endpoint: AiEndpoint,
) -> anyhow::Result<AiEndpoint> {
    endpoint = sanitize_endpoint(endpoint)?;
    if endpoint.api_key.is_none() {
        endpoint.api_key = match endpoint_api_key_storage(&endpoint.extra_json) {
            API_KEY_STORAGE_DATABASE => load_saved_api_key_anywhere(state, &endpoint.id)?,
            _ => load_api_key_from_secret_store(&endpoint.id)?,
        };
    }
    endpoint.has_api_key = endpoint.api_key.is_some();
    endpoint.clear_api_key = false;
    Ok(endpoint)
}

fn build_compaction_transcript(messages: &[StoredChatMessage]) -> String {
    let mut lines = Vec::new();
    for message in messages {
        let role = if message.role.trim().eq_ignore_ascii_case("assistant") {
            "Assistant"
        } else {
            "User"
        };
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        lines.push(format!("{role}: {content}"));
        if !message.citations.is_empty() {
            let citations = message
                .citations
                .iter()
                .take(4)
                .map(|citation| format!("p.{}", citation.page_number))
                .collect::<Vec<_>>()
                .join(", ");
            if !citations.is_empty() {
                lines.push(format!("Citations: {citations}"));
            }
        }
    }
    lines.join("\n\n")
}

fn build_compaction_prompt(document_title: &str, transcript: &str) -> (String, String) {
    let system_prompt = "You condense prior chat history for a PDF assistant. Preserve facts, decisions, unresolved questions, and any page references. Write concise markdown. Do not invent information.".to_string();
    let user_prompt = format!(
        "Current PDF title: {document_title}\n\nSummarize the earlier conversation below so it can replace the detailed history. Keep it compact but preserve important facts, constraints, page references, and open questions.\n\nReturn markdown with these sections:\n- ## Summary\n- ## Key Facts\n- ## Open Questions\n\nConversation transcript:\n{transcript}"
    );
    (system_prompt, user_prompt)
}

fn build_context_prompt(
    document_title: &str,
    user_message: &str,
    snippets: &[RetrievedSnippet],
) -> String {
    let mut prompt = String::new();
    prompt.push_str(&format!("Current PDF title: {document_title}\n"));
    prompt.push_str(&format!("User question: {user_message}\n\n"));
    prompt.push_str("Relevant PDF snippets:\n");
    for (index, snippet) in snippets.iter().enumerate() {
        prompt.push_str(&format!(
            "[{}] page {} / chunk {}\n{}\n\n",
            index + 1,
            snippet.page_number,
            snippet.chunk_index,
            snippet.content
        ));
    }
    prompt.push_str(
        "Answer using only the PDF evidence above when possible. If the answer is not supported by the snippets, say so clearly. Cite page numbers in the answer like [p.12].",
    );
    prompt
}

fn build_system_prompt(search_mode: &str) -> String {
    format!(
        "You are a PDF analysis assistant embedded in a desktop app. Use the retrieved snippets from the open PDF as the primary source of truth. Search mode available for this answer: {search_mode}. Keep answers concise, factual, and mention uncertainty when the PDF evidence is incomplete."
    )
}

fn header_value(value: &str) -> anyhow::Result<HeaderValue> {
    HeaderValue::from_str(value).with_context(|| format!("invalid header value: {value}"))
}

fn openai_like_base(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_string()
}

fn anthropic_messages_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn gemini_generate_url(base_url: &str, model: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!("{base}/models/{model}:generateContent")
}

fn gemini_embed_url(base_url: &str, model: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!("{base}/models/{model}:embedContent")
}

fn maybe_api_key(endpoint: &AiEndpoint) -> anyhow::Result<Option<String>> {
    if let Some(value) = endpoint
        .api_key
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(value));
    }
    load_api_key_from_secret_store(&endpoint.id).map(|value| {
        value
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
    })
}

fn require_api_key(endpoint: &AiEndpoint) -> anyhow::Result<String> {
    maybe_api_key(endpoint)?.with_context(|| format!("API key is required for {}", endpoint.label))
}

async fn send_json_request(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
    body: Value,
) -> anyhow::Result<Value> {
    let response = client
        .post(url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("request failed: {url}"))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("{} {}", status, text));
    }
    serde_json::from_str(&text).with_context(|| format!("invalid JSON from {url}: {text}"))
}

async fn send_get_request(
    client: &reqwest::Client,
    url: &str,
    headers: HeaderMap,
) -> anyhow::Result<Value> {
    let response = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("request failed: {url}"))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("{} {}", status, text));
    }
    serde_json::from_str(&text).with_context(|| format!("invalid JSON from {url}: {text}"))
}

fn normalized_model_name(value: &str) -> String {
    value.trim().trim_start_matches("models/").to_string()
}

fn dedupe_models(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for value in values {
        let normalized = normalized_model_name(&value);
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_lowercase();
        if seen.insert(key) {
            output.push(normalized);
        }
    }
    output
}

fn looks_like_embedding_model(model: &str) -> bool {
    let value = model.to_lowercase();
    value.contains("embedding")
        || value.contains("embed")
        || value.starts_with("text-embedding")
        || value.contains("nomic")
        || value.contains("mxbai")
        || value.contains("bge")
        || value.contains("e5")
}

fn looks_like_chat_model(model: &str) -> bool {
    let value = model.to_lowercase();
    !looks_like_embedding_model(model)
        && !value.contains("moderation")
        && !value.contains("transcribe")
        && !value.contains("tts")
        && !value.contains("whisper")
        && !value.contains("image")
        && !value.contains("dall")
        && !value.contains("sora")
}

fn fallback_chat_models(endpoint: &AiEndpoint) -> Vec<String> {
    let mut models = Vec::new();
    if !endpoint.chat_model.trim().is_empty() {
        models.push(endpoint.chat_model.clone());
    }
    match endpoint.provider.as_str() {
        "openai" => {
            models.push("gpt-4.1-mini".to_string());
            models.push("gpt-4.1".to_string());
            models.push("gpt-4o-mini".to_string());
        }
        "anthropic" => {
            models.push("claude-sonnet-4-20250514".to_string());
            models.push("claude-opus-4-6".to_string());
        }
        "gemini" => {
            models.push("gemini-2.5-flash".to_string());
            models.push("gemini-2.5-pro".to_string());
        }
        "ollama" => {
            models.push("llama3.2".to_string());
            models.push("gemma3".to_string());
        }
        "litellm" | "lmstudio" => {}
        _ => {}
    }
    dedupe_models(models)
}

fn fallback_embedding_models(endpoint: &AiEndpoint) -> Vec<String> {
    let mut models = Vec::new();
    if !endpoint.embedding_model.trim().is_empty() {
        models.push(endpoint.embedding_model.clone());
    }
    match endpoint.provider.as_str() {
        "openai" => {
            models.push("text-embedding-3-small".to_string());
            models.push("text-embedding-3-large".to_string());
        }
        "gemini" => {
            models.push("gemini-embedding-001".to_string());
        }
        "ollama" => {
            models.push("nomic-embed-text".to_string());
            models.push("mxbai-embed-large".to_string());
        }
        "litellm" | "lmstudio" | "anthropic" => {}
        _ => {}
    }
    dedupe_models(models)
}

async fn fetch_openai_like_model_ids(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
) -> anyhow::Result<Vec<String>> {
    let mut headers = HeaderMap::new();
    if endpoint.provider == "openai" {
        let api_key = require_api_key(endpoint)?;
        headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
    } else if let Some(api_key) = maybe_api_key(endpoint)? {
        headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
    }
    let url = format!("{}/models", openai_like_base(&endpoint.base_url));
    let response = send_get_request(client, &url, headers).await?;
    let models = response
        .get("data")
        .and_then(Value::as_array)
        .context("models response missing data array")?
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    Ok(dedupe_models(models))
}

async fn fetch_ollama_model_ids(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
) -> anyhow::Result<Vec<String>> {
    let response = send_get_request(
        client,
        &format!("{}/api/tags", endpoint.base_url.trim_end_matches('/')),
        HeaderMap::new(),
    )
    .await?;
    let models = response
        .get("models")
        .and_then(Value::as_array)
        .context("Ollama models response missing models array")?
        .iter()
        .filter_map(|item| {
            item.get("name")
                .and_then(Value::as_str)
                .or_else(|| item.get("model").and_then(Value::as_str))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    Ok(dedupe_models(models))
}

async fn fetch_anthropic_model_ids(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
) -> anyhow::Result<Vec<String>> {
    let api_key = require_api_key(endpoint)?;
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", header_value(&api_key)?);
    headers.insert("anthropic-version", header_value("2023-06-01")?);
    let response = send_get_request(
        client,
        &anthropic_messages_url(&endpoint.base_url).replace("/messages", "/models"),
        headers,
    )
    .await?;
    let models = response
        .get("data")
        .and_then(Value::as_array)
        .context("Anthropic models response missing data array")?
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    Ok(dedupe_models(models))
}

async fn fetch_gemini_model_catalog(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let api_key = require_api_key(endpoint)?;
    let base = endpoint.base_url.trim_end_matches('/');
    let response = client
        .get(format!("{base}/models"))
        .query(&[("key", api_key.as_str()), ("pageSize", "1000")])
        .send()
        .await
        .with_context(|| format!("request failed: {base}/models"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("{} {}", status, text));
    }
    let json: Value = serde_json::from_str(&text)
        .with_context(|| format!("invalid JSON from {base}/models: {text}"))?;
    let models = json
        .get("models")
        .and_then(Value::as_array)
        .context("Gemini models response missing models array")?;
    let mut chat_models = Vec::new();
    let mut embedding_models = Vec::new();
    for model in models {
        let name = model
            .get("name")
            .and_then(Value::as_str)
            .map(normalized_model_name)
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let actions = model
            .get("supportedGenerationMethods")
            .and_then(Value::as_array)
            .or_else(|| model.get("supported_actions").and_then(Value::as_array));
        let supports_chat = actions
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|value| value == "generateContent")
            })
            .unwrap_or(false);
        let supports_embedding = actions
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|value| value == "embedContent")
            })
            .unwrap_or(false);
        if supports_chat {
            chat_models.push(name.clone());
        }
        if supports_embedding {
            embedding_models.push(name);
        }
    }
    Ok((dedupe_models(chat_models), dedupe_models(embedding_models)))
}

async fn get_endpoint_model_catalog_inner(
    state: &AppState,
    endpoint: AiEndpoint,
) -> anyhow::Result<EndpointModelCatalogResponse> {
    let endpoint = prepare_runtime_endpoint(state, endpoint)?;

    let fallback_chat = fallback_chat_models(&endpoint);
    let fallback_embedding = fallback_embedding_models(&endpoint);

    let (remote_chat, remote_embedding) = match endpoint.provider.as_str() {
        "openai" | "litellm" | "lmstudio" => {
            let models = fetch_openai_like_model_ids(&state.http, &endpoint).await?;
            let embedding_models = dedupe_models(
                models
                    .iter()
                    .filter(|model| looks_like_embedding_model(model))
                    .cloned()
                    .collect(),
            );
            let mut chat_models = dedupe_models(
                models
                    .iter()
                    .filter(|model| looks_like_chat_model(model))
                    .cloned()
                    .collect(),
            );
            if chat_models.is_empty() {
                chat_models = models.clone();
            }
            (chat_models, embedding_models)
        }
        "ollama" => {
            let models = fetch_ollama_model_ids(&state.http, &endpoint).await?;
            let embedding_models = dedupe_models(
                models
                    .iter()
                    .filter(|model| looks_like_embedding_model(model))
                    .cloned()
                    .collect(),
            );
            let chat_models = dedupe_models(
                models
                    .iter()
                    .filter(|model| !looks_like_embedding_model(model))
                    .cloned()
                    .collect(),
            );
            (chat_models, embedding_models)
        }
        "anthropic" => (
            fetch_anthropic_model_ids(&state.http, &endpoint).await?,
            Vec::new(),
        ),
        "gemini" => fetch_gemini_model_catalog(&state.http, &endpoint).await?,
        _ => (Vec::new(), Vec::new()),
    };

    let chat_models = dedupe_models([remote_chat.clone(), fallback_chat.clone()].concat());
    let embedding_models =
        dedupe_models([remote_embedding.clone(), fallback_embedding.clone()].concat());

    let provider = endpoint.provider.clone();

    Ok(EndpointModelCatalogResponse {
        provider,
        fetched_chat: !remote_chat.is_empty(),
        fetched_embeddings: !remote_embedding.is_empty(),
        used_fallback_chat: remote_chat.is_empty(),
        used_fallback_embeddings: provider_supports_embeddings(&endpoint.provider)
            && remote_embedding.is_empty(),
        chat_models,
        embedding_models,
    })
}

fn parse_embedding_array(value: &Value) -> anyhow::Result<Vec<f32>> {
    let array = value
        .as_array()
        .context("embedding payload was not an array")?;
    array
        .iter()
        .map(|item| {
            item.as_f64()
                .map(|number| number as f32)
                .context("embedding value was not numeric")
        })
        .collect()
}

async fn embed_texts_openai_like(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    texts: &[String],
) -> anyhow::Result<Vec<Vec<f32>>> {
    let mut headers = HeaderMap::new();
    if endpoint.provider == "openai" {
        let api_key = require_api_key(endpoint)?;
        headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
    } else if let Some(api_key) = maybe_api_key(endpoint)? {
        headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
    }

    let payload = json!({
        "model": endpoint.embedding_model,
        "input": texts,
    });
    let url = format!("{}/embeddings", openai_like_base(&endpoint.base_url));
    let response = send_json_request(client, &url, headers, payload).await?;
    let rows = response
        .get("data")
        .and_then(Value::as_array)
        .context("embedding response missing data array")?;
    rows.iter()
        .map(|item| {
            parse_embedding_array(
                item.get("embedding")
                    .context("embedding response item missing embedding")?,
            )
        })
        .collect()
}

async fn embed_texts_ollama(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    texts: &[String],
) -> anyhow::Result<Vec<Vec<f32>>> {
    let url = format!("{}/api/embed", endpoint.base_url.trim_end_matches('/'));
    let response = send_json_request(
        client,
        &url,
        HeaderMap::new(),
        json!({
            "model": endpoint.embedding_model,
            "input": texts,
        }),
    )
    .await?;

    if let Some(rows) = response.get("embeddings").and_then(Value::as_array) {
        return rows.iter().map(parse_embedding_array).collect();
    }
    if let Some(single) = response.get("embedding") {
        return Ok(vec![parse_embedding_array(single)?]);
    }
    Err(anyhow!(
        "Ollama embedding response did not include embedding data"
    ))
}

async fn embed_texts_gemini(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    texts: &[String],
) -> anyhow::Result<Vec<Vec<f32>>> {
    let api_key = require_api_key(endpoint)?;
    let mut output = Vec::with_capacity(texts.len());
    for text in texts {
        let mut headers = HeaderMap::new();
        headers.insert("x-goog-api-key", header_value(&api_key)?);
        let response = send_json_request(
            client,
            &gemini_embed_url(&endpoint.base_url, &endpoint.embedding_model),
            headers,
            json!({
                "content": {
                    "parts": [{ "text": text }]
                }
            }),
        )
        .await?;
        let vector = response
            .pointer("/embedding/values")
            .or_else(|| response.pointer("/embeddings/0/values"))
            .context("Gemini embedding response missing values")?;
        output.push(parse_embedding_array(vector)?);
    }
    Ok(output)
}

async fn embed_texts_for_endpoint(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    texts: &[String],
) -> anyhow::Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    match endpoint.provider.as_str() {
        "openai" | "litellm" | "lmstudio" => {
            let mut output = Vec::new();
            for batch in texts.chunks(EMBEDDING_BATCH_SIZE) {
                output.extend(embed_texts_openai_like(client, endpoint, batch).await?);
            }
            Ok(output)
        }
        "ollama" => {
            let mut output = Vec::new();
            for batch in texts.chunks(EMBEDDING_BATCH_SIZE) {
                output.extend(embed_texts_ollama(client, endpoint, batch).await?);
            }
            Ok(output)
        }
        "gemini" => embed_texts_gemini(client, endpoint, texts).await,
        "anthropic" => Err(anyhow!(
            "Anthropic does not have an embedding adapter configured in this app"
        )),
        _ => Err(anyhow!("unsupported provider: {}", endpoint.provider)),
    }
}

fn extract_openai_content(response: &Value) -> anyhow::Result<String> {
    let content = response
        .pointer("/choices/0/message/content")
        .context("response missing choices[0].message.content")?;
    if let Some(text) = content.as_str() {
        return Ok(text.to_string());
    }
    if let Some(parts) = content.as_array() {
        let joined = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.is_empty() {
            return Ok(joined);
        }
    }
    Err(anyhow!("unable to decode OpenAI-style response content"))
}

fn extract_anthropic_content(response: &Value) -> anyhow::Result<String> {
    let parts = response
        .get("content")
        .and_then(Value::as_array)
        .context("response missing content array")?;
    let joined = parts
        .iter()
        .filter_map(|part| {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                part.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if joined.is_empty() {
        return Err(anyhow!("unable to decode Anthropic response content"));
    }
    Ok(joined)
}

fn extract_gemini_content(response: &Value) -> anyhow::Result<String> {
    let parts = response
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .context("response missing Gemini candidate parts")?;
    let joined = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if joined.is_empty() {
        return Err(anyhow!("unable to decode Gemini response content"));
    }
    Ok(joined)
}

async fn chat_openai_like(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    system_prompt: &str,
    history: &[ChatMessagePayload],
    user_prompt: &str,
) -> anyhow::Result<String> {
    let mut headers = HeaderMap::new();
    if endpoint.provider == "openai" {
        let api_key = require_api_key(endpoint)?;
        headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
    } else if let Some(api_key) = maybe_api_key(endpoint)? {
        headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
    }

    let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
    messages.extend(history.iter().map(|message| {
        json!({
            "role": if message.role == "assistant" { "assistant" } else { "user" },
            "content": message.content,
        })
    }));
    messages.push(json!({ "role": "user", "content": user_prompt }));

    let url = format!("{}/chat/completions", openai_like_base(&endpoint.base_url));
    let response = send_json_request(
        client,
        &url,
        headers,
        json!({
            "model": endpoint.chat_model,
            "messages": messages,
        }),
    )
    .await?;
    extract_openai_content(&response)
}

async fn chat_ollama(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    system_prompt: &str,
    history: &[ChatMessagePayload],
    user_prompt: &str,
) -> anyhow::Result<String> {
    let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
    messages.extend(history.iter().map(|message| {
        json!({
            "role": if message.role == "assistant" { "assistant" } else { "user" },
            "content": message.content,
        })
    }));
    messages.push(json!({ "role": "user", "content": user_prompt }));
    let response = send_json_request(
        client,
        &format!("{}/api/chat", endpoint.base_url.trim_end_matches('/')),
        HeaderMap::new(),
        json!({
            "model": endpoint.chat_model,
            "messages": messages,
            "stream": false,
        }),
    )
    .await?;
    response
        .pointer("/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("unable to decode Ollama response content")
}

async fn chat_anthropic(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    system_prompt: &str,
    history: &[ChatMessagePayload],
    user_prompt: &str,
) -> anyhow::Result<String> {
    let api_key = require_api_key(endpoint)?;
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", header_value(&api_key)?);
    headers.insert("anthropic-version", header_value("2023-06-01")?);
    let mut messages = history
        .iter()
        .map(|message| {
            json!({
                "role": if message.role == "assistant" { "assistant" } else { "user" },
                "content": message.content,
            })
        })
        .collect::<Vec<_>>();
    messages.push(json!({ "role": "user", "content": user_prompt }));
    let response = send_json_request(
        client,
        &anthropic_messages_url(&endpoint.base_url),
        headers,
        json!({
            "model": endpoint.chat_model,
            "max_tokens": 1200,
            "system": system_prompt,
            "messages": messages,
        }),
    )
    .await?;
    extract_anthropic_content(&response)
}

async fn chat_gemini(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    system_prompt: &str,
    history: &[ChatMessagePayload],
    user_prompt: &str,
) -> anyhow::Result<String> {
    let api_key = require_api_key(endpoint)?;
    let mut headers = HeaderMap::new();
    headers.insert("x-goog-api-key", header_value(&api_key)?);
    let mut contents = history
        .iter()
        .map(|message| {
            json!({
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [{ "text": message.content }],
            })
        })
        .collect::<Vec<_>>();
    contents.push(json!({
        "role": "user",
        "parts": [{ "text": user_prompt }],
    }));
    let response = send_json_request(
        client,
        &gemini_generate_url(&endpoint.base_url, &endpoint.chat_model),
        headers,
        json!({
            "systemInstruction": {
                "parts": [{ "text": system_prompt }]
            },
            "contents": contents,
            "generationConfig": {}
        }),
    )
    .await?;
    extract_gemini_content(&response)
}

async fn chat_with_provider(
    client: &reqwest::Client,
    endpoint: &AiEndpoint,
    system_prompt: &str,
    history: &[ChatMessagePayload],
    user_prompt: &str,
) -> anyhow::Result<String> {
    if endpoint.chat_model.trim().is_empty() {
        return Err(anyhow!(
            "chat model is not configured for {}",
            endpoint.label
        ));
    }
    match endpoint.provider.as_str() {
        "openai" | "litellm" | "lmstudio" => {
            chat_openai_like(client, endpoint, system_prompt, history, user_prompt).await
        }
        "ollama" => chat_ollama(client, endpoint, system_prompt, history, user_prompt).await,
        "anthropic" => chat_anthropic(client, endpoint, system_prompt, history, user_prompt).await,
        "gemini" => chat_gemini(client, endpoint, system_prompt, history, user_prompt).await,
        _ => Err(anyhow!("unsupported provider: {}", endpoint.provider)),
    }
}

async fn test_chat_endpoint(client: &reqwest::Client, endpoint: &AiEndpoint) -> anyhow::Result<()> {
    if endpoint.chat_model.trim().is_empty() {
        return Err(anyhow!(
            "chat model is not configured for {}",
            endpoint.label
        ));
    }
    match endpoint.provider.as_str() {
        "openai" | "litellm" | "lmstudio" => {
            let mut headers = HeaderMap::new();
            if endpoint.provider == "openai" {
                let api_key = require_api_key(endpoint)?;
                headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
            } else if let Some(api_key) = maybe_api_key(endpoint)? {
                headers.insert(AUTHORIZATION, header_value(&format!("Bearer {api_key}"))?);
            }
            let url = format!("{}/chat/completions", openai_like_base(&endpoint.base_url));
            let _ = send_json_request(
                client,
                &url,
                headers,
                json!({
                    "model": endpoint.chat_model,
                    "messages": [{ "role": "user", "content": "ping" }]
                }),
            )
            .await?;
        }
        "ollama" => {
            let _ = send_json_request(
                client,
                &format!("{}/api/chat", endpoint.base_url.trim_end_matches('/')),
                HeaderMap::new(),
                json!({
                    "model": endpoint.chat_model,
                    "messages": [{ "role": "user", "content": "ping" }],
                    "stream": false
                }),
            )
            .await?;
        }
        "anthropic" => {
            let api_key = require_api_key(endpoint)?;
            let mut headers = HeaderMap::new();
            headers.insert("x-api-key", header_value(&api_key)?);
            headers.insert("anthropic-version", header_value("2023-06-01")?);
            let _ = send_json_request(
                client,
                &anthropic_messages_url(&endpoint.base_url),
                headers,
                json!({
                    "model": endpoint.chat_model,
                    "max_tokens": 8,
                    "messages": [{ "role": "user", "content": "ping" }]
                }),
            )
            .await?;
        }
        "gemini" => {
            let api_key = require_api_key(endpoint)?;
            let mut headers = HeaderMap::new();
            headers.insert("x-goog-api-key", header_value(&api_key)?);
            let _ = send_json_request(
                client,
                &gemini_generate_url(&endpoint.base_url, &endpoint.chat_model),
                headers,
                json!({
                    "contents": [{
                        "role": "user",
                        "parts": [{ "text": "ping" }]
                    }]
                }),
            )
            .await?;
        }
        _ => return Err(anyhow!("unsupported provider: {}", endpoint.provider)),
    }
    Ok(())
}

async fn test_ai_endpoint_inner(
    state: &AppState,
    endpoint: AiEndpoint,
) -> anyhow::Result<EndpointTestResponse> {
    let endpoint = prepare_runtime_endpoint(state, endpoint)?;
    let has_api_key = maybe_api_key(&endpoint)?.is_some();

    test_chat_endpoint(&state.http, &endpoint).await?;

    let mut checked_embeddings = false;
    if provider_supports_embeddings(&endpoint.provider) {
        if endpoint.embedding_model.trim().is_empty() {
            return Err(anyhow!(
                "embedding model is not configured for {}",
                endpoint.label
            ));
        }
        let _ = embed_texts_for_endpoint(&state.http, &endpoint, &[String::from("ping")]).await?;
        checked_embeddings = true;
    }

    let details = if checked_embeddings {
        format!(
            "{} chat and embedding models responded successfully.",
            endpoint.label
        )
    } else {
        format!("{} chat model responded successfully.", endpoint.label)
    };

    Ok(EndpointTestResponse {
        ok: true,
        status: "connected".to_string(),
        details,
        checked_chat: true,
        checked_embeddings,
        has_api_key,
    })
}

async fn index_pdf_document_inner(
    state: &AppState,
    request: IndexPdfDocumentRequest,
) -> anyhow::Result<IndexPdfDocumentResponse> {
    if request.document_id.trim().is_empty() {
        return Err(anyhow!("documentId is required"));
    }

    let mut conn = open_database(&state.database_path)?;
    let text_updated = upsert_document_chunks(&mut conn, &request)?;

    let mut embeddings_updated = false;
    let mut vector_ready = false;
    let mut vector_dimensions = None;
    let mut last_indexed_at = None;
    if let Some(endpoint_id) = request.endpoint_id.as_deref() {
        let conn = open_database(&state.database_path)?;
        let endpoint = get_endpoint_by_id(&conn, endpoint_id)?;
        let (did_update_embeddings, did_prepare_vector, dims) =
            ensure_embeddings_for_document(state, &endpoint, &request).await?;
        embeddings_updated = did_update_embeddings;
        vector_ready = did_prepare_vector;
        vector_dimensions = dims;
        if provider_supports_embeddings(&endpoint.provider)
            && !endpoint.embedding_model.trim().is_empty()
        {
            let conn = open_database(&state.database_path)?;
            last_indexed_at = load_vector_index_record(
                &conn,
                &request.document_id,
                vector_service_key(&endpoint),
                &endpoint.embedding_model,
            )?
            .map(|record| record.updated_at);
        }
    }

    if last_indexed_at.is_none() {
        let conn = open_database(&state.database_path)?;
        last_indexed_at = load_document_index_updated_at(&conn, &request.document_id)?;
    }

    let search_mode = if vector_ready { "bm25+vector" } else { "bm25" };
    let reused_existing = !text_updated && !embeddings_updated;
    Ok(IndexPdfDocumentResponse {
        document_id: request.document_id,
        stored_chunks: request.chunks.len(),
        text_updated,
        embeddings_updated,
        vector_ready,
        vector_dimensions,
        search_mode: search_mode.to_string(),
        last_indexed_at,
        reused_existing,
        database_path: state.database_path.to_string_lossy().to_string(),
    })
}

async fn chat_with_pdf_inner(
    state: &AppState,
    request: ChatWithPdfRequest,
) -> anyhow::Result<ChatWithPdfResponse> {
    let conn = open_database(&state.database_path)?;
    let endpoint = get_endpoint_by_id(&conn, &request.endpoint_id)?;
    if !endpoint.enabled {
        return Err(anyhow!("selected AI endpoint is disabled"));
    }

    let (snippets, search_mode) = retrieve_context_for_query(
        state,
        &endpoint,
        &request.document_id,
        &request.user_message,
    )
    .await?;

    if snippets.is_empty() {
        return Ok(ChatWithPdfResponse {
            content: "현재 열린 PDF에서 질문과 관련된 본문을 찾지 못했습니다. AI 설정이나 임베딩 모델을 확인한 뒤 다시 시도하세요.".to_string(),
            citations: Vec::new(),
            search_mode,
            endpoint_label: endpoint.label,
        });
    }

    let history = truncate_history(&request.history);
    let document_title = request
        .document_title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Open PDF");
    let system_prompt = build_system_prompt(&search_mode);
    let user_prompt = build_context_prompt(document_title, &request.user_message, &snippets);
    let content = chat_with_provider(
        &state.http,
        &endpoint,
        &system_prompt,
        &history,
        &user_prompt,
    )
    .await?;

    Ok(ChatWithPdfResponse {
        content,
        citations: snippets,
        search_mode,
        endpoint_label: endpoint.label,
    })
}

async fn compact_chat_history_inner(
    state: &AppState,
    request: CompactChatHistoryRequest,
) -> anyhow::Result<CompactChatHistoryResponse> {
    let endpoint = prepare_runtime_endpoint(state, request.endpoint)?;
    if !endpoint.enabled {
        return Err(anyhow!("selected AI endpoint is disabled"));
    }
    if request.messages.len() <= CHAT_COMPACT_KEEP_RECENT {
        return Err(anyhow!("conversation is already compact enough"));
    }

    let compacted_count = request.messages.len() - CHAT_COMPACT_KEEP_RECENT;
    let transcript = build_compaction_transcript(&request.messages[..compacted_count]);
    if transcript.trim().is_empty() {
        return Err(anyhow!("no earlier conversation content to compact"));
    }

    let document_title = request
        .document_title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Open PDF");
    let (system_prompt, user_prompt) = build_compaction_prompt(document_title, &transcript);
    let content =
        chat_with_provider(&state.http, &endpoint, &system_prompt, &[], &user_prompt).await?;

    Ok(CompactChatHistoryResponse {
        content,
        endpoint_label: endpoint.label,
        compacted_count,
        kept_recent_count: CHAT_COMPACT_KEEP_RECENT,
    })
}

fn protect_pdf_inner(request: ProtectPdfRequest) -> anyhow::Result<()> {
    let password = request.password.trim();
    if password.is_empty() {
        return Err(anyhow!("password is required"));
    }
    if request.pdf_bytes.is_empty() {
        return Err(anyhow!("pdf bytes are empty"));
    }

    let owner_password = request
        .owner_password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(password);

    let mut document = LoDocument::load_mem(&request.pdf_bytes)
        .context("failed to parse PDF bytes for encryption")?;
    if document.is_encrypted() {
        return Err(anyhow!("document is already encrypted"));
    }
    ensure_pdf_file_id(&mut document, &request.pdf_bytes);

    let version = EncryptionVersion::V2 {
        document: &document,
        owner_password,
        user_password: password,
        key_length: 128,
        permissions: Permissions::all(),
    };
    let state = EncryptionState::try_from(version)
        .context("failed to build PDF encryption state")?;
    document
        .encrypt(&state)
        .context("failed to encrypt PDF document")?;
    document
        .save(&request.output_path)
        .with_context(|| format!("failed to save encrypted PDF: {}", request.output_path))?;
    Ok(())
}

fn unprotect_pdf_inner(request: UnprotectPdfRequest) -> anyhow::Result<()> {
    let password = request.password.trim();
    if password.is_empty() {
        return Err(anyhow!("password is required"));
    }

    let mut document = LoDocument::load(&request.input_path)
        .or_else(|_| LoDocument::load_with_password(&request.input_path, password))
        .with_context(|| format!("failed to open PDF: {}", request.input_path))?;

    if document.is_encrypted() {
        document
            .decrypt(password)
            .context("failed to decrypt PDF document")?;
    }

    document
        .save(&request.output_path)
        .with_context(|| format!("failed to save decrypted PDF: {}", request.output_path))?;
    Ok(())
}

fn inspect_pdf_security_inner(
    request: InspectPdfSecurityRequest,
) -> anyhow::Result<InspectPdfSecurityResponse> {
    if request.pdf_bytes.is_empty() {
        return Err(anyhow!("pdf bytes are empty"));
    }
    let document = LoDocument::load_mem(&request.pdf_bytes)
        .context("failed to parse PDF bytes for security inspection")?;
    Ok(InspectPdfSecurityResponse {
        is_encrypted: document.is_encrypted(),
    })
}

fn apply_pdf_text_edits_inner(
    request: ApplyPdfTextEditsRequest,
) -> anyhow::Result<ApplyPdfTextEditsResponse> {
    if request.pdf_bytes.is_empty() {
        return Err(anyhow!("pdf bytes are empty"));
    }

    let mut document = LoDocument::load_mem(&request.pdf_bytes)
        .context("failed to parse PDF bytes for text editing")?;
    let mut applied_edits = 0usize;

    for edit in request.edits {
        let search_text = edit.search_text.trim();
        if search_text.is_empty() {
            continue;
        }
        let replacements = document
            .replace_partial_text(
                edit.page_number,
                search_text,
                edit.replacement_text.as_str(),
                Some(" "),
            )
            .with_context(|| {
                format!(
                    "failed to replace text on page {} for '{}'",
                    edit.page_number, search_text
                )
            })?;
        if replacements > 0 {
            applied_edits += 1;
        }
    }

    let mut buffer = Vec::new();
    document
        .save_to(&mut buffer)
        .context("failed to serialize edited PDF")?;

    Ok(ApplyPdfTextEditsResponse {
        pdf_bytes: buffer,
        applied_edits,
    })
}

#[tauri::command]
fn take_next_pending_pdf_path(state: State<'_, PendingPdfPaths>) -> Option<String> {
    if let Ok(mut queue) = state.queue.lock() {
        if queue.is_empty() {
            None
        } else {
            Some(queue.remove(0))
        }
    } else {
        None
    }
}

#[tauri::command]
fn load_app_settings(state: State<'_, AppState>) -> Result<SettingsBundle, String> {
    load_settings_bundle_inner(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_app_settings(
    state: State<'_, AppState>,
    request: SaveSettingsRequest,
) -> Result<(), String> {
    save_settings_inner(&state, request).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_chat_session(
    state: State<'_, AppState>,
    request: SaveChatSessionRequest,
) -> Result<ChatSessionResponse, String> {
    save_chat_session_inner(&state, request).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_chat_session(
    state: State<'_, AppState>,
    request: LoadChatSessionRequest,
) -> Result<Option<ChatSessionResponse>, String> {
    load_chat_session_inner(&state, request).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_chat_session(
    state: State<'_, AppState>,
    request: DeleteChatSessionRequest,
) -> Result<(), String> {
    delete_chat_session_inner(&state, request).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_ai_endpoint(
    state: State<'_, AppState>,
    endpoint: AiEndpoint,
) -> Result<AiEndpoint, String> {
    save_ai_endpoint_inner(&state, endpoint).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_ai_endpoint(
    state: State<'_, AppState>,
    request: DeleteAiEndpointRequest,
) -> Result<(), String> {
    delete_ai_endpoint_inner(&state, request).map_err(|error| error.to_string())
}

#[tauri::command]
async fn index_pdf_document(
    state: State<'_, AppState>,
    request: IndexPdfDocumentRequest,
) -> Result<IndexPdfDocumentResponse, String> {
    index_pdf_document_inner(&state, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn chat_with_pdf(
    state: State<'_, AppState>,
    request: ChatWithPdfRequest,
) -> Result<ChatWithPdfResponse, String> {
    chat_with_pdf_inner(&state, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn compact_chat_history(
    state: State<'_, AppState>,
    request: CompactChatHistoryRequest,
) -> Result<CompactChatHistoryResponse, String> {
    compact_chat_history_inner(&state, request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn test_ai_endpoint(
    state: State<'_, AppState>,
    endpoint: AiEndpoint,
) -> Result<EndpointTestResponse, String> {
    test_ai_endpoint_inner(&state, endpoint)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_endpoint_model_catalog(
    state: State<'_, AppState>,
    endpoint: AiEndpoint,
) -> Result<EndpointModelCatalogResponse, String> {
    get_endpoint_model_catalog_inner(&state, endpoint)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn protect_pdf(request: ProtectPdfRequest) -> Result<(), String> {
    protect_pdf_inner(request).map_err(|error| error.to_string())
}

#[tauri::command]
fn unprotect_pdf(request: UnprotectPdfRequest) -> Result<(), String> {
    unprotect_pdf_inner(request).map_err(|error| error.to_string())
}

#[tauri::command]
fn inspect_pdf_security(
    request: InspectPdfSecurityRequest,
) -> Result<InspectPdfSecurityResponse, String> {
    inspect_pdf_security_inner(request).map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_pdf_text_edits(
    request: ApplyPdfTextEditsRequest,
) -> Result<ApplyPdfTextEditsResponse, String> {
    apply_pdf_text_edits_inner(request).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (config_dir, database_path) =
        resolve_storage_paths().expect("failed to prepare config directory");
    initialize_secret_store();
    if let Err(error) = open_database(&database_path) {
        eprintln!("failed to initialize database: {error:#}");
    }

    tauri::Builder::default()
        .manage(PendingPdfPaths::default())
        .manage(AppState {
            config_dir,
            database_path,
            http: reqwest::Client::builder()
                .user_agent("PDF_Split_Rotate_Select_Save/0.1.6")
                .build()
                .expect("failed to build HTTP client"),
        })
        .invoke_handler(tauri::generate_handler![
            take_next_pending_pdf_path,
            load_app_settings,
            save_app_settings,
            save_chat_session,
            load_chat_session,
            delete_chat_session,
            save_ai_endpoint,
            delete_ai_endpoint,
            index_pdf_document,
            chat_with_pdf,
            compact_chat_history,
            test_ai_endpoint,
            get_endpoint_model_catalog,
            protect_pdf,
            unprotect_pdf,
            inspect_pdf_security,
            apply_pdf_text_edits
        ])
        .setup(|app| {
            let startup_paths = collect_pdf_paths(std::env::args_os().skip(1));
            let state = app.state::<PendingPdfPaths>();
            enqueue_pdf_paths(&state, startup_paths);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            WindowStateBuilder::default()
                .map_label(|label| {
                    if label == "main" || label.starts_with("main-") {
                        "main"
                    } else {
                        label
                    }
                })
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::Opened { urls } => {
                    let paths = urls
                        .iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .filter(|path| is_pdf_path(path))
                        .map(|path| path.to_string_lossy().to_string())
                        .collect::<Vec<_>>();
                    if !paths.is_empty() {
                        let state = _app.state::<PendingPdfPaths>();
                        enqueue_pdf_paths(&state, paths.clone());
                        for _ in paths {
                            create_main_like_window(_app);
                        }
                    }
                }
                tauri::RunEvent::Reopen { .. } => {
                    create_main_like_window(_app);
                }
                _ => {}
            }
        });
}
