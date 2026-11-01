//! Cancellable Ollama HTTP transport.
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::sync::watch;

struct Request {
    cancel: watch::Sender<bool>,
    active: bool,
    created: Instant,
}
#[derive(Default, Clone)]
pub struct StreamRegistry(Arc<Mutex<HashMap<String, Request>>>);
impl StreamRegistry {
    pub fn register(&self, id: &str) -> Result<watch::Receiver<bool>, String> {
        if id.is_empty() || id.len() > 128 {
            return Err("잘못된 요청 ID".into());
        }
        let mut map = self.0.lock().unwrap();
        map.retain(|_, r| r.active || r.created.elapsed() < Duration::from_secs(120));
        if map.len() >= 64 {
            return Err("동시 요청 한도 초과".into());
        }
        if let Some(r) = map.get_mut(id) {
            if r.active {
                return Err("중복 요청 ID".into());
            }
            r.active = true;
            return Ok(r.cancel.subscribe());
        }
        let (cancel, rx) = watch::channel(false);
        map.insert(
            id.into(),
            Request {
                cancel,
                active: true,
                created: Instant::now(),
            },
        );
        Ok(rx)
    }
    pub fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    pub fn cancel(&self, id: &str) {
        if id.is_empty() || id.len() > 128 {
            return;
        }
        let mut map = self.0.lock().unwrap();
        if let Some(r) = map.get(id) {
            r.cancel.send_replace(true);
        } else if map.len() < 64 {
            let (cancel, _) = watch::channel(true);
            map.insert(
                id.into(),
                Request {
                    cancel,
                    active: false,
                    created: Instant::now(),
                },
            );
        }
    }
}
pub async fn cancellable<T>(
    mut cancel: watch::Receiver<bool>,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    if *cancel.borrow() {
        return Err("취소됨".into());
    }
    tokio::select! { result = future => result, _ = cancel.changed() => Err("취소됨".into()) }
}
#[derive(Serialize, Debug)]
pub struct OllamaResp {
    status: u16,
    body: String,
}
fn endpoint(base: &str, path: &str, method: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(base).map_err(|_| "Ollama 주소가 올바르지 않습니다")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err("Ollama 주소는 인증 정보 없는 HTTP(S) 서버 주소여야 합니다".into());
    }
    if !matches!(
        (method, path),
        ("GET", "/api/tags" | "/api/version")
            | (
                "POST",
                "/api/show" | "/api/chat" | "/api/generate" | "/api/pull"
            )
            | ("DELETE", "/api/delete")
    ) {
        return Err("허용되지 않은 Ollama API".into());
    }
    u.join(path).map_err(|_| "잘못된 API 경로".into())
}
async fn request(
    base: String,
    path: String,
    method: String,
    body: Option<String>,
    on_line: Option<Channel<String>>,
) -> Result<OllamaResp, String> {
    let url = endpoint(&base, &path, &method)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(if path == "/api/pull" {
            600
        } else {
            180
        }))
        .build()
        .map_err(|_| "HTTP 초기화 실패")?;
    let mut req = client.request(method.parse().map_err(|_| "잘못된 메서드")?, url);
    if let Some(b) = body {
        if b.len() > 40 * 1024 * 1024 {
            return Err("Ollama 요청 크기 초과".into());
        }
        req = req.header("Content-Type", "application/json").body(b);
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "Ollama 응답 시간 초과"
        } else {
            "Ollama 연결 실패"
        }
    })?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let mut stream = resp.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Ollama 오류 응답 연결 종료")?;
            if bytes.len() + chunk.len() > 64 * 1024 {
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let error = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .map(|s| crate::locode::mask_secrets(&s).0)
            .unwrap_or_else(|| format!("Ollama HTTP {status}"));
        return Ok(OllamaResp {
            status,
            body: serde_json::json!({"error": error}).to_string(),
        });
    }
    let mut stream = resp.bytes_stream();
    let mut buffer = Vec::new();
    let mut total = 0usize;
    let mut done = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Ollama 응답 연결이 중간에 끊겼습니다")?;
        total += chunk.len();
        if total > 40 * 1024 * 1024 {
            return Err("Ollama 응답 크기 초과".into());
        }
        buffer.extend_from_slice(&chunk);
        if let Some(ch) = &on_line {
            while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                emit(&line, ch, &mut done)?;
            }
            if buffer.len() > 1024 * 1024 {
                return Err("Ollama 스트림 줄 크기 초과".into());
            }
        }
    }
    if let Some(ch) = &on_line {
        if !buffer.is_empty() {
            emit(&buffer, ch, &mut done)?;
        }
        if !done {
            return Err("Ollama 응답이 완료 신호 없이 종료되었습니다 (부분 응답)".into());
        }
        Ok(OllamaResp {
            status,
            body: String::new(),
        })
    } else {
        Ok(OllamaResp {
            status,
            body: String::from_utf8(buffer).map_err(|_| "잘못된 Ollama 문자 인코딩")?,
        })
    }
}
fn emit(bytes: &[u8], ch: &Channel<String>, done: &mut bool) -> Result<(), String> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "Ollama 스트림 JSON이 손상되었습니다")?;
    if let Some(err) = value.get("error") {
        return Err(crate::locode::mask_secrets(&err.to_string()).0);
    }
    *done |= value["done"] == true || value["status"] == "success";
    ch.send(value.to_string())
        .map_err(|_| "응답 채널이 닫혔습니다".into())
}
#[tauri::command]
pub async fn ollama_request(
    reg: tauri::State<'_, StreamRegistry>,
    base: String,
    method: String,
    path: String,
    body: Option<String>,
    request_id: String,
) -> Result<OllamaResp, String> {
    let rx = reg.register(&request_id)?;
    let result = cancellable(rx, request(base, path, method, body, None)).await;
    reg.remove(&request_id);
    result
}
#[tauri::command]
pub async fn ollama_stream(
    reg: tauri::State<'_, StreamRegistry>,
    base: String,
    path: String,
    body: String,
    stream_id: String,
    on_line: Channel<String>,
) -> Result<(), String> {
    let rx = reg.register(&stream_id)?;
    let result = cancellable(
        rx,
        request(base, path, "POST".into(), Some(body), Some(on_line)),
    )
    .await;
    reg.remove(&stream_id);
    let response = result?;
    if response.status >= 300 {
        let value: serde_json::Value = serde_json::from_str(&response.body).unwrap_or_default();
        return Err(value["error"]
            .as_str()
            .unwrap_or("Ollama HTTP 오류")
            .to_owned());
    }
    Ok(())
}
#[tauri::command]
pub fn ollama_cancel(reg: tauri::State<'_, StreamRegistry>, stream_id: String) {
    reg.cancel(&stream_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_cancel_survives_registration() {
        let reg = StreamRegistry::default();
        reg.cancel("early");
        assert!(*reg.register("early").unwrap().borrow());
        assert!(reg.register("early").is_err());
        reg.remove("early");
        assert!(!*reg.register("early").unwrap().borrow());
    }
    #[test]
    fn restrict_proxy_paths() {
        assert!(endpoint("http://localhost:11434", "/api/chat", "POST").is_ok());
        assert!(endpoint("http://user:pass@localhost", "/api/chat", "POST").is_err());
        assert!(endpoint("http://localhost", "//evil.org", "GET").is_err());
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_closes_inflight_http_even_before_response_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let reg = StreamRegistry::default();
        let cancel = reg.register("request").unwrap();
        let registry = reg.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut b = [0; 1024];
            assert!(socket.read(&mut b).await.unwrap() > 0);
            registry.cancel("request");
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut b))
                .await
                .unwrap()
                .unwrap()
        });
        let result = cancellable(
            cancel,
            request(
                base,
                "/api/chat".into(),
                "POST".into(),
                Some("{}".into()),
                None,
            ),
        )
        .await;
        assert!(result.unwrap_err().contains("취소"));
        assert_eq!(server.await.unwrap(), 0);
    }
}
