// locode.rs — LOCODE 모드의 안전한 파일 시스템 계층.
// 원칙: 프런트엔드는 상대 경로만 넘긴다. 모든 경로 검증·비밀 마스킹은 여기서 한다.
// Phase 1: 읽기 전용 (열기 / 목록 / 읽기 / 검색 / git 상태 / 감사 로그).

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Channel;

/// 현재 열린 프로젝트 루트(정규화된 실제 경로). 없으면 LOCODE 파일 접근 전부 거부.
#[derive(Default)]
pub struct LocodeState {
    pub root: Mutex<Option<PathBuf>>,
}

/// 실행 중인 명령은 프로젝트당 하나만 허용한다. 프로세스 핸들은 중지 명령에서 종료한다.
#[derive(Default, Clone)]
pub struct RunRegistry(Arc<Mutex<HashMap<String, RunHandle>>>);

#[derive(Clone)]
struct RunHandle {
    child: Arc<Mutex<Child>>,
    stopped: Arc<AtomicBool>,
}

impl RunRegistry {
    fn insert(&self, id: String, handle: RunHandle) -> Result<(), String> {
        let mut runs = self.0.lock().unwrap();
        if !runs.is_empty() {
            return Err("이미 실행 중인 명령이 있습니다. 완료하거나 중지한 뒤 다시 시도하세요.".into());
        }
        runs.insert(id, handle);
        Ok(())
    }
    fn remove(&self, id: &str) { self.0.lock().unwrap().remove(id); }
    fn stop(&self, id: &str) -> bool {
        let handle = self.0.lock().unwrap().get(id).cloned();
        if let Some(handle) = handle {
            handle.stopped.store(true, Ordering::Relaxed);
            let _ = handle.child.lock().unwrap().kill();
            true
        } else { false }
    }
}

#[derive(Serialize)]
pub struct ProjectInfo {
    path: String,
    name: String,
    is_git: bool,
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    kind: &'static str, // "dir" | "file"
    size: u64,
    hidden: bool,
}

#[derive(Serialize)]
pub struct FileContent {
    content: String,
    truncated: bool,
    masked: u32,
    bytes: u64,
    mtime: u64,
}

#[derive(Serialize)]
pub struct WriteResult {
    created: bool,
    before: Option<String>,
    mtime: u64,
}

#[derive(Serialize)]
pub struct Hit {
    path: String,
    line: u32,
    text: String,
}

#[derive(Serialize)]
pub struct GitStatus {
    is_git: bool,
    branch: String,
    ahead: i32,
    behind: i32,
    files: Vec<GitFile>,
}

#[derive(Serialize)]
pub struct GitFile {
    path: String,
    status: String,
}

#[derive(Serialize)]
pub struct CommandPolicy { level: String, reason: String }

#[derive(Serialize)]
pub struct RunResult {
    exit_code: Option<i32>,
    timed_out: bool,
    stopped: bool,
    truncated: bool,
}

const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_SCAN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HITS: usize = 200;
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next", ".nuxt", "vendor",
    "__pycache__", ".venv", "venv", ".cache", "coverage", ".idea", ".vscode",
];
// 읽기 자체를 막는 비밀 파일 (basename 매칭)
const SECRET_FILES: &[&str] = &[
    ".env", ".env.local", ".env.production", ".env.development", ".env.test",
    ".npmrc", ".pypirc", ".netrc", ".git-credentials",
    "id_rsa", "id_ed25519", "id_dsa", "id_ecdsa",
];
const SECRET_EXT: &[&str] = &["pem", "key", "pfx", "p12", "keystore", "jks"];

const MASK: &str = "******[masked]";

/// Windows canonicalize 가 붙이는 \\?\ 확장 경로 접두사를 표시용으로 제거.
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\")
        .or_else(|| s.strip_prefix(r"\??\"))
        .unwrap_or(&s)
        .to_string()
}

fn mtime_of(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn root_of(state: &LocodeState) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "프로젝트가 열려 있지 않습니다".to_string())
}

/// 상대 경로를 프로젝트 루트 기준 실제 경로로 해석하고, 루트 밖이면 거부한다.
/// must_exist 가 false 면 존재하지 않는 경로도 허용(부모까지만 검증) — Phase 2 쓰기용.
fn resolve(root: &Path, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err("절대 경로는 허용되지 않습니다".into());
    }
    for comp in candidate.components() {
        match comp {
            Component::ParentDir => return Err("상위 폴더 접근은 허용되지 않습니다".into()),
            Component::Prefix(_) | Component::RootDir => {
                return Err("루트/드라이브 지정은 허용되지 않습니다".into())
            }
            Component::Normal(c) if c.eq_ignore_ascii_case(".locode") => {
                return Err("`.locode` 는 앱 내부 폴더라 접근할 수 없습니다".into())
            }
            _ => {}
        }
    }
    let joined = root.join(rel);
    let real = if must_exist {
        fs::canonicalize(&joined).map_err(|e| format!("경로를 찾을 수 없습니다: {e}"))?
    } else {
        let parent = joined.parent().unwrap_or(root);
        let real_parent =
            fs::canonicalize(parent).map_err(|e| format!("상위 폴더를 찾을 수 없습니다: {e}"))?;
        if !real_parent.starts_with(root) {
            return Err("프로젝트 폴더 밖은 접근할 수 없습니다".into());
        }
        let fname = joined
            .file_name()
            .ok_or_else(|| "파일 이름이 없습니다".to_string())?;
        return Ok(real_parent.join(fname));
    };
    if !real.starts_with(root) {
        return Err("프로젝트 폴더 밖은 접근할 수 없습니다".into());
    }
    Ok(real)
}

fn is_secret_file(p: &Path) -> bool {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if SECRET_FILES.iter().any(|s| name == *s) || name.starts_with(".env") {
        return true;
    }
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        if SECRET_EXT.contains(&ext.to_lowercase().as_str()) {
            return true;
        }
    }
    name.contains("credential") || name.contains("secret")
}

/// 텍스트 안의 흔한 비밀 패턴을 마스킹한다. (반환: 마스킹된 텍스트, 건수)
fn mask_secrets(text: &str) -> (String, u32) {
    let mut count = 0u32;
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        out.push_str(&mask_line(line, &mut count));
    }
    (out, count)
}

fn mask_line(line: &str, count: &mut u32) -> String {
    if line.contains("PRIVATE KEY") {
        *count += 1;
        return format!("{MASK} (private key)\n");
    }
    let lower = line.to_lowercase();
    let looks_secret = ["api_key", "apikey", "secret", "token", "password", "passwd", "private_key", "access_key"]
        .iter()
        .any(|k| lower.contains(k));
    let prefixes = ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "AIza", "gsk_", "hf_"];
    let mut result = line.to_string();
    for pre in prefixes {
        if let Some(pos) = result.find(pre) {
            let tail: String = result[pos..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if tail.len() >= pre.len() + 8 {
                result = result.replace(&tail, MASK);
                *count += 1;
            }
        }
    }
    if looks_secret {
        if let Some(eq) = result.find(|c| c == '=' || c == ':') {
            let rest = &result[eq + 1..];
            let quoted = rest.trim().trim_matches(|c| c == '"' || c == '\'' || c == ' ');
            if quoted.len() >= 12 && quoted.chars().all(|c| c.is_ascii_graphic()) {
                *count += 1;
                let head = result[..eq + 1].to_string();
                return format!("{head} {MASK}\n");
            }
        }
    }
    result
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return true;
    }
    let ctrl = sample
        .iter()
        .filter(|b| **b < 9 || (**b > 13 && **b < 32))
        .count();
    ctrl * 100 / sample.len().max(1) > 10
}

// ---------- Tauri 명령 ----------

#[tauri::command]
pub async fn locode_open_project(
    state: tauri::State<'_, LocodeState>,
) -> Result<Option<ProjectInfo>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("LOCODE 프로젝트 폴더 선택")
        .pick_folder()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let real = fs::canonicalize(handle.path()).map_err(|e| e.to_string())?;
    if !real.is_dir() {
        return Err("폴더가 아닙니다".into());
    }
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path(&real));
    let is_git = real.join(".git").exists();
    *state.root.lock().unwrap() = Some(real.clone());
    Ok(Some(ProjectInfo {
        path: display_path(&real),
        name,
        is_git,
    }))
}

/// 앱 재시작 후, 이전에 열었던 경로로 프로젝트를 다시 연다(대화상자 없이).
/// 경로가 실제 존재하는 디렉터리인지 검증하고 정규화한다.
#[tauri::command]
pub fn locode_reopen(
    state: tauri::State<'_, LocodeState>,
    path: String,
) -> Result<ProjectInfo, String> {
    let real = fs::canonicalize(&path).map_err(|_| "폴더를 찾을 수 없습니다".to_string())?;
    if !real.is_dir() {
        return Err("폴더가 아닙니다".into());
    }
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path(&real));
    let is_git = real.join(".git").exists();
    *state.root.lock().unwrap() = Some(real.clone());
    Ok(ProjectInfo { path: display_path(&real), name, is_git })
}

#[tauri::command]
pub fn locode_close_project(state: tauri::State<'_, LocodeState>) {
    *state.root.lock().unwrap() = None;
}

#[tauri::command]
pub fn locode_project_info(state: tauri::State<'_, LocodeState>) -> Option<ProjectInfo> {
    let root = state.root.lock().unwrap().clone()?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let is_git = root.join(".git").exists();
    Some(ProjectInfo {
        path: display_path(&root),
        name,
        is_git,
    })
}

#[tauri::command]
pub fn locode_list_dir(
    state: tauri::State<'_, LocodeState>,
    rel: String,
) -> Result<Vec<Entry>, String> {
    let root = root_of(&state)?;
    let dir = resolve(&root, &rel, true)?;
    if !dir.is_dir() {
        return Err("디렉터리가 아닙니다".into());
    }
    let mut out = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case(".locode") {
            continue; // 앱 내부 폴더는 AI에게 숨긴다
        }
        let ft = e.file_type().map_err(|e| e.to_string())?;
        let meta = e.metadata().ok();
        out.push(Entry {
            hidden: name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()),
            kind: if ft.is_dir() { "dir" } else { "file" },
            size: meta.map(|m| m.len()).unwrap_or(0),
            name,
        });
    }
    let rank = |k: &str| if k == "dir" { 0 } else { 1 };
    out.sort_by(|a, b| {
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn locode_read_file(
    state: tauri::State<'_, LocodeState>,
    rel: String,
) -> Result<FileContent, String> {
    let root = root_of(&state)?;
    let file = resolve(&root, &rel, true)?;
    if is_secret_file(&file) {
        return Err("비밀 파일로 분류되어 읽기가 제한됩니다 (.env / 키 파일 등)".into());
    }
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아닙니다".into());
    }
    let bytes = meta.len();
    let raw = fs::read(&file).map_err(|e| e.to_string())?;
    if looks_binary(&raw) {
        return Err("바이너리 파일은 읽을 수 없습니다".into());
    }
    let truncated = bytes > MAX_READ_BYTES;
    let slice = &raw[..raw.len().min(MAX_READ_BYTES as usize)];
    let text = String::from_utf8_lossy(slice).to_string();
    let (content, masked) = mask_secrets(&text);
    Ok(FileContent {
        content,
        truncated,
        masked,
        bytes,
        mtime: mtime_of(&file),
    })
}

/// 파일 쓰기 (생성 또는 수정). expected_mtime 이 주어지면 외부 변경 시 거부한다.
/// 원래 내용을 before 로 돌려줘 프런트가 되돌리기용으로 보관한다.
#[tauri::command]
pub fn locode_write_file(
    state: tauri::State<'_, LocodeState>,
    rel: String,
    content: String,
    expected_mtime: Option<u64>,
) -> Result<WriteResult, String> {
    let root = root_of(&state)?;
    let file = resolve(&root, &rel, false)?;
    if is_secret_file(&file) {
        return Err("비밀 파일에는 쓸 수 없습니다".into());
    }
    if content.len() as u64 > MAX_READ_BYTES {
        return Err("한 번에 쓸 수 있는 크기를 초과했습니다 (512KB)".into());
    }
    let existed = file.exists();
    let before = if existed {
        if !file.is_file() {
            return Err("파일이 아닙니다".into());
        }
        if let Some(exp) = expected_mtime {
            let cur = mtime_of(&file);
            if cur != 0 && exp != 0 && cur != exp {
                return Err("파일이 외부에서 변경되었습니다. 다시 읽은 뒤 진행하세요.".into());
            }
        }
        Some(fs::read_to_string(&file).unwrap_or_default())
    } else {
        if let Some(p) = file.parent() {
            let _ = fs::create_dir_all(p);
        }
        None
    };
    fs::write(&file, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(WriteResult {
        created: !existed,
        before,
        mtime: mtime_of(&file),
    })
}

/// 파일/폴더 이동·이름 변경. 둘 다 루트 내부여야 하고 대상이 없어야 한다.
#[tauri::command]
pub fn locode_move(
    state: tauri::State<'_, LocodeState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = root_of(&state)?;
    let src = resolve(&root, &from, true)?;
    let dst = resolve(&root, &to, false)?;
    if dst.exists() {
        return Err("대상 경로가 이미 존재합니다".into());
    }
    if let Some(p) = dst.parent() {
        let _ = fs::create_dir_all(p);
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())
}

/// 파일 삭제 (되돌리기용으로 내용을 돌려줌). 폴더는 비어있을 때만.
#[tauri::command]
pub fn locode_delete(
    state: tauri::State<'_, LocodeState>,
    rel: String,
) -> Result<Option<String>, String> {
    let root = root_of(&state)?;
    let target = resolve(&root, &rel, true)?;
    if target == root {
        return Err("프로젝트 루트는 삭제할 수 없습니다".into());
    }
    if target.is_dir() {
        fs::remove_dir(&target).map_err(|_| "비어있지 않은 폴더는 삭제할 수 없습니다".to_string())?;
        return Ok(None);
    }
    let before = fs::read_to_string(&target).ok();
    fs::remove_file(&target).map_err(|e| e.to_string())?;
    Ok(before)
}

#[tauri::command]
pub fn locode_search(
    state: tauri::State<'_, LocodeState>,
    query: String,
    kind: String,
) -> Result<Vec<Hit>, String> {
    let root = root_of(&state)?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let ql = q.to_lowercase();
    let mut hits = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        if hits.len() >= MAX_HITS {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if !SKIP_DIRS.contains(&name.as_str()) && !name.eq_ignore_ascii_case(".locode") {
                    stack.push(path);
                }
                continue;
            }
            let relp = path
                .strip_prefix(&root)
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|_| path.clone())
                .to_string_lossy()
                .replace('\\', "/");
            if kind == "filename" {
                if name.to_lowercase().contains(&ql) {
                    hits.push(Hit { path: relp, line: 0, text: name });
                }
                continue;
            }
            if is_secret_file(&path) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            if meta.len() > MAX_SCAN_BYTES {
                continue;
            }
            let Ok(raw) = fs::read(&path) else { continue };
            if looks_binary(&raw) {
                continue;
            }
            for (i, line) in String::from_utf8_lossy(&raw).lines().enumerate() {
                if line.to_lowercase().contains(&ql) {
                    let (masked, _) = mask_secrets(line);
                    hits.push(Hit {
                        path: relp.clone(),
                        line: (i + 1) as u32,
                        text: masked.trim().chars().take(240).collect(),
                    });
                    if hits.len() >= MAX_HITS {
                        break;
                    }
                }
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub fn locode_git_status(state: tauri::State<'_, LocodeState>) -> Result<GitStatus, String> {
    let root = root_of(&state)?;
    if !root.join(".git").exists() {
        return Ok(GitStatus {
            is_git: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            files: vec![],
        });
    }
    let run = |args: &[&str]| -> String {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"]);
    let (mut ahead, mut behind) = (0, 0);
    let counts = run(&["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    let mut it = counts.split_whitespace();
    if let (Some(a), Some(b)) = (it.next(), it.next()) {
        ahead = a.parse().unwrap_or(0);
        behind = b.parse().unwrap_or(0);
    }
    let porcelain = run(&["status", "--porcelain"]);
    let files = porcelain
        .lines()
        .filter_map(|l| {
            if l.len() < 3 {
                return None;
            }
            Some(GitFile {
                status: l[..2].trim().to_string(),
                path: l[3..].to_string(),
            })
        })
        .collect();
    Ok(GitStatus { is_git: true, branch, ahead, behind, files })
}

// ---------- 명령 실행 (Phase 3) ----------

/// 셸 명령은 완전한 OS 샌드박스가 아니므로, 위험하거나 외부 상태를 바꾸는 패턴을
/// Rust 쪽에서 다시 분류한다. 프런트의 표시는 편의용일 뿐 이 함수가 권위 있다.
fn command_policy(cmd: &str) -> CommandPolicy {
    let s = cmd.trim().to_lowercase();
    if s.is_empty() {
        return CommandPolicy { level: "blocked".into(), reason: "실행할 명령이 없습니다".into() };
    }
    let compact = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.contains("rm ") && compact.contains("-r") && compact.contains("-f") {
        return CommandPolicy { level: "blocked".into(), reason: "안전을 위해 차단됨: 재귀 강제 삭제".into() };
    }
    let blocked = [
        ("rm -rf", "재귀 강제 삭제"), ("rm -fr", "재귀 강제 삭제"),
        ("del /s", "재귀 삭제"), ("del /q", "무인 삭제"), ("rmdir /s", "재귀 폴더 삭제"),
        ("format ", "디스크 포맷"), ("mkfs", "파일 시스템 생성"), ("dd if=", "디스크 직접 쓰기"),
        (":() {", "fork bomb"), ("reg add", "레지스트리 변경"), ("reg delete", "레지스트리 변경"),
        ("reg import", "레지스트리 변경"), ("icacls", "권한 변경"), ("takeown", "소유권 변경"),
        ("netsh", "네트워크 설정 변경"), ("bcdedit", "부팅 설정 변경"), ("diskpart", "디스크 관리"),
        ("shutdown", "시스템 종료"), ("reboot", "시스템 재시작"),
        ("git reset --hard", "Git 변경사항 영구 폐기"), ("git clean -f", "추적되지 않은 파일 삭제"),
        ("git push --force", "강제 푸시"), ("git push -f", "강제 푸시"),
        ("chmod -r 777", "권한 일괄 변경"), ("sudo", "권한 상승"), ("runas", "권한 상승"),
    ];
    if let Some((_, reason)) = blocked.iter().find(|(needle, _)| compact.contains(needle)) {
        return CommandPolicy { level: "blocked".into(), reason: format!("안전을 위해 차단됨: {reason}") };
    }
    // 프로젝트 경계를 빠져나가거나 시스템 경로에 리디렉션하는 명령도 막는다.
    if compact.split_whitespace().any(|part| part == ".." || part.starts_with("..\\") || part.starts_with("../")) ||
        (compact.contains('>') && (compact.contains(":\\windows") || compact.contains(":\\users"))) {
        return CommandPolicy { level: "blocked".into(), reason: "프로젝트 밖 경로 접근 가능성이 있어 차단됨".into() };
    }
    let reconfirm = [
        "npm install", "npm i ", "npm add", "pnpm install", "pnpm add", "yarn install", "yarn add",
        "pip install", "cargo install", "cargo publish", "git push", "git commit", "curl ", "wget ",
        "invoke-webrequest", "docker push", "npx ", "gh ", "npm publish", "pnpm publish", "yarn publish",
    ];
    if reconfirm.iter().any(|needle| compact.contains(needle)) {
        return CommandPolicy { level: "reconfirm".into(), reason: "네트워크·설치·배포 또는 Git 변경 작업입니다. 실행 직전에 한 번 더 확인하세요.".into() };
    }
    CommandPolicy { level: "standard".into(), reason: "프로젝트 폴더에서 실행됩니다. 출력·시간 제한이 적용됩니다.".into() }
}

#[tauri::command]
pub fn locode_command_policy(cmd: String) -> CommandPolicy { command_policy(&cmd) }

#[tauri::command]
pub async fn locode_run(
    state: tauri::State<'_, LocodeState>,
    registry: tauri::State<'_, RunRegistry>,
    cmd: String,
    timeout: Option<u64>,
    stream_id: String,
    confirmed: bool,
    on_line: Channel<String>,
) -> Result<RunResult, String> {
    let root = root_of(&state)?;
    let registry = registry.inner().clone();
    let policy = command_policy(&cmd);
    if policy.level == "blocked" { return Err(policy.reason); }
    if policy.level == "reconfirm" && !confirmed {
        return Err("이 명령은 실행 직전 추가 확인이 필요합니다".into());
    }
    let timeout = timeout.unwrap_or(120).clamp(1, 600);
    let run_id = stream_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd");
            // stderr 를 stdout 으로 합쳐 한 채널로 안전하게 전달한다.
            c.args(["/D", "/S", "/C", &format!("({cmd}) 2>&1")]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = Command::new("sh");
            c.args(["-c", &cmd]);
            c
        };
        command.current_dir(&root).stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
        let child = Arc::new(Mutex::new(command.spawn().map_err(|e| format!("명령을 시작할 수 없습니다: {e}"))?));
        let stopped_flag = Arc::new(AtomicBool::new(false));
        registry.insert(run_id.clone(), RunHandle { child: child.clone(), stopped: stopped_flag.clone() })?;
        let stdout = child.lock().unwrap().stdout.take().ok_or_else(|| "명령 출력을 열 수 없습니다".to_string())?;
        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line { Ok(line) => { if tx.send(line).is_err() { break; } }, Err(_) => break }
            }
        });

        const LIVE_LIMIT: usize = 128 * 1024;
        let started = Instant::now();
        let mut sent = 0usize;
        let mut tail: Vec<String> = Vec::new();
        let mut tail_bytes = 0usize;
        let mut truncated = false;
        let mut timed_out = false;
        let mut stopped = false;
        loop {
            if started.elapsed() >= Duration::from_secs(timeout) {
                timed_out = true;
                let _ = child.lock().unwrap().kill();
            }
            match rx.recv_timeout(Duration::from_millis(150)) {
                Ok(line) => {
                    let n = line.len() + 1;
                    if sent + n <= LIVE_LIMIT && !truncated {
                        let _ = on_line.send(line);
                        sent += n;
                    } else {
                        truncated = true;
                        tail_bytes += n;
                        tail.push(line);
                        while tail_bytes > LIVE_LIMIT && !tail.is_empty() {
                            tail_bytes -= tail.remove(0).len() + 1;
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            match child.lock().unwrap().try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {},
                Err(_) => { stopped = true; break; },
            }
            if stopped_flag.load(Ordering::Relaxed) { stopped = true; }
            if timed_out { stopped = true; }
        }
        let status = child.lock().unwrap().wait().ok();
        registry.remove(&run_id);
        if truncated {
            let _ = on_line.send("… 출력이 256KB를 넘어 가운데 부분을 생략했습니다 …".into());
            for line in tail { let _ = on_line.send(line); }
        }
        Ok(RunResult { exit_code: status.and_then(|s| s.code()), timed_out, stopped: stopped || stopped_flag.load(Ordering::Relaxed), truncated })
    }).await.map_err(|e| e.to_string())?;
    result
}

#[tauri::command]
pub fn locode_stop_run(registry: tauri::State<'_, RunRegistry>, stream_id: String) -> Result<(), String> {
    if registry.stop(&stream_id) { Ok(()) } else { Err("실행 중인 명령을 찾을 수 없습니다".into()) }
}

/// 프로젝트 안의 append-only 감사 로그를 최근 순서로 읽는다. UI는 이 결과를 표시만 하며
/// 수정·삭제 기능은 제공하지 않는다.
#[tauri::command]
pub fn locode_read_audit(state: tauri::State<'_, LocodeState>) -> Result<Vec<String>, String> {
    let root = root_of(&state)?;
    let path = root.join(".locode").join("audit.jsonl");
    if !path.exists() { return Ok(vec![]); }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 { return Err("감사 로그가 너무 큽니다 (2MB 초과)".into()); }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(raw.lines().filter(|line| !line.trim().is_empty()).rev().take(300).map(str::to_owned).collect())
}

/// 감사 로그 1줄 추가. 프로젝트 쓰기 불가 시 조용히 실패한다.
#[tauri::command]
pub fn locode_audit(state: tauri::State<'_, LocodeState>, entry: String) {
    let Ok(root) = root_of(&state) else { return };
    let dir = root.join(".locode");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("audit.jsonl"))
    {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let payload = if entry.trim_start().starts_with('{') {
            entry
        } else {
            format!("{entry:?}")
        };
        let _ = writeln!(f, "{{\"ts\":{ts},\"e\":{payload}}}");
    }
}

#[cfg(test)]
mod tests {
    use super::command_policy;

    #[test]
    fn dangerous_commands_are_blocked() {
        assert_eq!(command_policy("git reset --hard").level, "blocked");
        assert_eq!(command_policy("rm -r -f build").level, "blocked");
        assert_eq!(command_policy("del /q /s temp").level, "blocked");
        assert_eq!(command_policy("cd .. && npm test").level, "blocked");
    }

    #[test]
    fn external_effects_need_reconfirmation() {
        assert_eq!(command_policy("npm install lodash").level, "reconfirm");
        assert_eq!(command_policy("git push origin main").level, "reconfirm");
        assert_eq!(command_policy("npm test").level, "standard");
    }
}
