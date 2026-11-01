# VS Code에서 Namu 개발하기 (Windows)

프로젝트 루트(`package.json`이 있는 폴더)를 **파일 → 폴더 열기**로 열고 추천 확장을 설치합니다.
빌드·실행 작업은 `.vscode/tasks.json`, 디버깅 구성은 `.vscode/launch.json`에 있습니다.

## 처음 한 번

필요한 도구는 Node.js 20 이상, Rust stable **MSVC** 툴체인, Visual Studio의
**C++를 사용한 데스크톱 개발** 워크로드와 Windows SDK, WebView2입니다.
웹 디버깅에는 Edge 또는 Chrome, 현재 Windows UI 테스트에는 Chrome을 사용합니다.

`Ctrl+Shift+P` → **Tasks: Run Task / 작업: 작업 실행**에서 다음을 실행합니다.

1. `environment:doctor` — Node·Rust·링커 경로 확인
2. `dependencies:install` — npm 의존성이 없거나 잠금 파일이 바뀌었을 때 `npm ci`
3. `environment:configure-vscode` — Rust 자동완성·진단용 환경 연결
4. **Developer: Reload Window / 개발자: 창 다시 로드** 실행

현재 PC의 Rust 확장 환경은 이미 연결되어 있습니다. 다른 PC로 옮기거나 Rust·Visual Studio의
설치 위치를 바꾸면 3~4번을 다시 실행하세요. 이 작업은 탐지한 환경을
`.vscode/settings.json`의 `rust-analyzer.server.extraEnv`에 반영합니다.
확장 프로세스는 터미널 프로필의 환경을 상속하지 않으므로 별도 연결이 필요합니다.

`scripts/dev-env.ps1`은 기존 `.tools/cargo` + `.tools/rustup` 설치를 자동 인식합니다.
이 설치가 없으면 사용자 Rust 설치(`%USERPROFILE%\.cargo\bin`)를 사용합니다.
MSVC와 SDK는 Visual Studio Installer의 `vswhere`로 찾으며, 현재 PC의 Scope C++ SDK도
대체 경로로 인식합니다. 빌드 산출물은 `src-tauri/target`에 모읍니다.

추천 확장 **C/C++**는 Windows Rust 디버거, **rust-analyzer**는 자동완성·진단,
**Tauri**는 설정 파일 지원, **Playwright Test for VSCode**는 테스트 탐색기를 제공합니다.
포맷·Clippy 도구가 없다면 `rust:install-tools` 작업으로 추가합니다(인터넷 필요).

## 작업과 단축키

| 원하는 작업 | 실행 방법 |
| --- | --- |
| 디버그 앱 빌드 | `Ctrl+Shift+B` — 기본 빌드 작업 |
| Rust 중단점 디버깅 | `F5` → **데스크톱: Rust 디버그 (Namu)** |
| 디버거 없이 실행 | 같은 구성을 선택하고 `Ctrl+F5` |
| 변경 감지와 함께 앱 실행 | 작업 `tauri:dev` |
| 웹 화면 미리보기 | 작업 `web:serve` → `http://127.0.0.1:8000` |
| JavaScript 중단점 디버깅 | `F5` → **웹: Edge에서 JavaScript 디버그** 또는 Chrome 구성 |
| 실행 중인 앱에 연결 | **데스크톱: 실행 중인 Namu에 연결** → `Namu.exe` 선택 |
| JavaScript 회귀 테스트 | 작업 `test` 또는 **Tasks: Run Test Task** |
| Rust 테스트 | 작업 `test:rust` |
| 브라우저 UI 테스트 | 작업 `test:ui` |
| 전체 테스트 | 작업 `test:all` — JavaScript → Rust → UI 순서 |
| Rust 컴파일 검사 | 작업 `rust:check` |
| Rust 코드 검사 / 포맷 | 작업 `rust:clippy` / `rust:format` |
| 릴리스 실행 파일만 생성 | 작업 `tauri:build-app` |
| NSIS 설치본 생성 | 작업 `tauri:build-release` |
| Ollama 포함 Inno 설치본 생성 | 작업 `installer:build` |

`rust:format`은 Rust 소스 파일을 수정합니다. Rust 빌드·검사 오류는 **문제(Problems)**
패널에서도 확인할 수 있습니다.

## 데스크톱 디버깅

`src-tauri/src/main.rs`의 `main()` 내부 등에 중단점을 찍고 `F5`를 누릅니다.
사전 작업이 `cargo build --locked --bin Namu`를 실행하고
`src-tauri/target/debug/Namu.exe`를 Windows 디버거로 시작합니다.
같은 폴더의 PDB 심볼을 사용하며 Rust 스택 추적을 켭니다.

`F10`은 다음 줄, `F11`은 함수 안으로 들어가기, `Shift+F5`는 디버깅 종료입니다.
앱 안의 JavaScript는 개발 빌드에서 `Ctrl+Shift+I`로 WebView 개발자 도구를 열어 확인합니다.
VS Code의 Rust 디버거는 WebView의 JavaScript 중단점을 처리하지 않습니다.

앱은 단일 인스턴스입니다. 기존 Namu가 떠 있다면 트레이 메뉴에서 완전히 종료한 뒤
디버깅하세요. 창의 X는 앱을 트레이로 숨깁니다. `tauri:dev`는 터미널 `Ctrl+C`로 중단합니다.

## 웹 미리보기와 UI 테스트

웹 디버그 구성을 실행하면 서버 준비를 기다린 뒤 브라우저가 열립니다.
`src/app.js`, `src/lib.js` 등에 중단점을 찍을 수 있습니다.
HTML·CSS·JS 수정 후 브라우저를 새로고침하세요. 서버는 캐시를 끄지만 자동 새로고침은 하지 않습니다.
디버깅을 끝낸 뒤 서버도 끄려면 **Tasks: Terminate Task** → `web:serve`를 선택합니다.
8000 포트를 다른 프로그램이 사용하면 먼저 포트 충돌을 해소해야 합니다.

웹 미리보기는 Rust IPC를 사용할 수 없어 LOCODE 파일·명령 실행 등 데스크톱 전용 기능은
실제 앱에서 확인합니다. 브라우저에서 실제 AI 응답을 쓰려면 Ollama가 실행 중이어야 하며,
`http://127.0.0.1:8000` 출처도 허용해야 합니다.
UI 테스트는 Ollama를 모의 처리하므로 모델이나 실제 AI 서버가 필요 없습니다.

`test:ui`는 8134 포트에서 전용 서버를 자동 실행합니다. Windows에서는 설치된 Chrome을
사용합니다. Playwright 확장을 설치하면 **테스트(Testing)** 패널에서 테스트별 실행과
디버깅도 할 수 있습니다.

## VS Code 터미널에서 직접 실행

새 터미널은 **Namu 개발 PowerShell** 프로필로 열리며 Rust·MSVC 환경을 준비합니다.
이미 열어 둔 터미널은 닫고 새로 여세요.

```powershell
npm run dev                 # 데스크톱 개발 실행
npm run dev:web             # 웹 미리보기 (기본 8000)
npm run dev:web -- 8080      # 다른 포트
npm test                    # JavaScript 테스트
npm run test:ui             # UI 테스트
npm run build:app           # 릴리스 exe만 빌드

# 일반 PowerShell에서도 환경 준비와 함께 실행하는 공통 진입점
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 check
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1 cargo test --locked
```

기존 PowerShell 세션에 환경만 적용하려면 프로젝트 루트에서 실행합니다.

```powershell
. ./scripts/dev-env.ps1
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

실행 정책 때문에 `npm.ps1`이 차단되면 `npm.cmd`를 사용하세요.
VS Code 작업은 `npm.cmd`를 사용합니다.

## 배포 산출물

| 작업 | 결과 |
| --- | --- |
| `tauri:build-debug` | `src-tauri/target/debug/Namu.exe`, 디버깅 심볼 |
| `tauri:build-app` | `src-tauri/target/release/Namu.exe` |
| `tauri:build-release` | `src-tauri/target/release/bundle/nsis/`의 설치본 |
| `installer:build` | `installer/output/Namu-Setup-<버전>.exe` |

Ollama 포함 Inno 설치본은 **Inno Setup**과 CPU 런타임 번들이 추가로 필요합니다.
공식 Ollama를 기본 사용자 경로에 설치한 뒤 `ollama:prepare-bundle` 작업으로 준비하세요.
기존 번들 폴더는 덮어쓰지 않습니다. 일반 데스크톱 개발과 NSIS 빌드에는 이 번들이 필요하지 않습니다.
개발 앱의 실제 AI 응답에는 실행 중이거나 PATH에서 찾을 수 있는 Ollama가 필요합니다.

참고: [Tauri의 VS Code 디버깅 안내](https://v2.tauri.app/develop/debug/vscode/),
[VS Code 작업 안내](https://code.visualstudio.com/docs/debugtest/tasks).
