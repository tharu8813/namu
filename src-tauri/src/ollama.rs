// ollama.rs — Ollama HTTP 프록시.
// Tauri 웹뷰의 origin(http://tauri.localhost)은 Ollama 기본 CORS 허용 목록에 없어
// 브라우저 fetch 가 403 을 받는다. 그래서 모든 Ollama 호출을 Rust 를 통해 중계한다.
// (웹 미리보기에서는 프런트가 기존처럼 직접 fetch 한다.)

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct StreamRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

impl StreamRegistry {
    fn insert(&self, id: String, flag: Arc<AtomicBool>) {
        self.0.lock().unwrap().insert(id, flag);
    }
    fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    fn cancel(&self, id: &str) {
        if let Some(f) = self.0.lock().unwrap().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Serialize)]
pub struct OllamaResp {
    status: u16,
    body: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(600))
        .build()
}

fn join(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

/// 단발성 요청 (tags / show / delete / generate / 비스트리밍 chat 등).
#[tauri::command]
pub async fn ollama_request(
    base: String,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<OllamaResp, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = join(&base, &path);
        let a = agent();
        let req = match method.to_uppercase().as_str() {
            "GET" => a.get(&url),
            "POST" => a.post(&url),
            "DELETE" => a.delete(&url),
            other => return Err(format!("지원하지 않는 메서드: {other}")),
        };
        let result = match body {
            Some(b) => req.set("Content-Type", "application/json").send_string(&b),
            None => req.call(),
        };
        match result {
            Ok(r) => Ok(OllamaResp {
                status: r.status(),
                body: r.into_string().unwrap_or_default(),
            }),
            Err(ureq::Error::Status(code, r)) => Ok(OllamaResp {
                status: code,
                body: r.into_string().unwrap_or_default(),
            }),
            Err(e) => Err(format!("Ollama 연결 실패: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 스트리밍 요청 (chat / pull). NDJSON 을 한 줄씩 on_line 채널로 보낸다.
/// stream_id 로 ollama_cancel 을 호출하면 중단된다.
#[tauri::command]
pub async fn ollama_stream(
    reg: tauri::State<'_, StreamRegistry>,
    base: String,
    path: String,
    body: String,
    stream_id: String,
    on_line: Channel<String>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    reg.insert(stream_id.clone(), cancel.clone());

    let res = tauri::async_runtime::spawn_blocking(move || {
        let url = join(&base, &path);
        let resp = agent()
            .post(&url)
            .set("Content-Type", "application/json")
            .send_string(&body);
        let reader = match resp {
            Ok(r) => r.into_reader(),
            Err(ureq::Error::Status(code, r)) => {
                let msg = r.into_string().unwrap_or_default().replace('"', "'");
                let _ = on_line.send(format!("{{\"error\":\"HTTP {code}: {msg}\"}}"));
                return;
            }
            Err(e) => {
                let _ = on_line.send(format!("{{\"error\":\"{}\"}}", e.to_string().replace('"', "'")));
                return;
            }
        };
        for line in BufReader::new(reader).lines() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if on_line.send(l).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    })
    .await;

    reg.remove(&stream_id);
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ollama_cancel(reg: tauri::State<'_, StreamRegistry>, stream_id: String) {
    reg.cancel(&stream_id);
}
