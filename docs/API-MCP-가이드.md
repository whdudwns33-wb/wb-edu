# 외부 API·MCP 연결 안내

현재 상태: 2026-10-23 사용자 승인으로 API 키·MCP·반년 집계를 운영 서버에 반영했다. 외부 HTTPS에서 실제 MCP SDK 연결·17개 도구 목록·조회·읽기 키의 쓰기 차단·키 폐기와 6종 엑셀 출력을 확인했다. MCP 주소는 브라우저로 여는 화면이 아니며 Streamable HTTP 클라이언트로 연결한다.

## 계정과 권한

| 역할 | 공통 교재·과정 | 계획·진도 | 계정 관리 |
|---|---|---|---|
| 원장 | 조회·등록·수정 | 전체 | 원장·관리자·강사, 마지막 원장 보호 |
| 관리자 | 조회·등록·수정 | 전체 | 관리자·강사. 원장 변경·원장 권한 부여 불가 |
| 강사 | 조회 | 본인 생성 또는 허용된 계획만 | 자기 비밀번호·자기 외부 연결 |

새 강사 아이디는 `wb`+한글 이름이며 동명이인은 숫자로 구분한다. 한글은 NFC로 정규화해 중복 검사한다. 기존 영문 아이디는 유지한다. 초기 발급·재설정에는 운영 비밀 환경변수 `WB_USER_INITIAL_PASSWORD`를 사용할 수 있다. 값 자체는 문서·코드·로그에 기록하지 않는다. 첫 로그인 뒤 변경 전에는 자기 상태 조회·비밀번호 변경·로그아웃만 허용한다. 본인 새 비밀번호는 8~1024자이며 초기값 재사용을 거부한다. 관리자 재설정·비활성화와 본인 비밀번호 변경 시 기존 외부 키도 폐기한다.

운영 김정현 계정은 기존 ID를 유지한 `wb김정현` 관리자이며 최초 변경 필수다. 조영준은 기존 `whdudwns33` 계정을 원장으로 연결했고 비밀번호를 유지한다. 기존 `admin` 계정과 그 세션도 보존한다.

## 연결 준비

1. 앱 로그인 → 설정 → API·MCP 연결에서 연결 이름·권한·유효기간을 선택한다. 기본은 조회 전용·90일이며 최대 365일, 계정당 20개다. 원장·관리자는 manage(전체 업무·운영 관리)를 별도 선택할 수 있다. 기존 read/write 키는 자동 승격하지 않는다.
2. 키는 한 번만 표시된다. 연결 앱의 비밀 저장소나 환경변수에 보관한다. DB에는 SHA-256 해시만 저장하며 목록에서는 평문을 반환하지 않는다.
3. 연결이 끝나면 해당 키를 폐기한다. 권한 변경·비활성화·만료·폐기는 다음 요청부터 적용된다. 토큰의 범위와 사용자 역할을 함께 검사한다.

운영 주소는 API `https://planner.wbcowork.com/api`, MCP `https://planner.wbcowork.com/mcp`다. 서버와 기존 Cloudflare 연결은 그대로 사용한다. 개발 리허설은 `http://127.0.0.1:3988`의 메모리 DB만 사용했다.

OpenAPI 3.1 문서는 `/api/openapi.json`에서 제공한다. 자료를 포함하지 않는 `/api/health`는 공개 상태 확인용이다. 그 외 외부 요청은 `Authorization: Bearer <연결 키>`를 사용한다. 기존 read/write 키로는 계정·설정에 접근할 수 없다. manage 키는 기존 업무와 사용자·권한·휴일·설정·출력 양식·학습목표를 관리한다. 다른 키 발급·샘플 일괄 삭제·SQL·임의 명령은 공개하지 않는다.

```powershell
# WB_PLANNER_API_TOKEN은 연결 앱의 비밀 설정에서 읽는다. 실제 값을 명령 기록에 적지 않는다.
$headers = @{ Authorization = "Bearer $env:WB_PLANNER_API_TOKEN" }
Invoke-RestMethod 'https://planner.wbcowork.com/api/textbooks?limit=100' -Headers $headers
```

## 요청 계약

- 교재·과정·계획 목록·상세: `/api/textbooks`, `/api/curricula`, `/api/plans`와 `/{id}`. 등록은 POST, 수정은 PUT이며 수정에는 조회한 현재 `version`이 필요하다.
- 목록은 기본 100건, `limit=1~200`이다. 응답 헤더 `X-Next-Cursor`가 있으면 다음 요청의 `cursor`로 전달한다. 수정 중인 목록은 순서가 달라질 수 있어 커서가 사라지면 첫 페이지부터 다시 조회한다. 웹의 기존 목록 응답에는 적용하지 않는다.
- 진도: `GET /api/plans/{id}/views?from=YYYY-MM-DD&to=YYYY-MM-DD`. 같은 원본의 여섯 기간 집계와 현재 DB `version`을 반환한다. 반년은 **학년도 시작월부터 6개월씩**이며 달력 반기나 등록일부터 6개월과 구분한다. 배정이 없는 기간은 내용·목표 미확정이다.
- 계획 생성 전 POST `/api/plans/preview`로 같은 과정·설정·범위를 확인한다. 반환한 `approvalId`는 같은 연결 키·입력에 10분간 유효하다. POST `/api/plans`에 이를 포함한다. 과정·교재 버전이 바뀌면 재검토한다. 외부 생성은 단일 설정을 사용하며 학생별 3안 확정은 기존 앱 흐름에서 진행한다.
- 진도 추가: POST `/api/plans/{id}/records`. `assignmentId`, `status`(done/partial/not_done/excluded), 현재 `version`을 포함한다. 부분 완료에는 `completedPortion` 또는 `completedFraction`을 사용한다. 버전이 달라도 `expect`의 배정 식별·범위·시간이 같을 때만 기존 자동 병합을 허용한다. 기록은 추가만 한다.
- 일정 수정: POST `/api/plans/{id}/ops`에 `op`, `params`, 현재 `version`, `dryRun:true`를 보낸다. 변경 영향·경고를 확인한 뒤 **동일한** op/params/version과 반환된 `approvalId`, `dryRun:false`로 적용한다. 확인 ID는 10분간·같은 키·같은 입력에만 유효하고 서버 재시작 시 폐기된다. 버전이 바뀌면 적용이 409로 실패한다. 일정 연산은 기존 기록·고정 배정 보호 규칙을 그대로 따른다.
- 모든 외부 쓰기에는 8~100자의 `Idempotency-Key`(영문·숫자·밑줄·하이픈)가 필요하다. 같은 요청 재시도에는 같은 키·입력을 사용한다. 성공 응답을 재사용하며 다른 입력·역할에는 409다. 24시간 유효하고 이후 다음 쓰기에서 정리한다. 서버가 중간에 종료돼 응답 저장 여부를 확인할 수 없으면 409로 자동 재실행을 막는다. 이 경우 자료를 읽어 결과를 확인하고 담당자가 판단해야 한다.
- 연결당 분당 120회(외부 MCP 요청과 내부 API 호출을 함께 계산), 본문 API 10MiB·MCP 1MiB, MCP 요청 30초 제한이다. 쓰기는 계정·키 권한을 모두 충족해야 한다.
- 날짜는 한국 날짜 YYYY-MM-DD, 기록 시각은 UTC ISO다. 400 입력 오류, 401 잘못된·만료·폐기 키, 403 권한·첫 변경 필요, 404 대상 없음, 409 버전·미리보기·중복 키 충돌, 429 요청 한도다.

## MCP 클라이언트

공식 TypeScript SDK의 Streamable HTTP 클라이언트로 초기화·도구 목록·조회·쓰기·종료를 검증했다. Bearer 헤더를 지정할 수 있는 범용 클라이언트를 지원한다. OAuth 발견·동적 등록은 구현하지 않았으므로 OAuth 전용 클라이언트의 연결을 지원한다고 안내하지 않는다. 다른 PC에 클라이언트 설정을 임의로 설치하지 않았다.

연결 예시 개념(각 클라이언트의 비밀 변수 문법에 맞게 설정):

```json
{
  "url": "https://planner.wbcowork.com/mcp",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer ${WB_PLANNER_API_TOKEN}" }
}
```

기존 업무 도구 17개: 교재·과정·계획별 `list_*`, `get_*`, `create_*`, `update_*` 12개와 `get_progress_views`, `preview_plan`, `record_progress`, `preview_reschedule`, `apply_reschedule`다. 쓰기 도구는 `confirm:true`, 요청 재시도 식별자 `requestId`를 요구한다. 계획 생성·재편성은 서버가 미리보기 확인 ID까지 검사한다. metadata의 확인 설명만으로 권한을 대신하지 않는다. 운영 관리 도구 15개(list/create/update_users, list/create/update_holiday_sets, list/create/update_templates, list/create/update_objectives, get_password_policy, get/update_settings)를 추가해 총 32개다. manage 키와 현재 원장·관리자 권한이 필요하며, 관리자는 원장을 변경하거나 원장으로 승격할 수 없다. SQL·파일 실행은 제공하지 않는다.

`requestId`는 호출할 때마다 무조건 바꾸는 값이 아니다. 통신 실패로 **같은 작업**을 재시도할 때는 같은 값을 유지한다. 새 작업이나 입력 변경 시 새 값을 사용한다.

## 남은 범위

운영 API·MCP·반년 보기 배포와 외부 실제 MCP 연결 검증은 완료했다. 운영 자료를 바꾸는 쓰기 성공 검사는 메모리 DB에서 수행했고, 운영에서는 조회와 권한 차단만 검사했다. 학생 명부 원천·고유번호 연동과 학생별 활성 계획 선택·확정 원자성은 별도 작업지시서 범위이며 이번 연동 기반 작업을 그 전체 완료로 보고하지 않는다. PC 재부팅은 사용자 요청으로 미실시했다. SYSTEM 자동 시작 작업은 23차에 등록했고 실제 프로세스 종료 후 자동 복구를 확인했다. 실제 재부팅 검증은 사용자 요청으로 남겨 뒀다.


## 검토할 변경

- 서버: `app.ts`, `context.ts`, `db.ts`, `routes/users.ts`, `seed.ts`의 역할·최초 변경 상태와 `routes/api-tokens.ts`, `routes/external-safety.ts`, `routes/mcp.ts`, `openapi.ts`의 외부 연결.
- 공용 집계·출력: `shared/src/types.ts`, `views.ts`, `output.ts`, `server/src/export.ts`, 계획 views/export 라우트. 기존 JSON 문서·작성자 ID는 변환하지 않는다.
- 화면: 기존 권한 표시, 사용자·계정 설정, 첫 로그인 변경 전 메뉴 차단, `ApiConnections.tsx`, 반년 탭·인쇄·출력 열 선택.
- 운영 스크립트: `register-server.ps1`, `register-tasks.ps1`, `server-control.ps1`. SYSTEM 작업 등록·종료 후 자동 복구 확인을 완료했다.
- 검증: 역할 회귀, 외부 키·실제 MCP 클라이언트, 반년 경계·엑셀, Windows 작업 등록·제어 모의 검사. 최종 자동 검사 321건과 타입·웹 빌드가 통과했다.


## 운영 관리 요청 (2026-10-27 확장)

manage는 발급자의 현재 역할을 넘지 않는다. 강사는 발급할 수 없고 기존 manage 발급자가 강사로 낮아지면 관리 호출과 재시도도 거절한다. 만료·폐기·최초 변경 필수 검사도 유지한다.

- GET/POST `/api/users`, PUT `/api/users/{id}`, GET `/api/users/password-policy`.
- 사용자 목록·발급·수정 응답에는 비밀값 없는 `revision`을 포함한다. PUT은 목록에서 본 `revision`을 `expectRevision`으로 보내며 상태가 달라지면 409다. 문서의 정수 version과 구분한다.
- 사용자 생성·비밀번호 초기화는 `useInitialPassword:true`로 요청한다. 초기값은 서버의 지정 비밀 환경변수를 사용하며 첫 로그인 변경을 강제한다. 외부 API에 password 필드를 넣으면 거절한다. 값과 비밀번호 해시는 반환하지 않는다.
- GET/POST `/api/holiday-sets`, `/api/templates`, `/api/objectives`; PUT은 각 `/{id}`와 현재 version. 설정은 GET/PUT `/api/settings`이며 PUT에 현재 version이 필요하다.
- 모든 저장의 Idempotency-Key·MCP requestId와 confirm:true 규칙은 같다. 사용자 비활성화·초기화는 해당 계정의 세션과 외부 키를 폐기하므로 적용 전에 대상을 확인한다.
- 다른 PC 준비와 복사할 Codex 프롬프트는 [김정현 PC 인수인계](김정현-PC-인수인계.md)에 있다. 운영 자격정보·키·DB는 저장소에 포함하지 않는다.
