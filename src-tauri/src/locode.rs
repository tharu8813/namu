//! LOCODE project sessions, bounded reads and native-approved atomic file changes.
use crate::approval::{confirm, digest};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::ipc::Channel;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}
#[derive(Clone)]
struct Project {
    root: PathBuf,
    id: String,
}
#[derive(Clone, Default)]
pub struct LocodeState {
    project: Arc<Mutex<Option<Project>>>,
    snapshots: Arc<Mutex<HashMap<String, Snapshot>>>,
    gate: Arc<Mutex<()>>,
    epoch: Arc<AtomicU64>,
    pub cancelled: Arc<Mutex<std::collections::HashSet<String>>>,
}
impl LocodeState {
    fn project(&self, expected: &str) -> Result<Project, String> {
        let p = self.project.lock().unwrap();
        let p = p.as_ref().ok_or("프로젝트가 열려 있지 않습니다")?;
        if p.id != expected {
            return Err("프로젝트 세션이 변경되었습니다. 다시 열어주세요".into());
        }
        Ok(p.clone())
    }
    pub fn ensure_session(&self, expected: &str) -> Result<(), String> {
        self.project(expected).map(|_| ())
    }
    fn check_active(&self, expected: &str) -> Result<Project, String> {
        if self.cancelled.lock().unwrap().contains(expected) {
            return Err("작업이 중단되었습니다".into());
        }
        self.project(expected)
    }
    fn open(&self, root: PathBuf) -> ProjectInfo {
        let _guard = self.gate.lock().unwrap();
        let project = Project { root, id: id() };
        let info = project.info();
        *self.project.lock().unwrap() = Some(project);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        info
    }
}
#[derive(Serialize)]
pub struct ProjectInfo {
    path: String,
    name: String,
    is_git: bool,
    session_id: String,
}
impl Project {
    fn info(&self) -> ProjectInfo {
        ProjectInfo {
            path: display_path(&self.root),
            name: self
                .root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            is_git: self.root.join(".git").exists(),
            session_id: self.id.clone(),
        }
    }
}
#[derive(Serialize)]
pub struct Entry {
    name: String,
    kind: &'static str,
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
    revision: String,
}
#[derive(Serialize)]
pub struct WriteResult {
    created: bool,
    change_id: String,
    preview_before: Option<String>,
    preview_after: Option<String>,
    mtime: u64,
    revision: String,
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
const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_HITS: usize = 200;
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".tools",
    ".next",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    "coverage",
    ".idea",
    ".vscode",
];
const SECRET_FILES: &[&str] = &[
    ".env",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "id_rsa",
    "id_ed25519",
    "id_dsa",
    "id_ecdsa",
];
const SECRET_EXT: &[&str] = &["pem", "key", "pfx", "p12", "keystore", "jks"];
const MASK: &str = "******[masked]";
fn display_path(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}
fn mtime_of(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
fn reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn resolve(root: &Path, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
    let candidate = Path::new(rel);
    if candidate.is_absolute()
        || rel.contains(':')
        || rel.contains('\0')
        || rel.contains('\\') && cfg!(not(windows))
    {
        return Err("절대 경로/드라이브/대체 데이터 스트림은 허용되지 않습니다".into());
    }
    let mut joined = root.to_path_buf();
    for comp in candidate.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(c) => {
                let name = c.to_string_lossy();
                let stem = name.split('.').next().unwrap_or("").to_uppercase();
                if name.ends_with([' ', '.'])
                    || name.eq_ignore_ascii_case(".locode")
                    || [
                        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                        "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6",
                        "LPT7", "LPT8", "LPT9",
                    ]
                    .contains(&stem.as_str())
                {
                    return Err("내부/장치/모호한 경로 접근 차단".into());
                }
                joined.push(c);
                match fs::symlink_metadata(&joined) {
                    Ok(m) if reparse(&m) => {
                        return Err("심볼릭 링크/정션은 접근할 수 없습니다".into())
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound && !must_exist => {}
                    Err(_) => return Err("경로를 찾을 수 없습니다".into()),
                }
            }
            _ => return Err("프로젝트 밖 경로 접근 차단".into()),
        }
    }
    let real = if joined.exists() {
        fs::canonicalize(&joined).map_err(|e| e.to_string())?
    } else {
        let parent = fs::canonicalize(joined.parent().ok_or("부모 경로 없음")?)
            .map_err(|_| "상위 폴더를 찾을 수 없습니다")?;
        parent.join(joined.file_name().ok_or("파일 이름 없음")?)
    };
    if !real.starts_with(root) {
        return Err("프로젝트 폴더 밖은 접근할 수 없습니다".into());
    }
    if must_exist && !real.exists() {
        return Err("경로를 찾을 수 없습니다".into());
    }
    Ok(real)
}
fn protected(root: &Path, rel: &str, exists: bool) -> Result<PathBuf, String> {
    for c in Path::new(rel).components() {
        if let Component::Normal(c) = c {
            let lower = c.to_string_lossy().to_lowercase();
            if is_secret_file(Path::new(c))
                || [
                    ".git", ".aws", ".ssh", ".azure", ".gnupg", ".kube", ".docker",
                ]
                .contains(&lower.as_str())
            {
                return Err("비밀/자격 증명/저장소 내부 경로는 접근할 수 없습니다".into());
            }
        }
    }
    resolve(root, rel, exists)
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000).share_mode(1);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    if reparse(&file.metadata().map_err(|e| e.to_string())?) {
        return Err("열린 파일이 링크로 변경되었습니다".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0
            || info.nNumberOfLinks > 1
        {
            return Err("파일 핸들 검증 실패 또는 하드 링크 접근 차단".into());
        }
    }
    file.take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}
// On Windows pin every ancestor against rename/reparse changes until the operation ends.
// This protects file APIs; shell commands intentionally have no filesystem sandbox.
fn pin_paths(root: &Path, rels: &[&str]) -> Result<Vec<fs::File>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut dirs = std::collections::BTreeSet::new();
        for rel in rels {
            let target = root.join(rel);
            let parent = target.parent().ok_or("부모 경로 없음")?;
            for ancestor in parent.ancestors() {
                dirs.insert(ancestor.to_path_buf());
            }
        }
        let mut handles = Vec::new();
        for dir in dirs {
            let handle = fs::OpenOptions::new()
                .access_mode(0x8000_0000)
                .share_mode(1)
                .custom_flags(0x0200_0000 | 0x0020_0000)
                .open(&dir)
                .map_err(|_| {
                    "경로를 안전하게 고정할 수 없습니다. 다른 프로그램의 폴더 작업을 확인하세요"
                })?;
            if reparse(&handle.metadata().map_err(|e| e.to_string())?) {
                return Err("부모 링크/정션 접근 차단".into());
            }
            handles.push(handle);
        }
        Ok(handles)
    }
    #[cfg(not(windows))]
    {
        let _ = (root, rels);
        Ok(vec![])
    }
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
pub(crate) fn mask_secrets(text: &str) -> (String, u32) {
    let mut count = 0u32;
    let mut out = String::with_capacity(text.len());
    let mut private = false;
    for line in text.split_inclusive('\n') {
        if line.contains("BEGIN") && line.contains("PRIVATE KEY") {
            private = true;
        }
        if private {
            count += 1;
            out.push_str(MASK);
            if line.ends_with('\n') {
                out.push('\n');
            }
        } else {
            out.push_str(&mask_line(line, &mut count));
        }
        if line.contains("END") && line.contains("PRIVATE KEY") {
            private = false;
        }
    }
    (out, count)
}

fn mask_line(line: &str, count: &mut u32) -> String {
    if line.contains("PRIVATE KEY") {
        *count += 1;
        return format!("{MASK} (private key)\n");
    }
    let lower = line.to_lowercase();
    let looks_secret = [
        "api_key",
        "apikey",
        "secret",
        "token",
        "password",
        "passwd",
        "private_key",
        "access_key",
    ]
    .iter()
    .any(|k| lower.contains(k));
    let prefixes = [
        "sk-",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "AKIA",
        "AIza",
        "gsk_",
        "hf_",
    ];
    let mut result = line.to_string();
    for pre in prefixes {
        let mut start = 0;
        while let Some(offset) = result[start..].find(pre) {
            let pos = start + offset;
            let tail: String = result[pos..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if tail.len() >= pre.len() + 8 {
                result.replace_range(pos..pos + tail.len(), MASK);
                *count += 1;
                start = pos + MASK.len();
            } else {
                start = pos + pre.len();
            }
        }
    }
    if lower.contains("bearer ") || lower.contains("authorization:") {
        *count += 1;
        return format!("{MASK}\n");
    }
    if looks_secret {
        if let Some(eq) = result.find(['=', ':']) {
            let rest = &result[eq + 1..];
            let quoted = rest
                .trim()
                .trim_matches(|c| c == '"' || c == '\'' || c == ' ');
            if !quoted.is_empty() {
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

/// 검색/치환 블록 한 쌍. `old` 는 파일에 현재 있는 정확한 텍스트, `new` 는 대체할 텍스트.
#[derive(serde::Deserialize, serde::Serialize)]
pub struct Edit {
    old: String,
    #[serde(rename = "new")]
    new_text: String,
}

/// edits 를 순서대로 적용한다. 각 `old` 는 (그 시점의) 내용에서 정확히 한 번만 나타나야 한다.
fn apply_edits(mut content: String, edits: &[Edit]) -> Result<String, String> {
    for (i, e) in edits.iter().enumerate() {
        let n = i + 1;
        if e.old.is_empty() {
            return Err(format!("{n}번째 수정: old(찾을 텍스트)가 비어 있습니다"));
        }
        let preview: String = e.old.chars().take(160).collect();
        match content.matches(e.old.as_str()).count() {
            0 => return Err(format!("{n}번째 수정: 파일에서 다음 텍스트를 찾지 못했습니다. read_file 로 현재 내용을 다시 확인하세요:\n{preview}")),
            1 => {}
            c => return Err(format!("{n}번째 수정: 다음 텍스트가 {c}곳에 있습니다. 앞뒤 줄을 더 포함해 유일하게 만드세요:\n{preview}")),
        }
        content = content.replacen(e.old.as_str(), &e.new_text, 1);
    }
    Ok(content)
}

#[tauri::command]
pub async fn locode_open_project(
    state: tauri::State<'_, LocodeState>,
    registry: tauri::State<'_, RunRegistry>,
) -> Result<Option<ProjectInfo>, String> {
    if registry.busy() {
        return Err("명령을 중지한 뒤 프로젝트를 전환하세요".into());
    }
    let picked = rfd::AsyncFileDialog::new()
        .set_title("LOCODE 프로젝트 폴더 선택")
        .pick_folder()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let root = fs::canonicalize(handle.path()).map_err(|e| e.to_string())?;
    Ok(Some(state.open(root)))
}
#[tauri::command]
pub async fn locode_reopen(
    state: tauri::State<'_, LocodeState>,
    registry: tauri::State<'_, RunRegistry>,
    path: String,
) -> Result<ProjectInfo, String> {
    if registry.busy() {
        return Err("실행 중에는 프로젝트를 변경할 수 없습니다".into());
    }
    let root = fs::canonicalize(&path).map_err(|_| "폴더를 찾을 수 없습니다")?;
    if !root.is_dir() {
        return Err("폴더가 아닙니다".into());
    }
    let op = format!("open:{}", root.display());
    confirm(
        "project-open",
        &op,
        &format!("이 프로젝트를 다시 연결할까요?\n{}", display_path(&root)),
    )
    .await?
    .validate("project-open", &op)?;
    Ok(state.open(root))
}
#[tauri::command]
pub fn locode_close_project(
    state: tauri::State<'_, LocodeState>,
    registry: tauri::State<'_, RunRegistry>,
    project_id: String,
) -> Result<(), String> {
    if registry.busy() {
        return Err("명령을 먼저 중지하세요".into());
    }
    let _guard = state.gate.lock().unwrap();
    state.project(&project_id)?;
    *state.project.lock().unwrap() = None;
    Ok(())
}
#[tauri::command]
pub fn locode_project_info(state: tauri::State<'_, LocodeState>) -> Option<ProjectInfo> {
    state.project.lock().unwrap().as_ref().map(Project::info)
}
#[tauri::command]
pub fn locode_cancel_session(state: tauri::State<'_, LocodeState>, project_id: String) {
    if state.project(&project_id).is_ok() {
        state.epoch.fetch_add(1, Ordering::SeqCst);
        state.cancelled.lock().unwrap().insert(project_id);
    }
}
#[tauri::command]
pub fn locode_begin_session(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
) -> Result<(), String> {
    state.project(&project_id)?;
    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.cancelled.lock().unwrap().remove(&project_id);
    Ok(())
}
#[tauri::command]
pub fn locode_list_dir(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    rel: String,
) -> Result<Vec<Entry>, String> {
    let root = state.project(&project_id)?.root;
    let path = protected(&root, &rel, true)?;
    let pin = Path::new(&rel)
        .join(".namu-enumeration")
        .to_string_lossy()
        .to_string();
    let _pins = pin_paths(&root, &[&pin])?;
    let mut entries = Vec::new();
    for e in fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .take(3000)
        .flatten()
    {
        let m = match fs::symlink_metadata(e.path()) {
            Ok(m) if !reparse(&m) => m,
            _ => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        if is_secret_file(&e.path()) || name == ".locode" {
            continue;
        }
        entries.push(Entry {
            hidden: name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()),
            name,
            kind: if m.is_dir() { "dir" } else { "file" },
            size: m.len(),
        });
    }
    entries.sort_by_key(|e| (e.kind != "dir", e.name.to_lowercase()));
    Ok(entries)
}
#[tauri::command]
pub fn locode_read_file(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    rel: String,
) -> Result<FileContent, String> {
    let root = state.project(&project_id)?.root;
    let file = protected(&root, &rel, true)?;
    let _pins = pin_paths(&root, &[&rel])?;
    let raw = read_bounded(&file, MAX_READ_BYTES)?;
    if looks_binary(&raw) {
        return Err("바이너리 파일은 텍스트로 읽을 수 없습니다".into());
    }
    let truncated = raw.len() as u64 > MAX_READ_BYTES;
    let (content, masked) = mask_secrets(&String::from_utf8_lossy(
        &raw[..raw.len().min(MAX_READ_BYTES as usize)],
    ));
    state.project(&project_id)?;
    Ok(FileContent {
        content,
        truncated,
        masked,
        bytes: fs::metadata(&file).map_err(|e| e.to_string())?.len(),
        mtime: mtime_of(&file),
        revision: if truncated {
            "truncated".into()
        } else {
            digest(&raw)
        },
    })
}

#[derive(Clone, PartialEq, Debug)]
enum FileState {
    Missing,
    File(Vec<u8>),
    EmptyDir,
}
fn capture(path: &Path) -> Result<FileState, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileState::Missing),
        Err(e) => Err(e.to_string()),
        Ok(m) if reparse(&m) => Err("링크 접근 차단".into()),
        Ok(m) if m.is_dir() => {
            if fs::read_dir(path)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
            {
                return Err("폴더 이동/삭제는 빈 폴더만 지원합니다".into());
            }
            Ok(FileState::EmptyDir)
        }
        Ok(_) => {
            let bytes = read_bounded(path, MAX_READ_BYTES)?;
            if bytes.len() as u64 > MAX_READ_BYTES {
                return Err("512KB 초과 파일의 변경/삭제/복구는 지원하지 않습니다".into());
            }
            Ok(FileState::File(bytes))
        }
    }
}
fn revision(s: &FileState) -> String {
    match s {
        FileState::Missing => "missing".into(),
        FileState::EmptyDir => "directory".into(),
        FileState::File(b) => digest(b),
    }
}
fn preview(s: &FileState) -> Option<String> {
    if let FileState::File(bytes) = s {
        if !looks_binary(bytes) {
            return Some(mask_secrets(&String::from_utf8_lossy(bytes)).0);
        }
    }
    None
}
fn atomic_write(root: &Path, rel: &str, bytes: &[u8], expected: &FileState) -> Result<(), String> {
    let path = protected(root, rel, false)?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("부모 폴더 없음")?)
        .map_err(|e| e.to_string())?;
    if let Ok(m) = fs::metadata(&path) {
        temp.as_file()
            .set_permissions(m.permissions())
            .map_err(|e| e.to_string())?;
    }
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    let check = protected(root, rel, false)?;
    if check != path || capture(&check)? != *expected {
        return Err("파일이 외부에서 변경되었습니다. 다시 읽어주세요".into());
    }
    if *expected == FileState::Missing {
        temp.persist_noclobber(&path).map_err(|e| e.to_string())?;
    } else {
        temp.persist(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[derive(Clone)]
struct Snapshot {
    project: String,
    before: Vec<(String, FileState)>,
    after: Vec<(String, FileState)>,
}
type FileStates = Vec<(String, FileState)>;
type PreparedChange = (FileStates, FileStates);
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind")]
enum Change {
    Write {
        rel: String,
        content: String,
        expected_revision: Option<String>,
    },
    Edit {
        rel: String,
        edits: Vec<Edit>,
        expected_revision: Option<String>,
    },
    Move {
        from: String,
        to: String,
    },
    Delete {
        rel: String,
    },
}
fn prepare(root: &Path, action: &Change) -> Result<PreparedChange, String> {
    let rel = match action {
        Change::Write { rel, .. } | Change::Edit { rel, .. } | Change::Delete { rel } => rel,
        Change::Move { from, .. } => from,
    };
    let path = protected(root, rel, false)?;
    if path == root {
        return Err("프로젝트 루트 변경 금지".into());
    }
    let current = capture(&path)?;
    let before = vec![(rel.clone(), current.clone())];
    match action {
        Change::Write {
            expected_revision, ..
        }
        | Change::Edit {
            expected_revision, ..
        } => {
            if current == FileState::EmptyDir {
                return Err("파일이 아닙니다".into());
            }
            if expected_revision
                .as_ref()
                .is_some_and(|expected| *expected != revision(&current))
                || current != FileState::Missing && expected_revision.is_none()
            {
                return Err(
                    "파일 내용 확인이 필요하거나 외부 변경이 감지되었습니다. 다시 읽어주세요"
                        .into(),
                );
            }
            let after = match action {
                Change::Write { content, .. } => {
                    if let FileState::File(raw) = &current {
                        if looks_binary(raw) || mask_secrets(&String::from_utf8_lossy(raw)).1 > 0 {
                            return Err("비밀 포함/바이너리 파일의 전체 덮어쓰기를 차단했습니다. 부분 편집을 사용하세요".into());
                        }
                    }
                    content.clone()
                }
                Change::Edit { edits, .. } => {
                    let FileState::File(raw) = &current else {
                        return Err("편집할 원본이 없습니다".into());
                    };
                    let text = String::from_utf8(raw.clone())
                        .map_err(|_| "UTF-8 파일만 부분 편집할 수 있습니다")?;
                    if edits.is_empty()
                        || edits.len() > 100
                        || edits
                            .iter()
                            .any(|e| e.old.contains(MASK) || e.new_text.contains(MASK))
                    {
                        return Err("잘못된 편집 블록/마스킹 내용".into());
                    }
                    apply_edits(text, edits)?
                }
                _ => unreachable!(),
            };
            if after.len() as u64 > MAX_READ_BYTES || after.contains(MASK) {
                return Err("파일 크기 한도 또는 마스킹 문자열 덮어쓰기 차단".into());
            }
            Ok((
                before,
                vec![(rel.clone(), FileState::File(after.into_bytes()))],
            ))
        }
        Change::Move { to, .. } => {
            let target = protected(root, to, false)?;
            if current == FileState::Missing
                || target == root
                || capture(&target)? != FileState::Missing
            {
                return Err("이동 원본 없음 또는 대상이 존재합니다".into());
            }
            Ok((
                vec![
                    (rel.clone(), current.clone()),
                    (to.clone(), FileState::Missing),
                ],
                vec![(rel.clone(), FileState::Missing), (to.clone(), current)],
            ))
        }
        Change::Delete { .. } => {
            if current == FileState::Missing {
                return Err("삭제할 원본이 없습니다".into());
            }
            Ok((before, vec![(rel.clone(), FileState::Missing)]))
        }
    }
}
fn check_states(root: &Path, states: &[(String, FileState)]) -> Result<(), String> {
    for (rel, expected) in states {
        if capture(&protected(root, rel, false)?)? != *expected {
            return Err("외부 변경으로 충돌했습니다. 현재 파일을 보존하고 중단합니다".into());
        }
    }
    Ok(())
}
fn apply_prepared(
    root: &Path,
    action: &Change,
    before: &[(String, FileState)],
    after: &[(String, FileState)],
) -> Result<(), String> {
    check_states(root, before)?;
    match action {
        Change::Write { rel, .. } | Change::Edit { rel, .. } => {
            if let FileState::File(bytes) = &after[0].1 {
                atomic_write(root, rel, bytes, &before[0].1)?;
            }
        }
        Change::Move { from, to } => {
            fs::rename(protected(root, from, true)?, protected(root, to, false)?)
                .map_err(|e| e.to_string())?
        }
        Change::Delete { rel } => {
            let path = protected(root, rel, true)?;
            if before[0].1 == FileState::EmptyDir {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            }
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn restore_snapshot(root: &Path, snapshot: &Snapshot) -> Result<(), String> {
    check_states(root, &snapshot.after)?;
    if snapshot.before.len() == 2 {
        fs::rename(
            protected(root, &snapshot.after[1].0, true)?,
            protected(root, &snapshot.before[0].0, false)?,
        )
        .map_err(|e| e.to_string())?;
    } else {
        let (rel, original) = &snapshot.before[0];
        let path = protected(root, rel, false)?;
        match original {
            FileState::Missing => fs::remove_file(path).map_err(|e| e.to_string())?,
            FileState::EmptyDir => fs::create_dir(path).map_err(|e| e.to_string())?,
            FileState::File(bytes) => atomic_write(root, rel, bytes, &snapshot.after[0].1)?,
        }
    }
    Ok(())
}
async fn mutate(
    state: LocodeState,
    project_id: String,
    action: Change,
) -> Result<WriteResult, String> {
    let epoch = state.epoch.load(Ordering::SeqCst);
    let project = state.check_active(&project_id)?;
    let paths: Vec<&str> = match &action {
        Change::Move { from, to } => vec![from, to],
        Change::Write { rel, .. } | Change::Edit { rel, .. } | Change::Delete { rel } => vec![rel],
    };
    for rel in &paths {
        protected(&project.root, rel, false)?;
    }
    let pins = pin_paths(&project.root, &paths)?;
    let (before, after) = prepare(&project.root, &action)?;
    let payload = serde_json::to_string(&action).map_err(|e| e.to_string())?;
    let binding = format!(
        "{}:{}",
        payload,
        before
            .iter()
            .map(|(r, s)| format!("{r}:{}", revision(s)))
            .collect::<Vec<_>>()
            .join("|")
    );
    let display = before
        .iter()
        .zip(&after)
        .map(|((rel, old), (_, new))| {
            format!(
                "경로: {rel}\n이전:\n{}\n변경 후:\n{}",
                preview(old).unwrap_or_else(|| format!("{old:?}").chars().take(100).collect()),
                preview(new).unwrap_or_else(|| "삭제 또는 바이너리/폴더".into())
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let grant = confirm(&project_id, &binding, &format!("프로젝트: {}\n작업: {}\n\n{}\n\n작업 SHA-256: {}\n승인한 내용만 반영합니다. 복구 원본은 앱 종료 전까지 메모리에 보관됩니다.", display_path(&project.root), match &action { Change::Write{..} => "파일 쓰기", Change::Edit{..} => "부분 편집", Change::Move{..} => "이동", Change::Delete{..} => "삭제" }, if display.chars().count() > 6000 { display.chars().take(6000).collect::<String>() + "\n…나머지는 앱의 diff 미리보기에서 확인하세요." } else { display }, digest(payload.as_bytes()))).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _pins = pins;
        let _guard = state.gate.lock().unwrap();
        let root = state.check_active(&project_id)?.root;
        if state.epoch.load(Ordering::SeqCst) != epoch {
            return Err("이전 작업의 승인 요청이 취소되었습니다".into());
        }
        grant.validate(&project_id, &binding)?;
        check_states(&root, &before)?;
        if state.snapshots.lock().unwrap().len() >= 32 {
            return Err(
                "복구 스냅샷 32건 한도입니다. 앱을 재시작하기 전 변경 기록을 확인하세요".into(),
            );
        }
        apply_prepared(&root, &action, &before, &after)?;
        let change_id = id();
        let result = WriteResult {
            created: before[0].1 == FileState::Missing,
            change_id: change_id.clone(),
            preview_before: preview(&before[0].1),
            preview_after: preview(&after.last().unwrap().1),
            mtime: mtime_of(&root.join(&after.last().unwrap().0)),
            revision: revision(&after.last().unwrap().1),
        };
        state.snapshots.lock().unwrap().insert(
            change_id,
            Snapshot {
                project: digest(display_path(&root).as_bytes()),
                before,
                after,
            },
        );
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn locode_write_file(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    rel: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<WriteResult, String> {
    mutate(
        state.inner().clone(),
        project_id,
        Change::Write {
            rel,
            content,
            expected_revision,
        },
    )
    .await
}
#[tauri::command]
pub async fn locode_edit_file(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    rel: String,
    edits: Vec<Edit>,
    expected_revision: Option<String>,
) -> Result<WriteResult, String> {
    mutate(
        state.inner().clone(),
        project_id,
        Change::Edit {
            rel,
            edits,
            expected_revision,
        },
    )
    .await
}
#[tauri::command]
pub async fn locode_move(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    from: String,
    to: String,
) -> Result<WriteResult, String> {
    mutate(state.inner().clone(), project_id, Change::Move { from, to }).await
}
#[tauri::command]
pub async fn locode_delete(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    rel: String,
) -> Result<WriteResult, String> {
    mutate(state.inner().clone(), project_id, Change::Delete { rel }).await
}
#[tauri::command]
pub async fn locode_revert(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    change_id: String,
) -> Result<(), String> {
    let epoch = state.epoch.load(Ordering::SeqCst);
    let project = state.project(&project_id)?;
    let snapshot = state
        .snapshots
        .lock()
        .unwrap()
        .get(&change_id)
        .cloned()
        .ok_or("복구 원본이 없습니다. 이전 앱 실행의 변경은 복구할 수 없습니다")?;
    if snapshot.project != digest(display_path(&project.root).as_bytes()) {
        return Err("다른 프로젝트의 변경입니다".into());
    }
    let pins = pin_paths(
        &project.root,
        &snapshot
            .before
            .iter()
            .map(|(r, _)| r.as_str())
            .collect::<Vec<_>>(),
    )?;
    check_states(&project.root, &snapshot.after)?;
    let binding = format!("revert:{change_id}");
    let grant = confirm(
        &project_id,
        &binding,
        &format!(
            "다음 변경을 되돌릴까요?\n{}\n현재 내용이 변경된 경우 중단합니다.",
            snapshot
                .before
                .iter()
                .map(|(r, _)| r.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _pins = pins;
        let _guard = state.gate.lock().unwrap();
        let root = state.check_active(&project_id)?.root;
        if state.epoch.load(Ordering::SeqCst) != epoch {
            return Err("복구 요청이 취소되었습니다".into());
        }
        grant.validate(&project_id, &binding)?;
        restore_snapshot(&root, &snapshot)?;
        state.snapshots.lock().unwrap().remove(&change_id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn locode_search(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    query: String,
    kind: String,
) -> Result<Vec<Hit>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || search_project(state, project_id, query, kind))
        .await
        .map_err(|e| e.to_string())?
}
fn search_project(
    state: LocodeState,
    project_id: String,
    query: String,
    kind: String,
) -> Result<Vec<Hit>, String> {
    if query.is_empty() || query.len() > 512 || !["text", "filename"].contains(&kind.as_str()) {
        return Err("검색 인수 오류".into());
    }
    let root = state.project(&project_id)?.root;
    let mut stack = vec![root.clone()];
    let mut hits = vec![];
    let mut files = 0;
    let mut bytes = 0;
    let start = Instant::now();
    'scan: while let Some(dir) = stack.pop() {
        state.check_active(&project_id)?;
        let relative = dir
            .strip_prefix(&root)
            .map_err(|_| "프로젝트 경계 변경")?
            .to_string_lossy();
        let pin = Path::new(relative.as_ref())
            .join(".namu-enumeration")
            .to_string_lossy()
            .to_string();
        let Ok(_dir_pins) = pin_paths(&root, &[&pin]) else {
            continue;
        };
        protected(&root, &relative, true)?;
        let Ok(rd) = fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            files += 1;
            if files > 10000
                || bytes > 32 * 1024 * 1024
                || hits.len() >= MAX_HITS
                || start.elapsed() > Duration::from_secs(5)
            {
                break 'scan;
            }
            let ep = e.path();
            let rel = ep
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let Ok(path) = protected(&root, &rel, true) else {
                continue;
            };
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            let name = e.file_name().to_string_lossy().to_string();
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            if kind == "filename" {
                if name.to_lowercase().contains(&query.to_lowercase()) {
                    hits.push(Hit {
                        path: rel,
                        line: 0,
                        text: name,
                    });
                }
                continue;
            }
            if meta.len() > MAX_READ_BYTES {
                continue;
            }
            let Ok(_pins) = pin_paths(&root, &[&rel]) else {
                continue;
            };
            let Ok(raw) = read_bounded(&path, MAX_READ_BYTES) else {
                continue;
            };
            bytes += raw.len();
            if looks_binary(&raw) {
                continue;
            }
            let safe = mask_secrets(&String::from_utf8_lossy(&raw)).0;
            for (i, line) in safe.lines().enumerate() {
                if line.to_lowercase().contains(&query.to_lowercase()) {
                    hits.push(Hit {
                        path: rel.clone(),
                        line: (i + 1) as u32,
                        text: line.chars().take(240).collect(),
                    });
                    if hits.len() >= MAX_HITS {
                        break 'scan;
                    }
                }
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn locode_git_status(
    state: tauri::State<'_, LocodeState>,
    project_id: String,
) -> Result<GitStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || git_status(state, project_id))
        .await
        .map_err(|e| e.to_string())?
}
fn git_status(state: LocodeState, project_id: String) -> Result<GitStatus, String> {
    let root = state.project(&project_id)?.root;
    if !root.join(".git").exists() {
        return Ok(GitStatus {
            is_git: false,
            branch: String::new(),
            ahead: 0,
            behind: 0,
            files: vec![],
        });
    }
    let run = |args: &[&str]| -> Result<String, String> {
        let mut command = std::process::Command::new("git");
        command
            .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath="])
            .args(args)
            .current_dir(&root)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let (mut child, tree) = crate::process::spawn(&mut command)?;
        let stdout = child.stdout.take().ok_or("Git 출력 채널 없음")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .take(128 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Err(_) => break None,
                _ => {}
            }
            if started.elapsed() > Duration::from_secs(3) {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        tree.kill();
        let _ = child.wait();
        let bytes = reader
            .join()
            .map_err(|_| "Git 출력 읽기 실패")?
            .map_err(|_| "Git 출력 오류")?;
        if bytes.len() > 128 * 1024 || !status.is_some_and(|s| s.success()) {
            return Err("Git 조회 시간/출력 한도 또는 실행 오류".into());
        }
        Ok(mask_secrets(String::from_utf8_lossy(&bytes).trim()).0)
    };
    let branch = run(&["symbolic-ref", "--short", "HEAD"])
        .or_else(|_| run(&["rev-parse", "--short", "HEAD"]))
        .unwrap_or_default();
    let (mut ahead, mut behind) = (0, 0);
    let counts =
        run(&["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).unwrap_or_default();
    let mut it = counts.split_whitespace();
    if let (Some(a), Some(b)) = (it.next(), it.next()) {
        ahead = a.parse().unwrap_or(0);
        behind = b.parse().unwrap_or(0);
    }
    let porcelain = run(&["status", "--porcelain"])?;
    let files = porcelain
        .lines()
        .filter_map(|l| {
            if l.len() < 3 || !l.is_char_boundary(2) || !l.is_char_boundary(3) {
                return None;
            }
            Some(GitFile {
                status: l[..2].trim().to_string(),
                path: l[3..].to_string(),
            })
        })
        .collect();
    Ok(GitStatus {
        is_git: true,
        branch,
        ahead,
        behind,
        files,
    })
}

#[derive(Default, Clone)]
pub struct RunRegistry(Arc<Mutex<HashMap<String, RunHandle>>>);
#[derive(Clone)]
struct RunHandle {
    tree: Arc<crate::process::ProcessTree>,
    stopped: Arc<AtomicBool>,
}
impl RunRegistry {
    fn busy(&self) -> bool {
        !self.0.lock().unwrap().is_empty()
    }
    pub fn stop_all(&self) {
        for r in self.0.lock().unwrap().values() {
            r.stopped.store(true, Ordering::Relaxed);
            r.tree.kill();
        }
    }
}
#[derive(Serialize)]
pub struct CommandPolicy {
    level: String,
    reason: String,
    risks: Vec<String>,
}
fn command_policy(cmd: &str) -> CommandPolicy {
    let s = cmd.trim().to_lowercase();
    let blocked = s.is_empty() || s.len() > 16000 || s.contains('\0');
    let mut risks = vec!["process".into(), "filesystem".into()];
    if ["curl", "wget", "http", "push", "fetch"]
        .iter()
        .any(|v| s.contains(v))
    {
        risks.push("network".into());
    }
    if ["install", "npm i", "npx", "pip", "cargo run"]
        .iter()
        .any(|v| s.contains(v))
    {
        risks.push("packages".into());
    }
    if s.contains("git ") {
        risks.push("git".into());
    }
    CommandPolicy { level: if blocked { "blocked" } else { "reconfirm" }.into(),
        reason: "모든 명령은 Rust 네이티브 승인이 필요합니다. 작업 폴더 지정은 OS 샌드박스가 아니며, 파일·네트워크·프로세스 권한을 제한하지 않습니다. 스크립트/간접 실행의 실제 효과는 정적 분류만으로 보장할 수 없습니다.".into(), risks }
}
#[tauri::command]
pub fn locode_command_policy(cmd: String) -> CommandPolicy {
    command_policy(&cmd)
}
#[derive(Serialize)]
pub struct RunResult {
    exit_code: Option<i32>,
    timed_out: bool,
    stopped: bool,
    truncated: bool,
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects state/channel parameters into the IPC boundary.
pub async fn locode_run(
    state: tauri::State<'_, LocodeState>,
    registry: tauri::State<'_, RunRegistry>,
    project_id: String,
    cmd: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    timeout: Option<u64>,
    stream_id: String,
    on_line: Channel<String>,
) -> Result<RunResult, String> {
    let epoch = state.epoch.load(Ordering::SeqCst);
    let project = state.check_active(&project_id)?;
    let timeout = timeout.unwrap_or(120).clamp(1, 600);
    let argv = args.unwrap_or_default();
    if cmd.is_some() == program.is_some()
        || argv.len() > 128
        || argv.iter().any(|s| s.len() > 16000 || s.contains('\0'))
    {
        return Err("명령은 셸 문자열 또는 실행 파일+인수 중 하나로 전달하세요".into());
    }
    let representation =
        serde_json::to_string(&(cmd.as_ref(), program.as_ref(), &argv, timeout, &stream_id))
            .map_err(|e| e.to_string())?;
    let policy = command_policy(cmd.as_deref().or(program.as_deref()).unwrap_or(""));
    if policy.level == "blocked" {
        return Err("잘못된 명령".into());
    }
    let grant = confirm(&project_id, &representation, &format!("프로젝트: {}\n실행 방식: {}\n실제 명령: {}\n인수: {:?}\n제한: {}초 / 출력 256KB\n위험 분류: {:?}\n\n{}", display_path(&project.root), if program.is_some() {"직접 실행"} else {"셸"}, cmd.as_deref().or(program.as_deref()).unwrap_or(""), argv, timeout, policy.risks, policy.reason)).await?;
    let state = state.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Reserve the slot before spawn, so a rejected concurrent run cannot leave an orphan.
        let guard = state.gate.lock().unwrap();
        let root = state.check_active(&project_id)?.root;
        if state.epoch.load(Ordering::SeqCst) != epoch {
            return Err("명령 승인 요청이 취소되었습니다".into());
        }
        grant.validate(&project_id, &representation)?;
        let mut runs = registry.0.lock().unwrap();
        if !runs.is_empty() {
            return Err("이미 실행 중인 명령이 있습니다".into());
        }
        let mut command = if let Some(exe) = program {
            let mut c = Command::new(exe);
            c.args(argv);
            c
        } else {
            let raw = cmd.unwrap_or_default();
            #[cfg(windows)]
            let c = {
                let mut c = Command::new("cmd.exe");
                c.args(["/D", "/S", "/C", &raw]);
                c
            };
            #[cfg(not(windows))]
            let c = {
                let mut c = Command::new("sh");
                c.args(["-c", &raw]);
                c
            };
            c
        };
        command
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut process, tree) = crate::process::spawn(&mut command)?;
        let stdout = process.stdout.take().ok_or("stdout 없음")?;
        let stderr = process.stderr.take().ok_or("stderr 없음")?;
        let child = Arc::new(Mutex::new(process));
        let stopped = Arc::new(AtomicBool::new(false));
        runs.insert(
            stream_id.clone(),
            RunHandle {
                tree: tree.clone(),
                stopped: stopped.clone(),
            },
        );
        drop(runs);
        drop(guard);
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(32);
        fn drain(mut input: impl Read + Send + 'static, tx: std::sync::mpsc::SyncSender<String>) {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let mut line = Vec::new();
                let mut oversized = false;
                let mut private = false;
                loop {
                    let n = match input.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    for byte in &buf[..n] {
                        if *byte == b'\n' {
                            let raw = String::from_utf8_lossy(&line);
                            if raw.contains("BEGIN") && raw.contains("PRIVATE KEY") {
                                private = true;
                            }
                            let safe = if oversized || private {
                                "[민감하거나 긴 출력 생략]".into()
                            } else {
                                mask_secrets(&raw).0
                            };
                            if raw.contains("END") && raw.contains("PRIVATE KEY") {
                                private = false;
                            }
                            if tx.send(safe).is_err() {
                                return;
                            }
                            line.clear();
                            oversized = false;
                        } else if line.len() < 8192 {
                            line.push(*byte);
                        } else {
                            oversized = true;
                        }
                    }
                }
                if !line.is_empty() {
                    let _ = tx.send(if oversized || private {
                        "[출력 생략]".into()
                    } else {
                        mask_secrets(&String::from_utf8_lossy(&line)).0
                    });
                }
            });
        }
        drain(stdout, tx.clone());
        drain(stderr, tx);
        let started = Instant::now();
        let mut sent = 0;
        let mut truncated = false;
        let mut timed_out = false;
        let mut status = None;
        loop {
            if started.elapsed() >= Duration::from_secs(timeout) {
                timed_out = true;
                tree.kill();
            }
            if stopped.load(Ordering::Relaxed) {
                tree.kill();
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    sent += line.len();
                    if sent <= 256 * 1024 {
                        if on_line.send(line).is_err() {
                            stopped.store(true, Ordering::Relaxed);
                            tree.kill();
                        }
                    } else {
                        truncated = true;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    if status.is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(_) => {}
            }
            if status.is_none() {
                match child.lock().unwrap().try_wait() {
                    Ok(s) => status = s,
                    Err(_) => {
                        tree.kill();
                        break;
                    }
                }
            }
            // A completed parent must not leave a runner holding inherited stdout pipes open.
            if status.is_some() {
                tree.kill();
            }
            if timed_out || stopped.load(Ordering::Relaxed) {
                break;
            }
        }
        tree.kill();
        let exit = child.lock().unwrap().wait().ok().or(status);
        registry.0.lock().unwrap().remove(&stream_id);
        if truncated {
            let _ = on_line.send("… 출력 256KB 한도로 생략했습니다 …".into());
        }
        Ok(RunResult {
            exit_code: exit.and_then(|s| s.code()),
            timed_out,
            stopped: stopped.load(Ordering::Relaxed),
            truncated,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn locode_stop_run(
    registry: tauri::State<'_, RunRegistry>,
    stream_id: String,
) -> Result<(), String> {
    let handle = registry
        .0
        .lock()
        .unwrap()
        .get(&stream_id)
        .cloned()
        .ok_or("실행 중인 명령이 없습니다")?;
    handle.stopped.store(true, Ordering::Relaxed);
    handle.tree.kill();
    Ok(())
}
fn audit_path(app: &tauri::AppHandle, root: &Path) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("audit");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{}.jsonl", digest(display_path(root).as_bytes()))))
}
#[tauri::command]
pub fn locode_read_audit(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocodeState>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let path = audit_path(&app, &state.project(&project_id)?.root)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = read_bounded(&path, 2 * 1024 * 1024)?;
    Ok(String::from_utf8_lossy(&raw)
        .lines()
        .rev()
        .take(300)
        .map(str::to_owned)
        .collect())
}
#[tauri::command]
pub fn locode_audit(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocodeState>,
    project_id: String,
    entry: String,
) -> Result<(), String> {
    if entry.len() > 16000 {
        return Err("감사 기록 한도 초과".into());
    }
    let path = audit_path(&app, &state.project(&project_id)?.root)?;
    if fs::metadata(&path)
        .map(|m| m.len() > 2 * 1024 * 1024)
        .unwrap_or(false)
    {
        return Err("감사 로그 2MB 한도".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_str(&entry).map_err(|_| "잘못된 감사 기록")?;
    fn sanitize(v: &mut serde_json::Value) {
        match v {
            serde_json::Value::String(s) => *s = mask_secrets(s).0,
            serde_json::Value::Array(a) => a.iter_mut().for_each(sanitize),
            serde_json::Value::Object(o) => {
                for (k, v) in o {
                    if ["content", "before", "after", "password", "token", "api_key"]
                        .contains(&k.as_str())
                    {
                        *v = serde_json::Value::String("[생략]".into());
                    } else {
                        sanitize(v);
                    }
                }
            }
            _ => {}
        }
    }
    sanitize(&mut value);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(f,"{}",serde_json::json!({"ts":std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),"e":value})).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(t.path()).unwrap();
        (t, root)
    }
    fn edit(old: &str, new: &str) -> Edit {
        Edit {
            old: old.into(),
            new_text: new.into(),
        }
    }
    fn apply(root: &Path, action: &Change) -> Snapshot {
        let (before, after) = prepare(root, action).unwrap();
        apply_prepared(root, action, &before, &after).unwrap();
        Snapshot {
            project: digest(display_path(root).as_bytes()),
            before,
            after,
        }
    }
    #[test]
    fn path_and_secret_policies_cover_every_operation() {
        let (_t, root) = fixture();
        fs::write(root.join("normal.txt"), b"normal").unwrap();
        for rel in [
            "../outside",
            "/outside",
            r"C:\outside",
            r"\\server\share",
            "normal.txt:stream",
            ".locode/a",
            "CON.txt",
            "normal.txt.",
        ] {
            assert!(resolve(&root, rel, false).is_err(), "{rel}");
        }
        for rel in [
            ".env",
            ".env.production",
            "id_rsa",
            "key.pem",
            ".aws/config",
            ".git/config",
            "secrets.json",
        ] {
            assert!(protected(&root, rel, false).is_err(), "{rel}");
            assert!(prepare(&root, &Change::Delete { rel: rel.into() }).is_err());
            assert!(prepare(
                &root,
                &Change::Move {
                    from: "normal.txt".into(),
                    to: rel.into()
                }
            )
            .is_err());
        }
    }
    #[test]
    fn edit_blocks_are_unique_and_do_not_expose_original_secrets() {
        assert_eq!(
            apply_edits("a\nb".into(), &[edit("a", "AA")]).unwrap(),
            "AA\nb"
        );
        assert!(apply_edits("dup dup".into(), &[edit("dup", "x")]).is_err());
        assert!(apply_edits("text".into(), &[edit("missing", "x")]).is_err());
        let (_t, root) = fixture();
        let original = "const password = 'short';\nlet normal = 1;\n";
        fs::write(root.join("source.js"), original).unwrap();
        let rev = digest(original.as_bytes());
        assert!(prepare(
            &root,
            &Change::Write {
                rel: "source.js".into(),
                content: "masked replacement".into(),
                expected_revision: Some(rev.clone())
            }
        )
        .is_err());
        let snapshot = apply(
            &root,
            &Change::Edit {
                rel: "source.js".into(),
                edits: vec![edit("normal = 1", "normal = 2")],
                expected_revision: Some(rev),
            },
        );
        assert!(fs::read_to_string(root.join("source.js"))
            .unwrap()
            .contains("'short'"));
        assert!(!preview(&snapshot.before[0].1).unwrap().contains("short"));
        restore_snapshot(&root, &snapshot).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("source.js")).unwrap(),
            original
        );
        let (masked, count) = mask_secrets(
            "-----BEGIN PRIVATE KEY-----\nBASE64MATERIAL\n-----END PRIVATE KEY-----\nvisible",
        );
        assert!(count >= 3);
        assert!(!masked.contains("BASE64MATERIAL"));
        assert!(masked.ends_with("visible"));
        let (masked, count) =
            mask_secrets("ghp_abcdefgh1234 ghp_otherdifferent5678 sk-abcdefghijklmnop");
        assert_eq!(count, 3);
        assert!(!masked.contains("ghp_") && !masked.contains("sk-"));
    }
    #[test]
    fn content_conflicts_preserve_external_changes() {
        let (_t, root) = fixture();
        let p = root.join("a.txt");
        fs::write(&p, b"original").unwrap();
        let action = Change::Write {
            rel: "a.txt".into(),
            content: "updated".into(),
            expected_revision: Some(digest(b"original")),
        };
        let (before, after) = prepare(&root, &action).unwrap();
        fs::write(&p, b"external").unwrap();
        assert!(apply_prepared(&root, &action, &before, &after).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"external");
        fs::remove_file(&p).unwrap();
        assert!(
            prepare(&root, &action).is_err(),
            "external deletion must not become a new-file write"
        );
        fs::write(&p, b"external").unwrap();
        let snapshot = apply(
            &root,
            &Change::Write {
                rel: "a.txt".into(),
                content: "updated".into(),
                expected_revision: Some(digest(b"external")),
            },
        );
        fs::write(&p, b"changed again").unwrap();
        assert!(restore_snapshot(&root, &snapshot).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"changed again");
    }
    #[test]
    fn binary_delete_restore_and_move_restore_are_lossless() {
        let (_t, root) = fixture();
        let raw = vec![0, 255, 1, 2, 3];
        fs::write(root.join("a.bin"), &raw).unwrap();
        let deleted = apply(
            &root,
            &Change::Delete {
                rel: "a.bin".into(),
            },
        );
        assert!(!root.join("a.bin").exists());
        assert!(preview(&deleted.before[0].1).is_none());
        restore_snapshot(&root, &deleted).unwrap();
        assert_eq!(fs::read(root.join("a.bin")).unwrap(), raw);
        let moved = apply(
            &root,
            &Change::Move {
                from: "a.bin".into(),
                to: "b.bin".into(),
            },
        );
        restore_snapshot(&root, &moved).unwrap();
        assert!(root.join("a.bin").exists());
        assert!(!root.join("b.bin").exists());
        fs::write(root.join("large.bin"), vec![1; MAX_READ_BYTES as usize + 1]).unwrap();
        assert!(prepare(
            &root,
            &Change::Delete {
                rel: "large.bin".into()
            }
        )
        .is_err());
    }
    #[test]
    fn sessions_cannot_be_reused_after_project_switch() {
        let (_t, root) = fixture();
        let state = LocodeState::default();
        let first = state.open(root.clone());
        assert!(state.ensure_session(&first.session_id).is_ok());
        let second = state.open(root);
        assert_ne!(first.session_id, second.session_id);
        assert!(state.ensure_session(&first.session_id).is_err());
        assert!(state.ensure_session(&second.session_id).is_ok());
    }
    #[test]
    fn project_search_masks_secrets_and_obeys_cancellation() {
        let (_t, root) = fixture();
        fs::write(
            root.join("source.txt"),
            "visible needle\npassword = short\n",
        )
        .unwrap();
        fs::write(root.join(".env"), "needle=secret").unwrap();
        let state = LocodeState::default();
        let project = state.open(root);
        let hits = search_project(
            state.clone(),
            project.session_id.clone(),
            "needle".into(),
            "text".into(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "source.txt");
        state
            .cancelled
            .lock()
            .unwrap()
            .insert(project.session_id.clone());
        assert!(search_project(state, project.session_id, "needle".into(), "text".into()).is_err());
    }
    #[test]
    fn indirect_shell_commands_never_get_automatic_execution() {
        for cmd in [
            "npm test",
            "node -e \"process.exit()\"",
            "python -c \"print(1)\"",
            "cmd /c echo hi",
            "powershell -EncodedCommand AAA",
            "git -c alias.x=!sh x",
            "echo hi && curl example.org",
            "$x='Remove-Item'; & $x",
            "rm -rf anything",
        ] {
            assert_eq!(command_policy(cmd).level, "reconfirm", "{cmd}");
        }
        assert_eq!(command_policy("").level, "blocked");
    }
    #[cfg(windows)]
    #[test]
    fn junctions_hardlinks_and_ancestor_swaps_are_blocked() {
        let (_t, root) = fixture();
        let (_other, outside) = fixture();
        fs::write(outside.join("s.txt"), b"private").unwrap();
        let link = root.join("junction");
        let status = Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "junction fixture creation failed");
        assert!(resolve(&root, "junction/s.txt", true).is_err());
        assert!(resolve(&root, "junction/new.txt", false).is_err());
        fs::remove_dir(&link).unwrap();
        fs::hard_link(outside.join("s.txt"), root.join("hard.txt")).unwrap();
        assert!(read_bounded(&root.join("hard.txt"), 512).is_err());
        fs::create_dir(root.join("dir")).unwrap();
        let pins = pin_paths(&root, &["dir/file.txt"]).unwrap();
        assert!(fs::rename(root.join("dir"), root.join("renamed")).is_err());
        drop(pins);
        fs::rename(root.join("dir"), root.join("renamed")).unwrap();
    }
}
