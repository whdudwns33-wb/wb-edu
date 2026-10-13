# WB 커리큘럼 플래너

저장소: https://github.com/whdudwns33-wb/wb-edu

시중교재·자체교재를 등록하고, 여러 교재를 조합해 **표준 커리큘럼**을 만든 뒤, 실제 수업 일정에 맞춰
**연간·분기·월간·주간·일간 진도계획표**를 생성·편집·출력하고 **실제 진도**를 기록하는 웹앱입니다.
학생·반을 등록하지 않아도 교재만으로 표준과정과 계획표를 만들 수 있습니다.

| 층 | 내용 | 저장 단위 |
|---|---|---|
| A. 교재 원본 | 교재·판본·목차·학습항목·제외 범위 | `textbook` |
| B. 표준 커리큘럼 | 날짜 없는 차시 구성(과정 조립판), 과정 버전 | `curriculum` |
| C. 실행 계획 | 시작일·요일·휴일·시간을 적용한 수업일·배정, 계획 버전·이력 | `plan` |
| D. 실제 진행 기록 | 완료·부분 완료·미진행·제외, 이해 확인 | `plan.records`, `plan.understandingChecks` |

실행 계획은 만들 때 사용한 **교재·과정 스냅샷**을 보존하므로, 교재·과정을 개정해도 과거 계획은 바뀌지 않습니다.

## 기술 구조

- **언어**: TypeScript 전체 (Node 22.13+ / 24 권장)
- `shared/` — 도메인 타입, 달력 계산, 자동 편성 엔진, 진도 계산, 5종 보기 집계, 학습목표 지도, 가져오기 파서, 조립판 로직. 순수 함수이며 서버·웹이 함께 사용합니다.
- `server/` — Fastify 5 + Node 내장 `node:sqlite` (외부 네이티브 모듈 없음). 세션 쿠키 인증, 서버 권한 검사, 낙관적 동시성 제어(409), 감사 로그, 엑셀 출력(exceljs).
- `web/` — Vite 7 + React 19 + react-router. 외부 UI 라이브러리 없이 CSS 변수 기반. A4 인쇄 스타일, 휴대폰 하단 탭.
- 외부 AI·유료 API 없음. 핵심 기능은 모두 로컬에서 작동합니다.

선택 이유: 유지보수 단순성(단일 언어, 의존성 최소), Windows에서 네이티브 빌드 없이 실행, 편성 규칙을 순수 함수로 두어 테스트와 재현(같은 입력 → 같은 결과)이 쉽도록 했습니다.

## 설치·실행

```bash
git clone https://github.com/whdudwns33-wb/wb-edu.git
cd wb-edu
npm install
```

데모(개발) 모드 — DB 파일 `server/data/wb-edu.demo.sqlite`:

```bash
npm run seed:sample      # 관리자(admin/admin1234), 샘플 강사(teacher/teacher1234), 가상 샘플 교재·과정 추가
npm run build            # 웹 빌드 + 타입검사
npm start                # http://127.0.0.1:3987 (빌드된 웹앱을 서버가 함께 서빙)
npm run start:demo       # 같은 데모 서버를 3988 포트로 (운영 서버가 3987을 쓰는 학원 PC에서 개발할 때)
```

개발 중 핫리로드가 필요하면 터미널 두 개에서:

```bash
npm run dev:server       # 서버 (tsx watch)
```

```bash
npm run dev:web          # Vite 개발 서버 http://127.0.0.1:5173 (/api 는 3987로 프록시)
```

운영 모드 — 별도 DB 파일 `server/data/wb-edu.sqlite` (샘플을 넣지 않습니다). 먼저 `npm run setup:prod`로 설정 파일 생성·준비 점검을 마친 뒤:

```bash
npm run start:prod
```

첫 실행에서 `WB_ADMIN_PASSWORD`가 비어 있으면 기본 비밀번호로 관리자가 만들어지지 않도록 실행을 중단합니다.
환경변수: `PORT`(기본 3987), `HOST`(기본 127.0.0.1), `WB_DB_PATH`(DB 경로 직접 지정), `WB_STATIC_DIR`(웹 빌드 경로), `WB_LOG=0`(로그 끄기), `WB_BACKUP_DIR`(백업 폴더).

운영 DB 백업(`VACUUM INTO`로 일관된 사본, 기본 60개 보관). `npm run backup`은 데모 DB를 백업합니다.

```bash
npm run backup:prod
```

학원 PC 한 대에 배포하는 순서(`npm run setup:prod` → 첫 실행 → 작업 스케줄러 등록)는 [docs/배포-가이드.md](docs/배포-가이드.md)의 'A 구성 따라 하기'에 있습니다. 운영 모드로 창 없이 실행하면 기록은 `server/data/logs/`에 남습니다(`WB_LOG_DIR`로 변경).

현재 운영 주소는 [planner.wbcowork.com](https://planner.wbcowork.com)입니다. 서버와 운영 DB는 학원 PC `WB1`의 `C:\Users\wb\wb-edu`에 있고, 기존 Cloudflare 터널이 외부 HTTPS 요청을 `127.0.0.1:3987`로 연결합니다. 이 PC의 서버·Cloudflare 연결기가 실행 중이고 인터넷에 연결되어 있어야 외부에서 사용할 수 있습니다.

시범 운영 절차는 [docs/시범운영-가이드.md](docs/시범운영-가이드.md), 피드백 기록은 [docs/시범운영-피드백.md](docs/시범운영-피드백.md), 교재 목차 붙여넣기 양식은 [docs/templates/학습항목-붙여넣기-양식.tsv](docs/templates/학습항목-붙여넣기-양식.tsv)를 보세요.

## 테스트

```bash
npm test                 # vitest: shared 135 + server 71 + 운영 스크립트 7 + 웹 UI 9 = 222건
npm run typecheck
```

테스트 시나리오와 결과: [docs/테스트결과.md](docs/테스트결과.md)

## 문서

- [docs/데이터구조.md](docs/데이터구조.md) — 데이터 모델, 식별자·버전·권한
- [docs/편성규칙.md](docs/편성규칙.md) — 자동 편성·재편성·진도 집계 규칙
- [docs/가정과제한.md](docs/가정과제한.md) — 가정, 미구현, 제한 사항
- [docs/테스트결과.md](docs/테스트결과.md) — 자동·실제 테스트 결과, 화면 예시
- [docs/시범운영-가이드.md](docs/시범운영-가이드.md) — 실제 교재로 시범 운영하는 절차
- [docs/배포-가이드.md](docs/배포-가이드.md) — 학원 PC 한 대 배포 따라 하기(`npm run setup:prod`), 자동 시작·자동 백업(Windows 작업 스케줄러), HTTPS 프록시(Caddy), 업데이트·복구
- [AGENTS.md](AGENTS.md) — 이어서 작업하는 코딩 에이전트(Codex 등)용 안내: 명령, 구조, 지켜야 할 규칙, 남은 작업

## 주요 메뉴

계획 목록 · 오늘 수업(휴대폰) · 교재 보관함 · 표준과정 보관함/과정 조립판 · 계획 만들기(과정 선택 → 범위 → 시작일·요일·시간 → 편성 결과 → 수정 → 확정) · 통합 진도표(연/분기/월/주/일 드릴다운) · 학습목표 지도 · 양식·운영 설정(학년도 시작월, 과목별 항목, 휴일, 출력 양식, 사용자, 샘플 데이터)

출력: A4 인쇄 보기(브라우저 'PDF로 저장'), 엑셀(5종 시트 일괄 또는 선택), 캘린더 파일(.ics)·구독 주소, 선택 기간, 강사용/학생·학부모용 구분, 양식별 열 선택.

글자 인식(OCR): 목차 사진·스캔 PDF를 브라우저 안에서 읽는다. 엔진과 한국어·영어 데이터(약 16MB)는 `npm run build`·`npm run dev:web` 때 `web/public/ocr`로 자동 복사되며 외부로 요청하지 않는다.

모든 샘플 데이터는 가상 자료이며 '가상 샘플' 표시가 붙습니다.
