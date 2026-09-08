#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod locode;
mod ollama;

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

/// 앱이 띄운 ollama 프로세스. 종료 시 같이 정리한다.
struct Ollama(Mutex<Option<Child>>);

fn ollama_up() -> bool {
    TcpStream::connect_timeout(&"127.0.0.1:11434".parse().unwrap(), Duration::from_millis(400)).is_ok()
}

/// 실행할 ollama 경로를 찾는다: ① 앱에 동봉된 resources/ollama/ollama.exe → ② PATH 의 ollama.
fn find_ollama(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("ollama").join(if cfg!(windows) { "ollama.exe" } else { "ollama" });
        if bundled.exists() {
            return Some(bundled);
        }
    }
    // PATH 에 있으면 이름만으로 실행 가능
    let name = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    if Command::new(name).arg("--version").output().is_ok() {
        return Some(PathBuf::from(name));
    }
    None
}

fn spawn_ollama(app: &tauri::AppHandle) {
    if ollama_up() {
        return; // 이미 떠 있으면 그대로 사용
    }
    let Some(bin) = find_ollama(app) else {
        eprintln!("ollama 를 찾지 못했습니다. 사용자가 직접 설치해야 합니다.");
        return;
    };
    let mut cmd = Command::new(&bin);
    cmd.arg("serve");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.spawn() {
        Ok(child) => {
            *app.state::<Ollama>().0.lock().unwrap() = Some(child);
        }
        Err(e) => eprintln!("ollama 실행 실패: {e}"),
    }
}

/// 가장 여유 공간이 큰 디스크의 남은 용량(GB). 모델 다운로드 전 경고용.
#[tauri::command]
fn disk_free_gb() -> f64 {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let max = disks.iter().map(|d| d.available_space()).max().unwrap_or(0);
    max as f64 / 1_000_000_000.0
}

/// 기본 브라우저로 URL 열기. http/https 만 허용(명령 주입 방지).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("허용되지 않은 URL".into());
    }
    #[cfg(windows)]
    let r = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Ollama(Mutex::new(None)))
        .manage(locode::LocodeState::default())
        .manage(locode::RunRegistry::default())
        .manage(ollama::StreamRegistry::default())
        .invoke_handler(tauri::generate_handler![
            disk_free_gb,
            open_url,
            ollama::ollama_request,
            ollama::ollama_stream,
            ollama::ollama_cancel,
            locode::locode_open_project,
            locode::locode_reopen,
            locode::locode_close_project,
            locode::locode_project_info,
            locode::locode_list_dir,
            locode::locode_read_file,
            locode::locode_write_file,
            locode::locode_move,
            locode::locode_delete,
            locode::locode_search,
            locode::locode_git_status,
            locode::locode_command_policy,
            locode::locode_run,
            locode::locode_stop_run,
            locode::locode_read_audit,
            locode::locode_audit,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || spawn_ollama(&handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window.app_handle().state::<Ollama>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri 앱 실행 중 오류");
}
