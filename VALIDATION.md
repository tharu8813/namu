# 구현 및 검증 결과

2026-11-02 LOCODE 도구 호출 호환성 추가 검증: `node test.mjs` 통과,
`npm run test:ui` 7개 통과, `cargo check --locked` 및 `cargo test --locked` 21개 통과.
실제 `qwen2.5-coder:7b` 본문 JSON 응답과 Auto 전환, 쓰기 승인 요청까지 확인했다.
실모델 점검의 백엔드는 모의이며 실제 Java 컴파일·실행과 Windows 승인 창 검증은
미수행이다. [상세 변경과 검증 범위](docs/locode-tool-compatibility.md)를 참고한다.
아래는 앞선 구현의 검증 기록이다.

기준일: 2026-11-02. 제공된 로컬 소스 사본에서 수행했다. Git 메타데이터가 없으므로
커밋·PR·원격 반영은 하지 않았다. 실제 검색 서비스에 사용자 대화나 프로젝트 파일을
전송하는 테스트는 하지 않았다.

## 실행 결과

|명령 / 검사|결과|실제로 확인한 범위|
|---|---|---|
|변경 전 `node test.mjs`|성공|기존 순수 함수 테스트 기준선|
|최종 `node test.mjs`|성공|기존 테스트 + security / transport / research / storage 네 묶음|
|`cargo check --locked` (src-tauri manifest)|성공|Windows Rust 컴파일, 갱신한 Cargo.lock 사용|
|`cargo test --locked` (src-tauri manifest)|21개 성공|네이티브 승인 바인딩, 경로·정션·하드 링크·폴더 교체, 비밀 마스킹, 외부 수정·삭제 및 복구 충돌, 바이너리 복구, 프로젝트 격리, 취소, 모의 검색 HTTP, 내부 IP·리다이렉트 차단, DPAPI|
|`cargo clippy --locked -- -D warnings`|성공|정적 경고 없음. Tauri IPC 경계의 인수 개수만 설명과 함께 국소 허용|
|`cargo fmt`|적용|변경한 Rust 소스 포맷 정리|
|`node node_modules/@playwright/test/cli.js test`|5개 성공|Windows Chrome, 실제 DOM/IndexedDB, 모의 Tauri IPC, 기본 검색 꺼짐·로컬 스트리밍·검색 출처·실패·취소·삭제 실행 취소 및 재시작 복원|
|`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-packaging.ps1`|성공|CPU 하위 DLL 경로 보존, GPU 하위 폴더 제외, 고지 포함, 기존 번들 덮어쓰기 거부, 버전 일치|
|`scripts/collect-licenses.ps1`|성공|Cargo 의존성 302개 라이선스 메타데이터와 제공된 고지 파일 수집|
|`npm run build -- --debug --no-bundle`|성공|Windows 실행 파일 생성. 설치/실행 완료와는 구분|

Rust 명령은 프로젝트 내부 `.tools/cargo`, `.tools/rustup`과 설치된 Visual Studio Scope
C++ SDK의 링커/라이브러리를 지정해 실행했다. 일반 개발 환경에서는 Rust 및 VS C++
Build Tools를 사용하면 된다. 이 환경의 샌드박스에서는 사용자 DPAPI 프로필에 접근할
수 없어 첫 암호화 테스트가 실패했다. 일반 Windows 사용자 환경에서 다시 실행하여
암호화·복호화 및 전체 21개 테스트의 성공을 확인했다.

브라우저 테스트도 샌드박스에서 하위 서버 프로세스 종료가 지연되어 해당 실행을
중지한 뒤, 일반 사용자 환경에서 전체 5개 테스트가 정상 종료되는 것을 확인했다.

## 테스트가 확인한 동작

- Markdown 따옴표/스킴/속성 주입, 인라인 코드·링크 재치환 방지, 실제 출처 번호 연결.
- 도구 필수 필드/타입/허용 이름 검증, 명령 문자열과 직접 실행 인수 구분, 잘린 도구
  결과도 파싱 가능한 JSON과 명시적인 truncated 표시로 전달.
- 웹 도구 호출 → 제공자 결과 → 모델 최종 답변의 모의 왕복. 도구 미지원 모델의
  검색/답변 대체 경로, 비검색 질문, 중복 캐시, 횟수 제한, 실패/미확인 결과, 취소.
- Ollama의 불완전 JSON·완료 없는 EOF·HTTP 오류·콜백 오류. 응답 헤더가 오기 전 실제
  로컬 HTTP 연결을 취소하면 소켓이 닫히는 것까지 확인.
- 마이그레이션 중 형식 오류/모의 용량 오류에 전체 롤백, 성공 marker 미기록, 재시도.
  기존 원본·더 새로운 대화 보존과 삭제/복구 순서, 재시작 후 복원.
- Windows Job에서 실제 자식 프로세스를 만들고 해당 Job만 종료. 별도의 Job은
  살아 있는지 확인하여 다른 프로세스 소유권을 건드리지 않음.
- 공개 서비스 대신 127.0.0.1 모의 HTTP 서버로 JSON 성공, 인증/제한/서버 오류,
  HTML 응답 거부, 응답 크기 제한, API 키의 다른 origin 리다이렉트 차단 검증.

## 빌드 산출물과 UI 확인

- 실행 파일: `src-tauri/target/debug/Namu.exe` (개발 빌드, Ollama 런타임 미동봉)
- UI 캡처: `test-results/settings-light.png`, `settings-dark.png`, `settings-search-dark.png`
- 캡처를 직접 확인해 검색 설정의 비밀번호/URL 입력 스타일과 밝은/어두운 테마를 정리했다.
- 브라우저 테스트에서 발견한 기존 토스트의 pointer-events 결함을 실제 수정했다.

## 실행하지 못한 항목과 제품의 한계

1. **실제 Brave/SearXNG 연동**: API 키와 운영 서버가 제공되지 않았다. 실제 API 호출
   코드는 구현하고 같은 HTTP 처리 경로를 로컬 모의 응답으로 검증했으며, 실서비스
   인증·요금·검색 품질을 검증했다고 주장하지 않는다. 설정의 연결 확인 버튼은 사용자가
   누를 때 명시된 공개 검색어를 실제 서비스로 보낸다.
2. **실제 Ollama 모델 추론·도구 품질·다운로드**: 설치된 Ollama/모델 및 동봉 CPU
   런타임이 없다. 채팅/도구 왕복은 모의 IPC/HTTP로 검증했다. 실제 모델별 도구 호출,
   비전 응답, 다운로드·삭제 및 GPU runner 동작은 실환경 추가 확인이 필요하다.
3. **완성 설치본/설치·업데이트·제거**: CPU 런타임이 없어 Inno 배포본을 만들지 않았다.
   실행 파일 빌드와 패키징 픽스처 테스트의 성공은 설치 후 엔진 정상 실행의 증거가
   아니다. Inno 설치 환경에는 WebView2가 별도로 필요할 수 있다. 강제 종료 업그레이드를
   피하고 사용자 데이터 경로를 지우는 제거 규칙을 추가하지 않았다.
4. **권한 UI의 실제 네이티브 클릭 경로**: 승인 해시·일회성·만료·프로젝트 검증은
   Rust 테스트로 확인했다. 실제 사용자 승인 대화상자를 자동 승인하는 종단 테스트는
   하지 않았다. 중지 후 열려 있는 네이티브 창은 사용자가 닫아야 하며, 그 이전 작업의
   승인으로 실제 변경을 실행할 수 없도록 epoch를 검증한다.
5. **샌드박스/탐지/인용**: 터미널은 OS 파일·네트워크 샌드박스가 아니다. 비밀 탐지와
   프롬프트 지침만으로 모든 유출·프롬프트 인젝션·허위 주장을 방지할 수 없다. LOCODE
   검색은 자동 모드에서도 사용자에게 다시 확인한다. 인용 링크가 실제 조회 출처라는
   사실과 해당 출처가 답변의 모든 주장을 뒷받침한다는 사실은 별개다.
6. **복구·저장**: 스냅샷은 앱 종료 전 최대 32건, 파일 512KB, 빈 폴더만 지원한다.
   여러 파일을 하나의 디스크 트랜잭션으로 커밋하거나 크래시 후 스냅샷을 복구하지 않는다.
   강제 종료 직전의 비동기 대화 저장까지 보장하지 않는다. 기존에 저장된 변경 원문은
   삭제하지 않았지만, Rust 원본이 없는 이전 기록은 자동 복구하지 않는다.
7. **성능·이식성**: 컨텍스트/이미지 토큰은 추정이다. Windows 보호를 다른 OS에도
   동일하게 제공한다고 주장하지 않는다. 긴 대화 렌더러의 완전한 가상화는 하지 않았다.
   원격 Ollama의 디스크는 알 수 없으므로 로컬 디스크 경고를 표시하지 않는다. 외부
   Ollama가 다른 모델 경로 환경으로 실행 중이면 사용자가 해당 경로를 확인해야 한다.
8. **CI/graphify**: CI에는 새 회귀 테스트를 연결했지만 원격 CI를 실행하지 않았다.
   PATH에서 Python/uv/graphify를 찾지 못해 그래프 생성은 수행하지 않고 실제 소스 흐름을 직접 조사했다.

## 변경 파일

- 프런트엔드: `src/app.js`, `locode.js`, `lib.js`, `net.js`, `store.js`, `index.html`, 새 `research.js`
- Rust: `src-tauri/Cargo.toml`, `Cargo.lock`, `src/main.rs`, `locode.rs`, `ollama.rs`, 새 `approval.rs`, `process.rs`, `web.rs`
- 빌드/검증: `package.json`, `package-lock.json`, `.gitignore`, `test.mjs`, `playwright.config.mjs`, `tests/*.mjs`, `.github/workflows/ci.yml`
- 배포: `scripts/dev-server.mjs`, `prepare-ollama-bundle.ps1`, `build-installer.ps1`, 새 `collect-licenses.ps1`, `test-packaging.ps1`, `setup.iss`
- 문서: `README.md`, `LOCODE_DESIGN.md`, `AUDIT.md`, 이 문서

동시에 추가된 개발 환경/VS Code 설정은 보존했다. 자세한 기능·설정 방법은 README,
권한과 데이터 흐름은 LOCODE_DESIGN을 참고한다.
