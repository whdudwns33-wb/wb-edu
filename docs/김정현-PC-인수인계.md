# 김정현 PC 인수인계 — WB 커리큘럼 플래너

기준: 2026-10-27. 이 문서는 비밀값을 포함하지 않는다.

## 서버와 작업 위치

- 실제 운영 서버: wb1의 `C:\Users\wb\wb-edu`. 운영 DB와 `.env.prod`는 이 PC에만 유지한다.
- 운영 웹: https://planner.wbcowork.com
- API: https://planner.wbcowork.com/api / 명세: https://planner.wbcowork.com/api/openapi.json
- MCP: https://planner.wbcowork.com/mcp (Streamable HTTP·Bearer 인증, 웹페이지 주소가 아님)
- 저장소: https://github.com/whdudwns33-wb/wb-edu (`main`)
- 김정현 PC 작업 폴더: `$env:USERPROFILE\wb-edu` (예: 로그인 사용자 폴더 아래 wb-edu). 실제 사용자 폴더 이름은 해당 PC에서 확인한다.
- 김정현 PC는 개발·외부 접속용이다. 운영 DB·비밀 환경 파일·Cloudflare 터널을 복사하거나 새 운영 서버를 만들지 않는다.

## 처음 준비

Node.js 22.13 이상(기존 검증 버전 사용)과 Git, Codex를 준비한다. PowerShell에서 실행한다. 이미 저장소가 있으면 새 clone 대신 아래의 기존 작업 절차를 따른다.

```powershell
Set-Location $env:USERPROFILE
git clone https://github.com/whdudwns33-wb/wb-edu.git
Set-Location (Join-Path $env:USERPROFILE 'wb-edu')
npm ci
npm run seed:sample
npm run build
npm run start:demo
```

데모 주소는 `http://127.0.0.1:3988`, 데모 계정은 `admin / admin1234`다. 이 계정은 로컬 가상 자료 검사 전용이다. 운영 로그인에 쓰지 않는다. 종료는 실행 터미널의 Ctrl+C다. 운영 설정 생성·작업 등록 스크립트는 이 PC에서 실행하지 않는다.

기존 작업 폴더가 있다면 `git status`를 먼저 확인한다. 미커밋 작업이 있으면 덮어쓰거나 reset/clean하지 않고 보존한다. 변경이 없는 main에서만 `git pull --ff-only origin main`, `npm ci`, 위 빌드·검사를 실행한다. 새 작업 브랜치는 `git switch -c codex/kim-followup`처럼 만든다.

## 운영 로그인과 연결 키

운영 아이디는 `wb김정현`이며 관리자다. 최초 로그인 비밀번호는 승인된 비밀 경로로 전달받고 본인이 바꾼다. 비밀번호를 모른다고 원장·기존 계정의 비밀번호를 임의 재설정하지 않는다. 최초 변경 전 업무·API·MCP 접근은 차단된다.

설정 → API·MCP 연결에서 **김정현 PC 전용** 키를 발급한다. 현재 전체 범위는 `manage`(전체 업무·사용자·휴일·설정 관리)다. 관리자가 발급한 관리 키도 원장 계정을 변경하거나 원장 권한을 부여할 수 없다. 원장 계정 관리가 필요하면 원장 본인의 로그인과 키를 사용한다. 기존 admin 키를 김정현 계정 키로 바꾸어 전달하지 않는다.

업무 키 `write`와 관리 키 `manage`는 별도다. 예전 업무 키는 자동 승격되지 않는다. 만료·폐기·비활성화·권한 변경·최초 비밀번호 변경 필요 상태는 매 요청에서 검사한다. 초기 비밀번호 재설정은 해당 사용자의 로그인과 외부 키를 폐기한다.

## Codex MCP 설정

현재 공식 설정 형식: https://learn.chatgpt.com/docs/extend/mcp?surface=cli

김정현 PC의 `%USERPROFILE%\.codex\config.toml`에 아래 항목을 추가한다. 파일 전체를 덮어쓰거나 다른 연결 항목을 지우지 않는다. 같은 이름이 있으면 해당 섹션만 확인한다.

```toml
[mcp_servers.wb_planner]
url = "https://planner.wbcowork.com/mcp"
bearer_token_env_var = "WB_PLANNER_API_TOKEN"
```

키는 config.toml·채팅·Git·명령 기록에 직접 적지 않는다. Windows 사용자 환경변수에 넣을 때 아래처럼 숨김 입력을 사용한다. 관리자 권한은 필요 없다. 이 PC 사용자 환경변수에만 저장하고 새로 실행한 Codex가 읽도록 한다. 설정 후 Codex를 완전히 종료하고 새 환경을 읽는 터미널에서 다시 실행한다.

```powershell
$plannerSecret = Read-Host '김정현 PC 전용 API 키 입력' -AsSecureString
$plannerPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($plannerSecret)
try {
    $plannerToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($plannerPointer)
    [Environment]::SetEnvironmentVariable('WB_PLANNER_API_TOKEN', $plannerToken, 'User')
    $env:WB_PLANNER_API_TOKEN = $plannerToken
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($plannerPointer)
    Remove-Variable plannerToken, plannerSecret -ErrorAction SilentlyContinue
}
```

API 직접 접속 시 `Authorization: Bearer` 헤더에 같은 환경변수를 사용한다. SDK 클라이언트로 initialize → tools/list → 조회 도구를 확인한다. OAuth 로그인 명령으로 연결하지 않는다. 키를 표시하거나 운영 자료를 쓰면서 연결을 검사하지 않는다. 다른 PC의 실제 환경변수 설정·MCP 연결은 해당 PC에서 마지막으로 확인해야 한다.

## 구현 범위와 변경 규칙

- 교재·과정·계획 조회·등록·수정, 진도 기록, 일정 미리보기·변경.
- 추가 관리: 사용자·권한·활성 상태·지정 초기값 재설정, 휴일, 기관·학년도·기본시간·과목 항목, 출력 양식, 학습목표.
- 사용자 수정은 목록에서 읽은 `revision`을 `expectRevision`으로 보낸다. 문서 수정은 현재 `version`을 보낸다.
- 사용자 발급·초기화는 `useInitialPassword:true`를 쓴다. 외부 요청에 비밀번호를 직접 넣지 않는다. 값은 운영 서버의 지정 비밀 설정에서 읽는다.
- 모든 외부 저장은 `Idempotency-Key`/MCP `requestId`, 쓰기 MCP는 `confirm:true`. 같은 작업 재시도에는 같은 값·입력을 쓴다.
- 운영 자료와 계정은 승인 없이 변경하지 않는다. 쓰기 검사는 로컬 데모·메모리 DB에서 한다.
- 서버 셸·SQL·임의 파일·API 키 추가 발급·샘플 일괄 삭제는 외부 키로 공개하지 않는다.
- 필수 검사: `npm test`, `npm run typecheck`, `npm run build -w web`.
- 운영 반영은 wb1에서 운영 DB 백업 → 코드 반영·빌드 → 플래너만 재시작 → 로컬·외부 접속·자료/계정 보존 검사 순서다. 재부팅은 하지 않는다.

## 김정현 PC Codex에 붙여 넣을 프롬프트

```text
WB 커리큘럼 플래너 작업을 이어서 진행해 줘.
저장소는 https://github.com/whdudwns33-wb/wb-edu 의 main이다.
작업 위치는 이 Windows 로그인 사용자의 프로필 아래 wb-edu 폴더다.
먼저 실제 경로와 git status를 확인하고 AGENTS.md 및 docs/김정현-PC-인수인계.md,
docs/API-MCP-가이드.md, docs/테스트결과.md 마지막 차수를 읽어라.
ponytail full을 적용하고 기존 코드·패턴을 우선 재사용해라.
기존 작업은 보존하고 깨끗한 작업본에서 codex/ 접두사 브랜치를 사용해라.
Node 22.13 이상과 Git을 확인하고 npm ci → npm run build → npm test → npm run typecheck를 수행해라.
샘플이 필요하면 이 PC 로컬 데모 DB에만 npm run seed:sample을 실행하고
npm run start:demo로 3988 포트를 사용해라. 운영 서버는 wb1의 C:\Users\wb\wb-edu에 있다.
운영 사이트 https://planner.wbcowork.com, MCP https://planner.wbcowork.com/mcp,
OpenAPI https://planner.wbcowork.com/api/openapi.json이다.
김정현 계정은 wb김정현 관리자이며 비밀번호는 채팅에 요청하거나 출력하지 마라.
첫 로그인 비밀번호 변경은 김정현 본인이 하게 해라.
연결은 김정현 PC 전용 manage 키와 WB_PLANNER_API_TOKEN 환경변수를 사용하고
기존 .codex/config.toml의 다른 연결은 보존해라. 환경변수는 값 대신 있음/없음만 확인해라.
MCP 32개 도구 목록과 조회만으로 운영 연결을 확인해라.
교재·과정·계획·진도·사용자·권한·휴일·설정의 저장 검사는 데모에서만 해라.
운영 DB·.env.prod·연결 키를 복사하거나 Git에 올리지 마라.
김정현 PC에 Cloudflare 터널·운영 작업 스케줄러를 추가하지 마라.
원장 보호, 현재 권한 확인, 최초 비밀번호 변경, version/expectRevision,
미리보기 승인과 중복 방지 검사를 유지해라. 재부팅은 하지 마라.
우선 최신 코드의 검사 결과와 남은 항목을 보고하고, 요청받은 기능만 이어서 작업해라.
```
