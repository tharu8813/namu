# 로컬 AI 채팅

여러 로컬 채팅 AI를 iOS 느낌의 GUI에서 사용하는 앱. 모델 관리·다운로드·추론은
[Ollama](https://ollama.com)가 담당한다. 프론트엔드는 순수 HTML/CSS/JS(`src/`),
배포용 데스크톱 셸은 [Tauri](https://v2.tauri.app)(`src-tauri/`).

```
src/
  index.html    마크업 + 스타일
  app.js        앱 로직 (상태·렌더링·이벤트·채팅·모델·온보딩·모드 전환)
  lib.js        순수 헬퍼 (스트림 파싱·마크다운·포맷·첨부 제한 — 테스트 대상)
  store.js      IndexedDB 영속 계층 + localStorage 마이그레이션
  locode.js     LOCODE 모드 (프로젝트 작업 에이전트) — 읽기·승인제 쓰기·명령 실행
  models.json   추천 모델 카탈로그
  net.js        Ollama 호출 추상화 (Tauri→Rust 프록시 / 웹→직접 fetch)
src-tauri/
  src/main.rs   Ollama 자동 실행, disk_free_gb, open_url
  src/ollama.rs Ollama HTTP 프록시 (Tauri 웹뷰 CORS 우회, 스트리밍+취소)
  src/locode.rs LOCODE 안전 파일·명령 계층 (경로 격리·비밀 마스킹·감사 로그)
test.mjs         lib.js / locode.js 단위 테스트
```

> **Tauri 앱에서 Ollama 호출은 Rust 프록시를 경유한다.** 웹뷰 origin(`http://tauri.localhost`)이
> Ollama 기본 CORS 허용 목록에 없어 브라우저 fetch 가 403 을 받기 때문. 웹 미리보기에서는 직접 fetch 한다.

## CHAT / LOCODE 모드

- **CHAT** — 일반 대화 (기본). 기존 동작·저장된 대화 그대로.
- **LOCODE** — 로컬 프로젝트를 읽고·수정하고·검증 (Tauri 데스크톱 앱 전용). 헤더의 `CHAT | LOCODE` 로 전환.
  - Phase 1: 폴더 선택 → AI가 `list_dir`/`read_file`/`search` 로 프로젝트 분석 (파일 보기는 AI 작업 단계에서 열람)
  - Phase 2: **승인제 파일 쓰기** — AI가 `write_file`(새 파일·전체 재작성)/`edit_file`(부분 패치: `edits:[{old,new}]` 검색·치환 블록, Rust가 마스킹되지 않은 원본에 적용)/`move_path`/`delete_path` 를 제안하면
    접힌 diff 미리보기 + 승인 카드(삭제·이동은 Tier 2 빨간 경고). 승인해야만 반영.
    승인 카드에서 제안 내용 직접 수정, "이 작업의 남은 변경 자동 승인"(삭제·설치·네트워크 제외) 가능.
    변경 파일 원장(A/M/D/R + diff + **되돌리기**), 외부 변경 감지(mtime), 512KB 쓰기 한도.
  - Phase 3(현재): **승인제 명령 실행** — `run_command`는 프로젝트 루트에서만 실행되고, 실시간 출력·중지·기본 120초(백엔드 상한 600초)·256KB 출력 제한이 적용된다. 패키지 설치·네트워크·Git 변경은 `실행` 입력 재확인이 필요하며, 재귀 삭제·권한/레지스트리/시스템 변경·강제 Git 작업은 Rust에서 차단된다.
  - 모든 경로·명령 정책 검증은 Rust `locode.rs` 에서: 선택한 폴더 밖 접근 차단(`..`·심볼릭 링크 포함), `.env`·키 파일 읽기/쓰기 제한, 내용 비밀 패턴 마스킹.
  - 모델 등급 자동 분류: 코드 작업 권장 / LOCODE 가능 / 읽기·제안만 / CHAT 전용.
  - 실행 권한 모드(하단 선택): 항상 묻기 / 읽기·쓰기·수정 허용 / 위험 여부 확인 후 허용 / 전체 허용. 어느 모드에서도 차단 명령(`rm -rf` 등)은 자동 승인되지 않는다.
  - 반복 한도는 없으며, 같은 오류가 연속 8회 발생하면 자동 중단한다(중지 버튼 별도).
  - Phase 4~5(현재): 작업 패널에 파일 트리 브라우저(지연 로드, 클릭 시 미리보기), AI 작업 계획 체크리스트, Git 변경 파일·브랜치 패널, 최근 테스트/빌드/린트 결과 요약, append-only 감사 로그 뷰어를 제공한다. 이 패널들은 읽기 전용이다.

## 데이터 저장

대화·설정은 **IndexedDB**(`localai` DB)에 저장한다. 첨부 이미지(base64)가
커도 localStorage 5MB 한도에 걸리지 않는다. 첫 실행 시 기존 `localStorage`
데이터를 자동으로 옮기며, 원본은 롤백 대비로 지우지 않는다.

## 웹으로 실행 (개발/미리보기)

```bash
cd src
python -m http.server 8000
```

→ http://localhost:8000 (Ollama가 `ollama serve`로 떠 있어야 함)

## exe 빌드 (사용자 배포용)

### 1. 한 번만: 빌드 도구 설치

- **Rust**: https://rustup.rs — Windows는 `winget install Rustlang.Rustup` 후 새 터미널
- **Visual Studio C++ Build Tools**: `winget install Microsoft.VisualStudio.2022.BuildTools`
  설치 시 "C++를 사용한 데스크톱 개발" 워크로드 선택
- **WebView2**: Windows 11 기본 내장 (별도 설치 불필요)

### 2. 빌드

```bash
npm install
npm run build
```

결과물: `src-tauri/target/release/bundle/nsis/*-setup.exe`

현재 프로젝트는 Ollama의 범용 CPU 런타임을 함께 동봉한다. 모델 파일은 포함하지 않으며, 사용자가 앱 안에서 선택해 내려받는다.

### 3. 개발 중 실행

```bash
npm run dev
```

## 첫 실행 온보딩

설치된 모델이 없으면 채팅 화면 대신 온보딩이 나온다:
1. **Ollama 연결 확인** — 실패 시 "다시 확인" / "주소 변경" / 설치 링크
2. **첫 모델 받기** — 용도별 추천(일반 대화 / 코딩 / 저사양 PC / 이미지 이해),
   용량·권장 RAM 표시, 인라인 다운로드 진행률 + 취소

## Ollama 처리 방식

빌드된 앱은 실행 시 이 순서로 Ollama를 찾는다:

1. 이미 `localhost:11434`가 떠 있으면 → 그대로 사용
2. 앱에 동봉된 `resources/ollama/ollama.exe` → 백그라운드로 자동 실행
3. 시스템 PATH의 `ollama` → 자동 실행
4. 없으면 → 앱 안에 "Ollama를 설치하세요" 배너 표시

### Ollama를 설치본에 동봉해 빌드하기

이 프로젝트는 `src-tauri/ollama-bundle/`의 `ollama.exe`와 기본 CPU 라이브러리를 설치 파일의 `resources/ollama/`에 포함한다. 이 범용 런타임은 첫 실행에 별도 Ollama 설치가 필요 없고, 모델을 제외해 설치 파일 크기를 관리할 수 있다.

1. [Ollama Windows 설치본](https://ollama.com/download/windows)을 한 번 설치한다.
2. 프로젝트 루트에서 아래를 실행한다. 이미 이 프로젝트에는 런타임이 준비되어 있다.

```powershell
.\scripts\prepare-ollama-bundle.ps1
npm run build
```

3. 배포 파일은 `src-tauri/target/release/bundle/nsis/`에 생성된다.

앱은 `resources/ollama/ollama.exe serve`를 백그라운드에서 실행한다. 이미 `localhost:11434`에서 Ollama가 실행 중이면 그 인스턴스를 사용한다. 따라서 NVIDIA/AMD GPU 가속이 필요한 사용자는 공식 Ollama 전체 설치본을 실행해 둔 상태로 이 앱을 열면 해당 인스턴스를 그대로 쓴다. 모델은 설치본에 넣지 않으며 각 사용자가 처음 실행한 뒤 내려받는다.

Ollama 업데이트 때는 새 버전을 설치한 후 `ollama-bundle`을 새 런타임으로 교체하고 다시 빌드한다. Windows용 공식 standalone CLI는 앱 내장 용도를 지원하며, 라이브러리는 실행 파일 기준 `lib/ollama` 경로에 있어야 한다. [Ollama Windows 문서](https://docs.ollama.com/windows), [라이브러리 경로 문서](https://docs.ollama.com/development)

## 테스트

```bash
npm test
```

스트림 파싱·진행률 계산·첨부 제한·LOCODE 모델 분류·diff와 Rust 명령 정책을 검증한다.

## 기능

- 모델 카탈로그(범용·코딩·추론·비전·임베딩 등 30여 종) 검색 → 버전별 설치
- 다운로드 시 진행률 바 + 속도(MB/s)·남은 시간 표시
- 설치된 모델도 검색 가능, 모델 이름 직접 입력 설치 / 선택 / 삭제 (`src/models.json`에서 카탈로그 편집)
- 카탈로그의 각 모델에 강점(👍)·약점(⚠️) 표시 (`src/models.json`의 `pros`/`cons`)
- 채팅에 이미지·텍스트 파일 첨부(📎 또는 붙여넣기). 이미지는 비전 모델(llava, gemma3, moondream 등)에 전달, 텍스트 파일은 프롬프트에 삽입
- AI 응답의 마크다운 렌더링(제목·목록·굵게·코드블록·링크 등). 의존성 없이 자체 구현, HTML 이스케이프로 XSS 차단
- 스트리밍 채팅, 대화 목록은 IndexedDB 저장 (기존 localStorage 자동 이전)
- 컨텍스트 자동 압축(선택): 메시지 수가 임계값을 넘으면 오래된 메시지를 요약으로 접음
- 설정: 테마(자동/라이트/다크), Ollama 주소, 시스템 프롬프트, temperature
- 사이드바 대화 검색·날짜별 그룹·상단 고정, 대화 마크다운 내보내기(클립보드)
- 빈 화면 퀵스타트 프롬프트, 스크롤 하단 이동 버튼
- 키보드 단축키(`?` 로 목록): 새 채팅 `Ctrl/⌘+N`, 입력창 `+K`, 대화 검색 `+F`, 설정 `+,`, 이전/다음 대화 `Alt+↑/↓`

---

skipped: 코드블록/마크다운 렌더링, 자동 업데이트. add when: 필요해질 때.
