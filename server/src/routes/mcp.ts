import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { HttpError, requireUser } from '../context.ts';

export function registerMcpRoute(app: FastifyInstance) {
  app.get('/mcp', async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'MCP는 POST 방식으로 연결하세요.' }));
  app.route({ method: ['DELETE', 'PUT', 'PATCH', 'OPTIONS'], url: '/mcp', handler: async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ error: 'MCP는 POST 방식으로 연결하세요.' }) });
  app.post('/mcp', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    requireUser(req);
    if (!req.headers.authorization) throw new HttpError(401, 'MCP 연결에는 API 키가 필요합니다.');
    if (req.headers.origin && !['https://planner.wbcowork.com', 'http://127.0.0.1:3987', 'http://localhost:3987'].includes(req.headers.origin)) throw new HttpError(403, '허용되지 않은 요청 출처입니다.');
    const server = new McpServer({ name: 'wb-curriculum-planner', version: '1.0.0' });
    const data = z.record(z.string(), z.unknown()).describe('REST API와 같은 입력 필드. 수정과 진도 기록은 조회한 version을 포함합니다.');
    const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe('조회 결과의 id');
    const invoke = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, requestId?: string) => {
      const res = await app.inject({ method, url, payload, headers: { authorization: req.headers.authorization!, ...(requestId ? { 'idempotency-key': requestId } : {}) } });
      return { isError: res.statusCode >= 400, content: [{ type: 'text' as const, text: JSON.stringify({ status: res.statusCode, data: res.json(), ...(res.headers['x-next-cursor'] ? { nextCursor: res.headers['x-next-cursor'] } : {}) }) }] };
    };
    for (const [entity, label] of [['textbooks', '교재'], ['curricula', '과정'], ['plans', '계획']] as const) {
      server.registerTool('list_' + entity, { description: label + ' 목록을 조회합니다.', inputSchema: { limit: z.number().int().min(1).max(200).optional(), cursor: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, ({ limit, cursor }) => invoke('GET', '/api/' + entity + '?limit=' + (limit ?? 100) + (cursor ? '&cursor=' + cursor : '')));
      server.registerTool('get_' + entity, { description: label + ' 상세와 현재 version을 조회합니다.', inputSchema: { id }, annotations: { readOnlyHint: true, openWorldHint: false } }, ({ id }) => invoke('GET', '/api/' + entity + '/' + id));
      server.registerTool('create_' + entity, { description: label + '을 등록합니다. 계획은 preview_plan과 같은 설정 및 반환된 approvalId가 필요합니다. 사용자 요청을 확인하고 confirm=true로 실행하세요.', inputSchema: { data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, ({ data, requestId }) => invoke('POST', '/api/' + entity, data, requestId));
      server.registerTool('update_' + entity, { description: label + '을 수정합니다. 먼저 상세를 조회하고 data에 현재 version을 포함하세요. 충돌 시 재조회하고 덮어쓰지 마세요.', inputSchema: { id, data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } }, ({ id, data, requestId }) => invoke('PUT', '/api/' + entity + '/' + id, data, requestId));
    }
    for (const [entity, route, label] of [['users', 'users', '사용자·권한'], ['holiday_sets', 'holiday-sets', '휴일 세트'], ['templates', 'templates', '출력 양식'], ['objectives', 'objectives', '학습목표']] as const) {
      server.registerTool('list_' + entity, { description: label + ' 목록을 조회합니다. manage 키와 원장·관리자 권한이 필요합니다. 사용자 결과의 revision은 수정의 expectRevision에 사용합니다.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => invoke('GET', '/api/' + route));
      server.registerTool('create_' + entity, { description: label + '을 등록합니다. manage 키가 필요합니다. 사용자 발급은 username, displayName, role, useInitialPassword:true를 사용하며 비밀번호를 직접 보내지 않습니다.', inputSchema: { data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, ({ data, requestId }) => invoke('POST', '/api/' + route, data, requestId));
      server.registerTool('update_' + entity, { description: label + '을 수정합니다. manage 키가 필요합니다. 사용자는 목록에서 확인한 expectRevision, 다른 문서는 현재 version이 필수입니다. 관리자는 원장을 변경하거나 원장 권한을 부여할 수 없습니다. 비밀번호 재설정은 useInitialPassword:true로 하며 해당 사용자의 로그인·키가 폐기됩니다.', inputSchema: { id, data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, ({ id, data, requestId }) => invoke('PUT', '/api/' + route + '/' + id, data, requestId));
    }
    server.registerTool('get_password_policy', { description: '지정 초기 비밀번호 설정 여부만 조회합니다. 실제 값은 반환하지 않습니다. manage 키가 필요합니다.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => invoke('GET', '/api/users/password-policy'));
    server.registerTool('get_settings', { description: '기관명·학년도·수업시간·과목별 항목을 조회합니다. manage 키가 필요합니다.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => invoke('GET', '/api/settings'));
    server.registerTool('update_settings', { description: '운영 설정을 수정합니다. manage 키와 현재 version이 필요합니다. 기존 계획을 자동 재편성하지 않습니다.', inputSchema: { data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, ({ data, requestId }) => invoke('PUT', '/api/settings', data, requestId));
    server.registerTool('record_progress', { description: '계획에 진도 기록을 추가합니다. 기존 기록은 보존합니다. data에는 assignmentId, status(done/partial/not_done/excluded), version 및 필요시 expect·completedPortion·note를 입력하세요.', inputSchema: { id, data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, ({ id, data, requestId }) => invoke('POST', '/api/plans/' + id + '/records', data, requestId));
    server.registerTool('get_progress_views', { description: '같은 계획의 일간·주간·월간·분기·반년·연간 진도를 조회합니다. from/to는 한국 날짜 YYYY-MM-DD입니다.', inputSchema: { id, from: z.iso.date().optional(), to: z.iso.date().optional() }, annotations: { readOnlyHint: true, openWorldHint: false } }, ({ id, from, to }) => invoke('GET', '/api/plans/' + id + '/views' + (from && to ? '?from=' + from + '&to=' + to : '')));
    server.registerTool('preview_plan', { description: '계획을 저장하지 않고 미리봅니다.', inputSchema: { data }, annotations: { readOnlyHint: true, openWorldHint: false } }, ({ data }) => invoke('POST', '/api/plans/preview', data));
    server.registerTool('preview_reschedule', { description: '일정 변경 영향을 미리봅니다. data에는 op, params, 현재 version이 필요합니다. 반환한 approvalId는 10분간 같은 입력에만 유효합니다.', inputSchema: { id, data }, annotations: { readOnlyHint: true, openWorldHint: false } }, ({ id, data }) => invoke('POST', '/api/plans/' + id + '/ops', { ...data, dryRun: true }));
    server.registerTool('apply_reschedule', { description: '사용자가 검토한 일정 변경을 적용합니다. 미리보기와 같은 op, params, version 및 approvalId를 보내세요. 동일 재시도는 같은 requestId를 사용하세요.', inputSchema: { id, data, requestId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/), confirm: z.literal(true) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }, ({ id, data, requestId }) => invoke('POST', '/api/plans/' + id + '/ops', { ...data, dryRun: false }, requestId));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const timer = setTimeout(() => { reply.raw.destroy(); void server.close(); }, 30000);
    reply.raw.on('close', () => { clearTimeout(timer); void server.close(); });
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
