export const openapi = {
  openapi: '3.1.0',
  info: { title: 'WB 커리큘럼 플래너 외부 API', version: '1.0.0', description: '사용자 권한과 키 범위의 교집합만 허용합니다. API 키는 설정 → API·MCP 연결에서 발급합니다. 수정은 현재 version, 쓰기 재시도는 같은 Idempotency-Key가 필요합니다. MCP는 Bearer 헤더를 지원하는 Streamable HTTP 클라이언트용이며 OAuth는 제공하지 않습니다.' },
  servers: [{ url: 'https://planner.wbcowork.com' }, { url: 'http://127.0.0.1:3988', description: '개발·데모 전용' }],
  security: [{ bearerAuth: [] }],
  paths: {} as Record<string, unknown>,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: '연결별 API 키. 평문은 발급 시 한 번만 제공됩니다.' } },
    schemas: {
      Input: { type: 'object', additionalProperties: true, description: '기존 웹 API와 같은 필드. 상세 데이터 구조는 docs/데이터구조.md를 참조하세요.' },
      VersionedInput: { type: 'object', required: ['version'], properties: { version: { type: 'integer', minimum: 1 } }, additionalProperties: true },
      Error: { type: 'object', properties: { error: { type: 'string' }, details: {} } },
      Progress: { type: 'object', required: ['assignmentId', 'status', 'version'], properties: { assignmentId: { type: 'string' }, status: { enum: ['done', 'partial', 'not_done', 'excluded'] }, version: { type: 'integer', minimum: 1 }, completedPortion: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' } } }, completedFraction: { type: 'number', minimum: 0, maximum: 1 }, note: { type: 'string' }, reason: { type: 'string' }, expect: { type: 'object', description: '이전 버전의 자동 병합에 필요한 화면에서 본 배정. lessonId,itemId,from,to,minutes.' } } },
      Operation: { type: 'object', required: ['op', 'version'], properties: { op: { enum: ['reschedule', 'cancel_lesson', 'add_makeup', 'postpone', 'continue', 'swap', 'pin', 'unpin', 'exclude', 'undo', 'settings'] }, params: { type: 'object', additionalProperties: true }, version: { type: 'integer', minimum: 1 }, dryRun: { type: 'boolean', description: 'true이면 미리보기만 수행. false이면 검증된 approvalId 필수.' }, approvalId: { type: 'string', description: '같은 키·입력·버전에 10분간 유효한 확인 ID.' } } },
    },
  },
};
const content = (schema: unknown) => ({ 'application/json': { schema } });
const responses = { '200': { description: '성공', content: content({}) }, '201': { description: '등록 성공', content: content({}) }, ...Object.fromEntries([400, 401, 403, 404, 409, 429].map(code => [String(code), { description: ({ 400: '입력 오류', 401: '인증 필요', 403: '권한 부족 또는 첫 비밀번호 변경 필요', 404: '대상 없음', 409: '버전·확인·중복 방지 키 충돌', 429: '요청 한도' } as Record<number, string>)[code], content: content({ $ref: '#/components/schemas/Error' }) }])) };
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const key = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' }, description: '같은 요청 재시도에는 같은 키와 입력을 사용합니다. 24시간 보관합니다.' };
const body = (name: string) => ({ required: true, content: content({ $ref: '#/components/schemas/' + name }) });
for (const [resource, label] of [['textbooks', '교재'], ['curricula', '과정'], ['plans', '계획']]) {
  openapi.paths['/api/' + resource] = {
    get: { summary: label + ' 목록', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }, { name: 'cursor', in: 'query', schema: { type: 'string' }, description: '이전 응답의 X-Next-Cursor 값. 목록 변경 시 첫 페이지부터 재조회하세요.' }], responses },
    post: { summary: label + ' 등록 (write 키)', description: resource === 'textbooks' ? 'title, kind(market/inhouse), edition, items 등. 원장·관리자만 허용.' : resource === 'curricula' ? 'title, subject, compositionMode, textbooks, sessions 등. 원장·관리자만 허용.' : 'curriculumId, settings(startDate,endDate,weekdays,minutesPerLesson,mode 등), 같은 입력의 /api/plans/preview가 반환한 approvalId. 교재·과정이 바뀌면 재검토. learningApproach 3안 확정은 앱에서 진행.', parameters: [key], requestBody: body('Input'), responses },
  };
  openapi.paths['/api/' + resource + '/{id}'] = { get: { summary: label + ' 상세', parameters: [id], responses }, put: { summary: label + ' 수정 (write 키)', parameters: [id, key], requestBody: body('VersionedInput'), responses } };
}
openapi.paths['/api/plans/{id}/views'] = { get: { summary: '동일 계획의 일간·주간·월간·분기·반년·연간 진도', parameters: [id, ...['from', 'to'].map(name => ({ name, in: 'query', schema: { type: 'string', format: 'date' }, description: '한국 날짜 YYYY-MM-DD. 둘 다 지정하면 포함 범위로 집계.' }))], responses } };
openapi.paths['/api/plans/{id}/records'] = { post: { summary: '진도 기록 추가 (write 키)', description: '기존 기록은 지우지 않습니다. 버전이 다르면 expect가 같은 배정일 때만 병합합니다.', parameters: [id, key], requestBody: body('Progress'), responses } };
openapi.paths['/api/plans/preview'] = { post: { summary: '계획 미리보기 (read 키 가능)', requestBody: body('Input'), responses } };
openapi.paths['/api/plans/{id}/ops'] = { post: { summary: '일정 변경 미리보기·검토 결과 적용', description: 'dryRun=true로 먼저 요청합니다. 반환된 approvalId·현재 version·동일 op/params를 보내 적용합니다. 입력이나 버전이 바뀌면 재검토가 필요합니다. 적용은 write 키와 Idempotency-Key가 필요합니다.', parameters: [id, { ...key, required: false }], requestBody: body('Operation'), responses } };
openapi.paths['/api/health'] = { get: { summary: '개인정보 없는 서버 상태', security: [], responses } };

// 운영 관리 키는 기존 업무 키의 권한을 자동으로 확장하지 않는다.
for (const [resource, label] of [['users', '사용자·권한'], ['holiday-sets', '휴일'], ['templates', '출력 양식'], ['objectives', '학습목표']]) {
  const user = resource === 'users';
  openapi.paths['/api/' + resource] = {
    get: { summary: label + ' 목록 (manage 키)', description: user ? '비밀번호·해시는 반환하지 않습니다. 수정 전에 revision을 확인하세요.' : '원장·관리자 전용 운영 관리 키가 필요합니다.', responses },
    post: { summary: label + ' 등록 (manage 키)', description: user ? 'username, displayName, role, useInitialPassword:true. 최초 변경 필수. 비밀번호 직접 전송 불가. 원장 부여는 원장만 가능.' : '기존 웹 API와 같은 입력입니다.', parameters: [key], requestBody: body('Input'), responses },
  };
  openapi.paths['/api/' + resource + '/{id}'] = { put: { summary: label + ' 수정 (manage 키)', description: user ? '목록의 revision을 expectRevision으로 보냅니다. 이름·역할·활성 상태·useInitialPassword:true 재설정을 지원합니다. 원장 보호·자기 권한 해제 차단·초기 변경 필수 규칙을 유지합니다.' : '현재 version이 필요합니다.', parameters: [id, key], requestBody: body(user ? 'Input' : 'VersionedInput'), responses } };
}
openapi.paths['/api/settings'] = { get: { summary: '운영 설정 조회 (manage 키)', responses }, put: { summary: '운영 설정 수정 (manage 키)', parameters: [key], requestBody: body('VersionedInput'), responses } };
openapi.paths['/api/users/password-policy'] = { get: { summary: '지정 초기 비밀번호 설정 여부만 조회 (manage 키)', responses } };
