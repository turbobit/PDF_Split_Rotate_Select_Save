use std::ffi::OsString;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri::{Manager, State};

#[derive(Default)]
struct PendingPdfPaths {
    queue: Mutex<Vec<String>>,
}

#[cfg(target_os = "macos")]
static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

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
        .build();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingPdfPaths::default())
        .invoke_handler(tauri::generate_handler![take_next_pending_pdf_path])
        .setup(|app| {
            let startup_paths = collect_pdf_paths(std::env::args_os().skip(1));
            let state = app.state::<PendingPdfPaths>();
            enqueue_pdf_paths(&state, startup_paths);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
