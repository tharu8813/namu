# LOCODE 모드 설계안

CHAT 모드(일반 대화)는 그대로 유지하고, 로컬 프로젝트를 읽고·수정하고·명령을
실행하는 **LOCODE** 모드를 추가한다. 이 문서는 구현 착수 전 합의용 설계안이다.

---

## 1. 조사 결과

### 현재 앱 구조
| 파일 | 역할 |
|---|---|
| `src/index.html` | 마크업 + 스타일 |
| `src/app.js` | 상태·렌더링·이벤트·채팅·모델·온보딩 (약 1,100줄) |
| `src/lib.js` | 순수 헬퍼 (스트림 파싱·마크다운·포맷·첨부 제한) |
| `src/store.js` | IndexedDB 영속 + localStorage 마이그레이션 |
| `src-tauri/src/main.rs` | Ollama 자동 실행, `disk_free_gb`, `open_url` 명령 |

- 대화는 `{ id, title, model, messages[], created, updated, summary, summarizedUpTo }` 형태로 IndexedDB `convos` 스토어에 저장.
- 메시지: `{ id, role, content, images?, fileText?, attachments?, error?, interrupted? }`.
- Tauri 명령은 `invoke_handler` 에 등록, 프런트는 `window.__TAURI__.core.invoke` 로 호출.
- CSP: `connect-src` 로 `localhost:11434` 만 허용, `script-src 'self'`.

### Ollama (이 머신: v0.33.2) 지원 범위
- `/api/show` → `capabilities`: `completion`, `tools`, `vision`, `insert`, `thinking`, `embedding` 중 해당하는 값.
- `tools`: 네이티브 함수 호출. `/api/chat` 에 `tools:[...]` 전달 → 응답 `message.tool_calls`. 스트리밍에서도 지원.
- `format`: JSON Schema 를 넘기면 출력이 스키마에 맞는 JSON 으로 강제됨(검증함 — 정상 동작). tools 없는 모델의 대안 프로토콜로 사용.
- `num_ctx` 옵션: 실제 컨텍스트 창. 기본값이 작으므로(2K~4K) 코드 작업 시 상향 필요.
- context_length: `/api/show` 의 `model_info["<arch>.context_length"]`.

### 설치된 모델 분류 예시 (이 머신)
| 모델 | capabilities | ctx | LOCODE 등급 |
|---|---|---|---|
| `qwen2.5-coder:32b` | completion, **tools**, insert | 32K | **코드 작업 권장** (단, 32B는 GPU 메모리 주의) |
| `llama3.2-vision:11b` | **tools**, completion, vision | 131K | 도구 호출 가능하나 코드 품질 보통 → LOCODE 가능(주의) |
| `exaone3.5:7.8b` | completion 만 | 32K | tools 없음 → **구조화 출력(JSON) 프로토콜**로 읽기+제안만 |

---

## 2. 구현 가능 범위와 제약

### 가능
- 네이티브 폴더 선택 (Rust `rfd`)
- 프로젝트 루트로 격리된 파일 읽기/목록/검색 (Rust, 실제 경로 검증)
- 파일 생성/수정 — diff 미리보기 + 승인, 원본 스냅샷 보관, 되돌리기
- 파일 삭제/덮어쓰기/이동 — 개별 재확인
- 명령 실행 — 작업 폴더 고정, 타임아웃·출력 상한·동시 1개·중지 버튼, 승인제, 위험 명령 차단
- 에이전트 루프 — tools 모델은 함수 호출, 그 외는 JSON 액션 프로토콜, 파싱 실패 시 자동 실행 금지
- 변경 파일 원장 + 되돌리기, Git 상태(읽기 전용) 표시
- 비밀값 마스킹, `.env`/키 파일 읽기 기본 차단
- 감사 로그 (append-only JSONL)

### 제약 / 수동 확인 필요
- **OS 수준 샌드박스는 없음.** 명령은 사용자 권한으로 실행됨. 완화책 = 작업폴더 고정 + 차단 목록 + 명시적 승인 + 타임아웃 (요구사항과 동일).
- 작은 모델(<3B) 또는 tools·구조화 출력이 불안정한 모델은 계획을 신뢰할 수 없음 → 읽기 전용 분석 또는 CHAT 전용으로 제한.
- 심볼릭 링크: `canonicalize` 로 실제 경로 해석 후 루트 접두사 검사로 탈출 차단. Windows 정션도 동일.
- 컨텍스트가 짧은 모델(<8K)은 큰 파일 여러 개를 동시에 다루기 어려움 → 경고 표시, 부분 읽기 유도.
- 바이너리 파일은 읽기 제외(크기/확장자/내용 heuristic).

---

## 3. 아키텍처

```
┌── Frontend (src/) ────────────────────────────┐
│  app.js        기존 CHAT + 모드 전환             │
│  locode.js     LOCODE 상태·에이전트 루프·UI      │  ← 신규
│  lib.js        + diff 파서, 액션 스키마          │
│  store.js      convos 에 mode/projectPath 필드   │
└───────────────────────────────────────────────┘
             │ window.__TAURI__.core.invoke (검증된 명령만)
┌── Rust (src-tauri/) ──────────────────────────┐
│  main.rs       핸들러 등록                       │
│  locode.rs     경로 검증 · 파일 IO · 명령 정책   │  ← 신규
│    - LocodeState { root: Option<PathBuf> }       │
│    - 모든 경로: root.join(rel) → canonicalize    │
│      → starts_with(root) 아니면 거부             │
└───────────────────────────────────────────────┘
```

**원칙:** 프런트엔드는 임의 경로·임의 명령을 절대 직접 실행하지 않는다.
모든 경로 검증·명령 정책·권한 판단은 Rust `locode.rs` 에서 수행한다.
프런트는 상대 경로와 명령 문자열만 넘기고, Rust 가 거부하면 그대로 표시한다.

### Rust 명령 (신규)
| 명령 | 등급 | 설명 |
|---|---|---|
| `locode_open_project()` | — | 폴더 선택 대화상자 → 루트 설정, canonical 경로·git 여부 반환 |
| `locode_close_project()` | — | 루트 해제 |
| `locode_list_dir(rel)` | 0 | 하위 항목(이름·종류·크기), 숨김·`node_modules` 등 기본 접힘 |
| `locode_read_file(rel)` | 0 | 텍스트 반환. 비밀 파일·바이너리·대용량 거부. 내용 비밀 패턴 마스킹 |
| `locode_search(query, opts)` | 0 | 루트 내 텍스트/파일명 검색 (ripgrep 유사, 자체 구현) |
| `locode_git_status()` | 0 | 브랜치·ahead/behind·변경 파일 목록 (읽기 전용) |
| `locode_write_file(rel, content)` | 1 | 원본 스냅샷 후 기록. 새 파일/수정 구분 |
| `locode_move(from, to)` | 2 | 이름 변경/이동. 둘 다 루트 내부 검증 |
| `locode_delete(rel)` | 2 | 삭제 (스냅샷 후) |
| `locode_run(cmd, timeout)` | 3/4 | 정책 검사 → 작업폴더=루트 로 실행, 출력 스트림 |
| `locode_stop_run(id)` | — | 실행 중 프로세스 종료 |
| `locode_audit(entry)` | — | 감사 로그 1줄 append |

---

## 4. 권한 모델 (Tier 0 ~ 4)

| Tier | 작업 | UX |
|---|---|---|
| **0 자동** | 디렉터리 목록, 파일 읽기(비밀 제외), 검색, git status | 즉시 실행. 액션 카드는 접힌 상태로 "읽음: src/app.js" |
| **1 일괄 승인** | 파일 생성·수정 | diff 미리보기 + `[승인] [수정] [거부]`. 여러 파일이면 한 번에 검토 |
| **2 개별 확인** | 삭제, 덮어쓰기(기존 파일 전체 교체), 이동/이름변경 | 파일마다 별도 확인. 빨간 경고색 + 아이콘 |
| **3 명령 승인** | 일반 터미널 명령 | "실행 명령 / 작업 폴더 / 예상 영향" 표시 후 `[실행] [취소]` |
| **4 차단·강력 재확인** | 위험/파괴적/네트워크/설치/배포/push | 기본 **차단**. 해제하려면 사용자가 확인 문구를 직접 입력 |

### Tier 4 차단 목록 (정규식, 대소문자 무시 — 항상 거부)
`rm -rf` · `rm ... -r ... -f` · `del /s` `del /q` · `rmdir /s` · `format ` · `mkfs` ·
`dd if=` · fork bomb · `reg add|delete|import` · `icacls` `takeown` · `netsh` ·
`bcdedit` `diskpart` · `shutdown` `reboot` · `git reset --hard` · `git clean -fd` ·
`git push --force` · `chmod -R 777` · `sudo` `runas` · `>` 로 시스템 경로 덮어쓰기

### Tier 4 재확인 목록 (실행 직전 별도 승인 + 무엇을 하는지 설명)
패키지 설치(`npm/pnpm/yarn/pip/cargo install|add|publish`) · `git push` · `git commit` ·
`curl` `wget` `Invoke-WebRequest` · `docker push` · `npx <임의>` · `gh ` · 배포 스크립트

### 실행 제한
- 타임아웃: 기본 120초 (설정에서 최대 600초)
- 출력: stdout+stderr 합쳐 256KB 초과 시 가운데 생략
- 동시 실행: 프로젝트당 1개
- 항상 중지 버튼 + 경과 시간 표시
- 작업 폴더는 프로젝트 루트(또는 그 하위)로 강제

---

## 5. 모델 분류 기준

`/api/show` 의 `capabilities` + `parameter_size` + `context_length` 로 자동 분류.
사용자가 수동 상향/하향 가능(경고 표시).

| 등급 | 조건 | LOCODE 에서 |
|---|---|---|
| **코드 작업 권장** ⭐ | 이름에 coder/codestral/devstral/deepseek-coder/starcoder/codellama/codegemma 포함, **또는** (`tools` 보유 AND ≥7B AND 비전 전용 아님) | 전체 기능 (계획·편집·명령) |
| **LOCODE 가능** | `tools` 보유 AND ≥3B | 전체 기능, "코드 품질은 전용 모델보다 낮을 수 있음" 안내 |
| **제한 (읽기+제안)** | `tools` 없음 AND ≥3B AND 임베딩·비전 전용 아님 | JSON 프로토콜로 분석·수정 제안만. 명령 실행은 사용자가 직접 승인한 것만, 자동 루프 없음 |
| **CHAT 전용** | <3B, 또는 임베딩 모델, 또는 소형 비전 전용, 또는 tinyllama류 | LOCODE 선택 시 "이 모델은 코드 작업에 적합하지 않습니다" + 대안 모델 추천 |

- `context_length < 8192` → 등급과 무관하게 "긴 파일 작업에 불리" 배지.
- 분류 결과는 모델 목록·헤더·모드 전환 화면에 배지로 표시.

---

## 6. LOCODE 액션 프로토콜

### tools 보유 모델
`/api/chat` 에 다음 도구 정의를 전달:
`list_dir(path)` · `read_file(path)` · `search(query, glob?)` · `propose_plan(steps[])` ·
`write_file(path, content, summary)` · `move_path(from, to)` · `delete_path(path)` ·
`run_command(command, why)` · `finish(summary)`

응답의 `tool_calls` → 액션 카드. Tier 0 은 즉시 실행 후 결과를 `role:"tool"` 메시지로
되돌려 루프 계속. Tier 1+ 는 승인 대기.

### tools 없는 모델 (구조화 출력)
`format` 에 아래 스키마를 강제, 매 턴 **액션 1개**:
```json
{ "thought": "…", "action": "read_file|list_dir|search|plan|write_file|move|delete|run|finish",
  "params": { … }, "message": "사용자에게 보일 설명" }
```
파싱 성공 → 위와 동일하게 처리.
**파싱 실패 → 루프 즉시 중단**, 원문 응답 표시, "AI 응답을 이해하지 못했습니다. 검토 후 직접 진행하세요."

### 공통
- 루프 최대 반복 25회 / 사용자 턴. 초과 시 중단하고 요약.
- 언제나 중지 버튼.
- 시스템 프롬프트에 프로젝트 요약(파일 트리 일부 + package.json 등) + 안전 규칙 주입.

---

## 7. UI 구조

- **모드 전환**: 새 채팅 화면 + 채팅 헤더에 `CHAT | LOCODE` 세그먼트. 대화별로 고정(`c.mode`).
- **LOCODE 화면 영역**:
  1. 상단 바 — `📁 프로젝트명` · 권한 상태 · `git: main` · 모델 등급 배지 · [프로젝트 닫기]
  2. 작업 패널(접이식) — 계획 체크리스트 + 변경 파일 목록(A/M/D, diff 열기, 되돌리기)
  3. AI 대화 — 액션 카드(읽기·검색 접힘 / 편집·명령 펼침+승인)
  4. 하단 — 작성창 + "실행 예정" 승인 바(대기 중일 때만)
- 위험 작업: 빨간색 + ⚠️ + 한 문장 경고. 일반 작업은 팝업 없이 인라인 카드.
- "무엇을 왜" 를 사람 문장으로: "`src/api.js` 를 읽어 인증 흐름을 확인합니다", "`npm test` 로 방금 수정한 코드를 검증합니다".

---

## 8. 감사 로그

- 위치: `<project>/.locode/audit.jsonl` (없으면 앱 데이터 폴더).
- 1줄 = `{ ts, session, model, action, params(요약), tier, decision: "auto|approved|denied|blocked", result: "ok|error", note }`.
- LOCODE 화면에서 "작업 기록" 뷰로 열람. 편집·삭제 불가(append-only).

---

## 9. 단계별 구현 계획

| Phase | 내용 | 완료 기준 |
|---|---|---|
| **1. 기반** | Rust `locode.rs`: 폴더 선택, 경로 격리 `list_dir`/`read_file`/`search`/`git_status`, 비밀 마스킹, 감사 로그 뼈대. 프런트: 모드 전환, LOCODE 대화 타입, 프로젝트 헤더, 읽기 전용 파일 트리 + "프로젝트 분석" (쓰기·명령 없음). **CHAT 모드 무변경.** | 경로 탈출 시도 거부 테스트, CHAT 대화 정상 |
| **2. 쓰기** | `write_file`(스냅샷) + diff 미리보기 + Tier 1 승인, 변경 원장 + 되돌리기. 이동/삭제 Tier 2. | diff 정확, 되돌리기 복원, 루트 밖 쓰기 거부 |
| **3. 명령** | `locode_run` 정책(차단·재확인·타임아웃·출력 상한·중지), Tier 3/4 승인 UI, 실시간 출력. | 위험 명령 차단, 타임아웃 동작, 중지 동작 |
| **4. 에이전트 루프** | tools 드라이버 + JSON 폴백, 계획 체크리스트, 반복 가드. 모델 분류 + 등급 게이팅 + 배지. | 파싱 실패 시 자동 실행 안 됨, 등급별 제한 동작 |
| **5. 마무리** | git 패널, 테스트/빌드/린트 결과 요약, 감사 로그 뷰어, 모델별 제한 안내. | 요구사항 UI 영역 전부 존재, 작동 안 하는 버튼 없음 |

각 Phase 끝에 `node test.mjs` + 브라우저 검증 + 보고.

### 필요한 새 의존성 (Rust)
- `rfd` (네이티브 폴더 대화상자) — 소형, UI 프레임워크 아님
- 검색은 자체 구현(외부 ripgrep 미의존). git 은 `git` CLI 호출(있을 때만).

---

## 미해결 / 확인 필요 사항

1. **명령 실행 셸**: `npm test` 같은 걸 위해 `cmd /C` / `sh -c` 로 실행(파이프·`&&` 허용). 대안은 셸 없이 argv 파싱(안전하지만 불편). → 셸 사용 + 차단목록으로 진행 예정.
2. **감사 로그 위치**: 프로젝트 안 `.locode/` vs 앱 데이터. → 프로젝트 안 우선, 쓰기 불가 시 앱 데이터.
3. **웹(비-Tauri) 실행 시**: LOCODE 는 Tauri 전용. 웹에서는 모드 전환에 "데스크톱 앱에서만 가능" 안내.
4. **동시 편집**: 외부에서 파일이 바뀐 경우 write 전 mtime 검사 후 충돌 경고.
