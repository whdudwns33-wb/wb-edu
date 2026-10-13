# AGENTS.md — WB 커리큘럼 플래너 작업 안내 (Codex·다른 에이전트용)

이 파일은 이 저장소에서 이어서 작업하는 코딩 에이전트를 위한 안내다. 사람용 설명은 [README.md](README.md)와 [docs/](docs/)에 있다.

## 현재 상태 (2026-10-13)

- 요구사항 v1.0 범위의 기능은 모두 구현되어 있다. 자동 테스트 220건 통과(shared 135 + server 69 + 운영 스크립트 7 + 웹 UI 9), 타입 검사·웹 빌드 오류 없음.
- 14차에서 운영 환경·백업 보호를 보완하고, 보충 연결 제목 선택·모바일 더보기·표준 dialog·탭 키보드 조작을 추가했다.
- 독립 코드 리뷰를 네 차례 했고 재현된 결함은 모두 고쳤다. 경과와 근거는 [docs/테스트결과.md](docs/테스트결과.md) (5·9·11·12차).
- 남은 일은 대부분 사용자 결정·실제 자료·실제 기기 확인이 필요하다. 아래 '남은 작업' 참고.

## 실행·검증 명령

Node 22.13 이상 필요(내장 `node:sqlite` 사용, 네이티브 모듈 없음). 포트 3987.

**이 저장소가 있는 PC(C:\Users\wb\wb-edu)는 실제 학원 PC이며 운영 서버가 돌고 있다 (2026-10-13 배포).**
- 운영 서버: 작업 스케줄러 'WB Planner Server'가 로그온 시 창 없이 실행, http://127.0.0.1:3987, 운영 DB `server/data/wb-edu.sqlite`, 기록 `server/data/logs/`.
- 매일 23:00 'WB Planner Backup'이 운영 DB를 `server/data/backups/`에 백업.
- 개발·확인용 데모 서버는 3988 포트로 띄운다: `npm run start:demo` (`.claude/launch.json`도 3988). `npm start`(3987)는 이 PC에서 운영 서버와 포트가 겹친다.
- 운영 DB·`.env.prod`·작업 스케줄러는 사용자 요청 없이 건드리지 않는다. 테스트는 메모리 DB나 데모 DB, 또는 `WB_ENV_FILE`로 지정한 임시 환경에서 한다.
- 코드를 바꿔 운영에 반영할 때는 배포 가이드의 '업데이트 절차'(backup:prod → build → `deploy\windows\server-control.ps1 restart`)를 따른다. `Stop-ScheduledTask`만으로는 서버 프로세스가 남아 포트를 쥔다.

```bash
npm install
```

```bash
npm run seed:sample
```

```bash
npm run build
```

```bash
npm start
```

```bash
npm test
```

```bash
npm run typecheck
```

- 데모 계정: admin/admin1234, teacher/teacher1234 (데모 DB `server/data/wb-edu.demo.sqlite`에만 있음).
- 운영 모드: `npm run setup:prod`(없으면 `.env.prod`를 만들고 점검) → `npm run start:prod`. 운영 DB는 `server/data/wb-edu.sqlite`로 데모와 분리된다. 운영 스크립트는 `scripts/prod-env.mjs`(환경 읽기), `start-prod.mjs`, `backup-prod.mjs`, `setup-prod.mjs`. 시험할 때는 `WB_ENV_FILE`로 다른 환경 파일을 가리켜 실제 `.env.prod`·운영 DB를 건드리지 않는다.
- 백업: 운영은 `npm run backup:prod`, 데모는 `npm run backup` (SQLite `VACUUM INTO`, `server/data/backups/`).
- Windows 작업 등록: `deploy/windows/register-tasks.ps1` (BOM 있는 UTF-8·CRLF 유지. Windows PowerShell 5.1이 한글을 바르게 읽도록).
- 변경을 마치기 전에 반드시 `npm test`, `npm run typecheck`, `npm run build -w web`을 모두 통과시킨다.

## 구조

- `shared/src` — 순수 TypeScript 도메인 로직. 편성 엔진(`scheduler.ts`), 진도 집계(`progress.ts`), 5종 보기(`views.ts`), 출력 열 정의(`output.ts`), 과정 조립(`assembler.ts`), 표·목차 가져오기(`importer.ts`, `toc.ts`), 달력(`ical.ts`), 날짜(`dates.ts`, 한국 시간 기준).
- `server/src` — Fastify 5 + `node:sqlite`. 문서는 `docs` 테이블에 JSON으로 저장하고 `version`으로 낙관적 동시성 제어(다르면 409). 라우트는 `routes/*.ts`, 엑셀은 `export.ts`.
- `web/src` — Vite 7 + React 19 + react-router 7. 화면은 `pages/*.tsx`, 공용 UI·훅은 `components/ui.tsx`.
- 테스트: `shared/test/*.test.ts`, `server/test/*.test.ts` (메모리 DB·`app.inject`), `scripts/test/*.test.mjs` (OS 임시 폴더만 사용), `web/test/*.test.tsx` (기존 React 서버 렌더링·탭 조작). 실제 브라우저 동작은 별도 확인한다.
- 문서: `docs/편성규칙.md`(규칙의 기준), `docs/데이터구조.md`, `docs/가정과제한.md`, `docs/테스트결과.md`, `docs/배포-가이드.md`, `docs/시범운영-가이드.md`.

## 지켜야 할 규칙

- 화면 문구·오류 메시지·문서·코드 주석은 한국어로 쓴다. 사용자는 한국어로 소통한다.
- 외부 AI·유료 API를 쓰지 않는다. 글자 인식(tesseract.js)도 앱 안의 데이터로 브라우저에서만 처리한다.
- 실제 학생 정보나 기존 서비스 데이터를 넣지 않는다. 샘플은 가상이며 제목에 `[가상]`과 `isSample` 표시를 붙인다.
- 실제 진도 기록은 지우지 않는다. 기록은 추가만 하고 배정마다 가장 최근 기록이 유효하다. 일정 연산은 기록·고정 배정을 움직이지 않는다.
- 저장 API는 `version`을 받아 다르면 409로 거절한다. 예외는 진도 기록·이해 확인의 자동 병합(화면에서 본 배정 `expect`가 같을 때만).
- 서버 입력은 `server/src/context.ts`의 `str`·`text`·`TEXT_LIMIT`·`HttpError`로 검사한다. 편성 엔진이 거절할 때는 한글 메시지를 가진 일반 `Error`를 던지고, 그것만 400으로 사용자에게 보인다.
- 시각은 UTC ISO로 저장하고 화면에는 `formatKST`(shared/dates.ts)로 보인다. '오늘'은 `todayKST()`.
- 화면과 인쇄·엑셀은 같은 집계(`buildPlanViews`)와 같은 열 정의(`output.ts`)를 쓴다. 한쪽만 고치지 않는다.
- 결함을 고치면 재현 테스트를 함께 넣고, `docs/테스트결과.md`에 차수를 이어 기록한다. 규칙이 바뀌면 `docs/편성규칙.md`도 고친다.
- 운영 배포, 외부 전송, 유료 가입, 시스템 설정 변경(작업 스케줄러 등록 등)은 사용자가 직접 하거나 명시적으로 승인한 뒤에만 한다.

## 함정

- Windows 환경이다. 줄바꿈은 `.gitattributes`로 LF 고정.
- 글자 인식 자산(`web/public/ocr/`)은 git에 없고 `predev`·`prebuild` 때 `scripts/copy-ocr-assets.mjs`가 복사한다.
- 서버는 `tsx`로 소스를 바로 실행한다(별도 서버 빌드 없음). 웹은 `npm run build -w web` 결과(`web/dist`)를 서버가 정적 파일로 낸다. 화면을 고친 뒤 웹을 다시 빌드해야 `npm start` 화면에 반영된다.
- `web/src/pages/PlanDetailPage.tsx`는 1400줄이 넘는다. 고칠 때 탭별 컴포넌트를 찾아 국소적으로 바꾼다.

## 남은 작업

### 1. 사용자 결정·자료가 필요한 것 (에이전트가 혼자 할 수 없음)

- **배포**: A 구성(학원 PC 한 대)으로 이 PC에 배포했다(2026-10-13). 작업 등록·첫 실행·백업 작업까지 확인. 사용자가 할 일: 초기 관리자 비밀번호(`.env.prod`)로 로그인해 비밀번호 바꾸기, `.env.prod`의 `WB_ADMIN_PASSWORD` 줄 지우기, 강사 계정 만들기, 휴일 확인.
- **운영 관리자 비밀번호**: `setup:prod`가 무작위로 만든 초기값을 첫 로그인 뒤 앱에서 바꾼다 (`.env.prod`는 git에 올라가지 않음).
- **도메인·HTTPS**: C 구성이면 `deploy/Caddyfile.example` 기준으로 설정.
- **시범 운영 자료**: 실제 교재 목차, 반 시간표(요일·시간·기간), 휴일. 절차는 [docs/시범운영-가이드.md](docs/시범운영-가이드.md), 의견 기록은 `docs/시범운영-피드백.md`.

### 2. 구현은 되어 있으나 실제 환경에서 확인하지 못한 것

- PC를 다시 로그온했을 때의 서버 자동 시작 (작업 등록·첫 실행·백업·서버 제어는 13차 실제 배포에서 확인).
- Caddy 리버스 프록시와 인증서 발급.
- 실제 휴대폰의 손가락 끌어 놓기 (브라우저의 휴대폰 화면 흉내와 터치 이벤트로만 확인).
- 구글·애플 캘린더가 구독 주소를 주기적으로 받아 가는지 (ical.js 파싱 검증만 함, 인터넷에 열린 서버 필요).
- 실제 교재 사진·스캔 PDF의 글자 인식 품질 (가상 그림으로만 확인. 영어 단어를 잘못 읽는 경우가 있어 사람이 확인하게 되어 있음).

### 3. 시범 운영 의견을 듣고 정할 후보

- 같은 수업에 한 항목이 두 줄(예: 24~29쪽, 30~33쪽)로 보이는 경우 한 줄로 합쳐 보이기. 과정이 항목을 두 차시에 나눠 둔 경우이며 쪽 중복은 없다.
- 보충형 과정의 보충 교재(활동 '연습') 완료율 표시. 지금 규칙은 '새 학습'만 완료율에 센다.
- 비밀번호 찾기, 일반 API 요청 속도 제한, 여러 서버 사이의 로그인 실패 제한 공유.

### 4. 하지 않기로 판단한 것 (다시 하려면 사용자와 상의)

- 같은 칸 실시간 동시 입력 (CRDT 등 구조 변경 필요).
- 서버 PDF 생성 (A4 인쇄 보기 → 브라우저 'PDF로 저장'으로 충족).

### 5. 기술 부채 (선택)

- 웹 공용 UI 회귀 테스트 9건은 있으나 브라우저 전체 흐름 자동 테스트는 없다. 실제 화면 동작은 브라우저에서 별도로 확인한다.
- ESLint 설정이 없다(타입 검사만 함).
- 문서를 SQLite에 JSON으로 저장하는 구조는 소규모(수십 사용자, 수천 계획)를 전제로 한다. 1년 계획 600항목 기준 측정치는 `docs/테스트결과.md` 8차.
- `PlanDetailPage.tsx` 분할.
