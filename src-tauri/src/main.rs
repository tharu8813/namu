#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod locode;
mod ollama;

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

/// 앱이 직접 띄운 ollama 프로세스. 이미 실행 중인 사용자 인스턴스는 여기 저장하지 않는다
/// (즉, 종료 시 우리가 띄운 것만 정리한다).
struct Ollama(Mutex<Option<Child>>);

fn ollama_up() -> bool {
    TcpStream::connect_timeout(&"127.0.0.1:11434".parse().unwrap(), Duration::from_millis(400)).is_ok()
}

/// 실행할 ollama 경로를 찾는다: ① 동봉 런타임 (설치 방식마다 위치가 달라 여러 후보를
/// 확인한다) → ② PATH 의 ollama.
fn find_ollama(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("ollama").join(name));
    }
    // Inno Setup 은 실행 파일 옆 ollama\ 에 둔다. NSIS/개발 빌드는 resources\ollama\ 를 쓴다.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("ollama").join(name));
            candidates.push(dir.join("resources").join("ollama").join(name));
        }
    }
    if let Some(hit) = candidates.into_iter().find(|p| p.exists()) {
        return Some(hit);
    }
    // PATH 에 있으면 이름만으로 실행 가능
    if Command::new(name).arg("--version").output().is_ok() {
        return Some(PathBuf::from(name));
    }
    None
}

fn spawn_ollama(app: &tauri::AppHandle) {
    if ollama_up() {
        return; // 이미 떠 있으면 그대로 사용 (종료 시에도 건드리지 않는다)
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

/// 앱이 띄운 ollama 와 그 자식(모델을 로드하는 runner) 프로세스를 모두 종료한다.
/// `ollama serve` 는 runner 를 별도 프로세스로 띄우므로 부모만 kill 하면 runner 가
/// 남아 모델을 RAM 에 계속 물고 있다 — 그래서 프로세스 트리째 종료한다.
fn kill_ollama(app: &tauri::AppHandle) {
    let child = app.state::<Ollama>().0.lock().unwrap().take();
    if let Some(mut child) = child {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &child.id().to_string()])
                .creation_flags(0x0800_0000)
                .output();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// 메인 창을 보이고 앞으로 가져온다 (트레이 클릭 / 두 번째 실행 시).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
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

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "열기", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Namu")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                kill_ollama(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // 두 번째 실행은 새 프로세스를 띄우지 않고 기존 창을 앞으로 가져온다. (첫 플러그인이어야 함)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
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
            locode::locode_edit_file,
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
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 창을 닫아도 종료하지 않고 트레이로 숨긴다. 완전 종료는 트레이 우클릭 → 종료.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 앱 초기화 오류")
        .run(|app, event| {
            // app.exit() 이든 OS 종료든 최종적으로 ollama 를 정리한다.
            if let RunEvent::Exit = event {
                kill_ollama(app);
            }
        });
}
