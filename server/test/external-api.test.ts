import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { seedSamples } from '../src/seed.ts';
import { SAMPLE_IDS, type Plan } from '@wb/shared';
const { app, ctx } = await buildApp({ dbPath: ':memory:' });
let cookie = '', origin = '';
beforeAll(async () => {
 ctx.store.insertUser({ id: 'manager', username: 'manager', displayName: '[가상] 관리자', role: 'admin', passwordHash: hashPassword('test-password'), createdAt: ctx.now() });
 seedSamples(ctx);
 const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'manager', password: 'test-password' } });
 cookie = 'wb_session=' + res.cookies[0].value;
 origin = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(() => app.close());
async function issue(scope = 'read') {
 const res = await app.inject({ method: 'POST', url: '/api/api-tokens', headers: { cookie }, payload: { name: '[가상] 테스트 연결', scope } });
 expect(res.statusCode).toBe(201);
 return res.json() as { token: string; id: string };
}
const request = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + token, 'idempotency-key': randomUUID() } });
it('키는 한 번 발급하며 해시만 저장하고 목록에서는 숨긴다', async () => {
 const key = await issue();
 expect(key.token).toMatch(/^wbp_[A-Za-z0-9_-]{43}$/);
 const row = ctx.store.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(key.id)!;
 expect(JSON.stringify(row)).not.toContain(key.token);
 expect((await app.inject({ method: 'GET', url: '/api/api-tokens', headers: { cookie } })).body).not.toContain(key.token);
 expect((await request(key.token, 'GET', '/api/textbooks')).statusCode).toBe(200);
 expect((await request(key.token, 'POST', '/api/textbooks', { title: '[가상] 차단' })).statusCode).toBe(403);
 expect((await request(key.token, 'GET', '/api/users')).statusCode).toBe(403);
 expect((await request(key.token, 'POST', '/api/api-tokens', { name: '우회', scope: 'write' })).statusCode).toBe(403);
});
it('쓰기 키도 기존 역할 권한과 버전 충돌 검사를 우회할 수 없다', async () => {
 const key = await issue('write');
 const made = await request(key.token, 'POST', '/api/textbooks', { title: '[가상] API 교재', items: [], isSample: true });
 expect(made.statusCode).toBe(201);
 const book = made.json();
 expect((await request(key.token, 'PUT', '/api/textbooks/' + book.id, { ...book, version: book.version + 1 })).statusCode).toBe(409);
 ctx.store.updateUser('manager', { role: 'teacher' });
 expect((await request(key.token, 'POST', '/api/textbooks', { title: '[가상] 권한 축소', items: [] })).statusCode).toBe(403);
 ctx.store.updateUser('manager', { role: 'admin', active: false });
 expect((await request(key.token, 'GET', '/api/textbooks')).statusCode).toBe(401);
 ctx.store.updateUser('manager', { active: true });
});
it('만료·폐기·잘못된 키를 거부하며 쿠키로 대체하지 않는다', async () => {
 const expired = await issue();
 ctx.store.db.prepare('UPDATE api_tokens SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expired.id);
 expect((await request(expired.token, 'GET', '/api/plans')).statusCode).toBe(401);
 const revoked = await issue();
 await app.inject({ method: 'DELETE', url: '/api/api-tokens/' + revoked.id, headers: { cookie } });
 expect((await request(revoked.token, 'GET', '/api/plans')).statusCode).toBe(401);
 expect((await app.inject({ url: '/api/textbooks', headers: { cookie, authorization: 'Bearer bad' } })).statusCode).toBe(401);
});
it('실제 SDK 원격 클라이언트가 초기화·도구 조회·호출·종료하고 읽기 키의 쓰기를 거부한다', async () => {
 const key = await issue();
 const client = new Client({ name: 'wb-test', version: '1.0.0' });
 await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + key.token } } }));
 try {
  const list = await client.listTools();
  expect(list.tools).toHaveLength(17);
  const read = await client.callTool({ name: 'list_textbooks', arguments: {} });
  expect(read.isError).toBe(false);
  const write = await client.callTool({ name: 'create_textbooks', arguments: { data: { title: '[가상] 차단' }, requestId: randomUUID(), confirm: true } });
  expect(write.isError).toBe(true);
  const content = write.content as { text: string }[];
  expect(JSON.parse(content[0].text).status).toBe(403);
 } finally { await client.close(); }
});
it('MCP는 쿠키 단독·외부 Origin을 거부한다', async () => {
 const key = await issue();
 expect((await app.inject({ method: 'POST', url: '/mcp', headers: { cookie }, payload: {} })).statusCode).toBe(401);
 expect((await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer ' + key.token, origin: 'https://untrusted.example' }, payload: {} })).statusCode).toBe(403);
 expect((await app.inject({ url: '/mcp' })).statusCode).toBe(405);
 expect((await app.inject({ method:'DELETE',url:'/mcp' })).statusCode).toBe(405);
 expect((await app.inject({ method:'POST',url:'/mcp',payload:{} })).headers['www-authenticate']).toBe('Bearer realm="WB Planner"');
});
it('한글 아이디는 NFC로 중복 검사하고 초기 비밀번호 변경 전 API·키 발급·MCP를 차단한다', async () => {
 const username = 'wb가상강사';
 const made = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username: username.normalize('NFD'), displayName: '[가상] 강사', password: 'initial-password', role: 'teacher' } });
 expect(made.statusCode).toBe(201);
 const duplicate = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie }, payload: { username, password: 'initial-password' } });
 expect(duplicate.statusCode).toBe(400);
 const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: username.normalize('NFD'), password: 'initial-password' } });
 expect(login.statusCode).toBe(200);
 expect(login.json().mustChangePassword).toBe(true);
 const headers = { cookie: 'wb_session=' + login.cookies[0].value };
 for (const url of ['/api/textbooks', '/api/plans', '/api/api-tokens']) expect((await app.inject({ url, headers })).statusCode).toBe(403);
 expect((await app.inject({ method: 'POST', url: '/api/api-tokens', headers, payload: { name: '우회', scope: 'write' } })).statusCode).toBe(403);
 expect((await app.inject({ method: 'POST', url: '/mcp', headers, payload: {} })).statusCode).toBe(403);
 expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'initial-password', newPassword: 'initial-password' } })).statusCode).toBe(400);
 expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'initial-password', newPassword: 'changed-password' } })).statusCode).toBe(200);
 expect((await app.inject({ url: '/api/textbooks', headers })).statusCode).toBe(200);
 expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'initial-password' } })).statusCode).toBe(401);
});

it('쓰기 요청 재시도는 한 번만 저장하며 같은 키의 다른 입력을 거부한다', async () => {
 const key = await issue('write');
 const headers = { authorization: 'Bearer ' + key.token, 'idempotency-key': 'replay-create-test' };
 const payload = { title: '[가상] 중복 방지', items: [], isSample: true };
 const first = await app.inject({ method: 'POST', url: '/api/textbooks', headers, payload });
 const second = await app.inject({ method: 'POST', url: '/api/textbooks', headers, payload });
 expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
 expect(second.json().id).toBe(first.json().id);
 expect(second.headers['idempotency-replayed']).toBe('true');
 expect((await app.inject({ method: 'POST', url: '/api/textbooks', headers, payload: { ...payload, title: '[가상] 다른 요청' } })).statusCode).toBe(409);
 const missing = await app.inject({ method: 'POST', url: '/api/textbooks', headers: { authorization: headers.authorization }, payload });
 expect(missing.statusCode).toBe(400);
 ctx.store.db.prepare('UPDATE api_requests SET status=0,response=? WHERE request_key=?').run('', 'replay-create-test');
 expect((await app.inject({ method:'POST',url:'/api/textbooks',headers,payload })).statusCode).toBe(409);
 expect(ctx.store.list<import('@wb/shared').Textbook>('textbook').filter(t=>t.title===payload.title)).toHaveLength(1);
});
it('재편성은 미리보기와 같은 입력·버전만 적용하고 진도·고정을 보존한다', async () => {
 const key = await issue('write');
 const planInput = { curriculumId: SAMPLE_IDS.curriculumParallel, settings: { startDate: '2026-04-06', endDate: '2026-04-30', weekdays: [1,4], minutesPerLesson:60, reviewMinutes:10, bufferMinutes:5, mode:'period', academicYearStartMonth:3, holidaySetIds:[], tracks:{review:0,advance:0,advanceWeekdays:null,currentMinMinutes:0} } };
 expect((await request(key.token, 'POST', '/api/plans', planInput)).statusCode).toBe(409);
 const planPreview = await request(key.token,'POST','/api/plans/preview',planInput);
 expect(planPreview.statusCode).toBe(200);
 const made = await request(key.token, 'POST', '/api/plans', { ...planInput, approvalId: planPreview.json().approvalId });
 expect(made.statusCode).toBe(201);
 let plan = made.json();
 const recorded = await request(key.token, 'POST', '/api/plans/'+plan.id+'/records', { assignmentId:plan.assignments[0].id,status:'done',version:plan.version,note:'[가상] 보존할 기록' });
 expect(recorded.statusCode).toBe(200);
 plan=(await request(key.token,'GET','/api/plans/'+plan.id)).json();
 const pinTarget=plan.assignments.find((a:{lessonId:string})=>a.lessonId!==plan.assignments[0].lessonId)!;
 const pin={op:'pin',params:{assignmentId:pinTarget.id,date:plan.lessons.find((l:{id:string})=>l.id===pinTarget.lessonId).date},version:plan.version};
 const pinPreview=await request(key.token,'POST','/api/plans/'+plan.id+'/ops',{...pin,dryRun:true});
 expect(pinPreview.statusCode).toBe(200);
 expect((await request(key.token,'POST','/api/plans/'+plan.id+'/ops',{...pin,approvalId:pinPreview.json().approvalId})).statusCode).toBe(200);
 plan=(await request(key.token,'GET','/api/plans/'+plan.id)).json();
 const path = '/api/plans/'+plan.id+'/ops';
 const input = { op:'cancel_lesson', params:{lessonId:plan.lessons[2].id,reason:'[가상] 휴강'},version:plan.version };
 expect((await request(key.token,'POST',path,input)).statusCode).toBe(409);
 const preview = await request(key.token,'POST',path,{...input,dryRun:true});
 expect(preview.statusCode).toBe(200); expect(preview.json().approvalId).toBeTruthy();
 const approvalId = preview.json().approvalId;
 expect((await request(key.token,'POST',path,{...input,params:{...input.params,reason:'입력 변경'},approvalId})).statusCode).toBe(409);
 const saved=await request(key.token,'POST',path,{...input,approvalId});
 expect(saved.statusCode).toBe(200);
 const current= (await request(key.token,'GET','/api/plans/'+plan.id)).json();
 expect(current.records).toEqual(plan.records);
 expect(current.assignments.find((a:{id:string})=>a.id===pinTarget.id)).toEqual(plan.assignments.find((a:{id:string})=>a.id===pinTarget.id));
 const views=(await request(key.token,'GET','/api/plans/'+plan.id+'/views')).json().views;
 expect(views.halfYears.reduce((s:number,h:{summary:{assignedMinutes:number}})=>s+h.summary.assignedMinutes,0)).toBe(views.summary.assignedMinutes);
 const readonly=await issue('read');
 expect((await request(readonly.token,'POST',path,{...input,version:current.version,dryRun:true})).statusCode).toBe(200);
});

it('지정된 짧은 초기값만 예외로 허용하고 변경·재설정 시 세션과 외부 키를 보호한다', async () => {
 const previous = process.env.WB_USER_INITIAL_PASSWORD;
 process.env.WB_USER_INITIAL_PASSWORD = '1357';
 try {
  const headers = { cookie };
  const make = await app.inject({ method:'POST',url:'/api/users',headers,payload:{username:'wb초기값강사',displayName:'[가상] 초기값 강사',role:'teacher',useInitialPassword:true} });
  expect(make.statusCode).toBe(201);
  const id=make.json().id;
  expect((await app.inject({method:'POST',url:'/api/users',headers,payload:{username:'wb짧은암호',password:'1234'}})).statusCode).toBe(400);
  const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wb초기값강사',password:'1357'}});
  expect(login.statusCode).toBe(200);
  const own={cookie:'wb_session='+login.cookies[0].value};
  expect((await app.inject({url:'/api/plans',headers:own})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/api/auth/password',headers:own,payload:{currentPassword:'1357',newPassword:'short'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/api/auth/password',headers:own,payload:{currentPassword:'1357',newPassword:'normal-password'}})).statusCode).toBe(200);
  const key = await app.inject({method:'POST',url:'/api/api-tokens',headers:own,payload:{name:'[가상] 강사 연결',scope:'read'}});
  expect(key.statusCode).toBe(201);
  expect((await app.inject({method:'PUT',url:'/api/users/'+id,headers,payload:{useInitialPassword:true}})).statusCode).toBe(200);
  expect((await request(key.json().token,'GET','/api/plans')).statusCode).toBe(401);
  expect((await app.inject({url:'/api/auth/me',headers:own})).json()).toBeNull();
  const again=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wb초기값강사',password:'1357'}});
  expect(again.json().mustChangePassword).toBe(true);
  expect((await app.inject({method:'PUT',url:'/api/users/'+id,headers,payload:{username:'wb초기값강사2'}})).json().id).toBe(id);
 } finally { if(previous===undefined) delete process.env.WB_USER_INITIAL_PASSWORD; else process.env.WB_USER_INITIAL_PASSWORD=previous; }
});
it('실제 MCP 쓰기 클라이언트의 재시도와 강사 범위 제한을 동일하게 처리한다', async()=>{
 const key=await issue('write');
 const client=new Client({name:'wb-write-test',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+key.token}}}));
 try {
  const args={data:{title:'[가상] MCP 교재',items:[],isSample:true},confirm:true,requestId:'mcp-create-retry'};
  const first=await client.callTool({name:'create_textbooks',arguments:args});
  const second=await client.callTool({name:'create_textbooks',arguments:args});
  expect(first.isError).toBe(false);expect(second.isError).toBe(false);
  const parse=(r:typeof first)=>JSON.parse((r.content as {text:string}[])[0].text);
  expect(parse(first).data.id).toBe(parse(second).data.id);
  const book=parse(first).data;
  const stale=await client.callTool({name:'update_textbooks',arguments:{id:book.id,data:{...book,version:book.version+1},confirm:true,requestId:'mcp-stale-version'}});
  expect(parse(stale).status).toBe(409);
 } finally {await client.close();}
 ctx.store.insertUser({id:'outsider',username:'outsider',displayName:'[가상] 다른 강사',role:'teacher',passwordHash:hashPassword('test-password'),createdAt:ctx.now()});
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'outsider',password:'test-password'}});
 const own={cookie:'wb_session='+login.cookies[0].value};
 const outsiderKey=(await app.inject({method:'POST',url:'/api/api-tokens',headers:own,payload:{name:'[가상] 다른 강사',scope:'write'}})).json().token;
 const plan=ctx.store.list<Plan>('plan')[0];
 expect((await request(outsiderKey,'GET','/api/plans/'+plan.id)).statusCode).toBe(403);
 expect((await request(outsiderKey,'GET','/api/plans')).json()).toEqual([]);
 expect((await request(outsiderKey,'POST','/api/plans/'+plan.id+'/records',{assignmentId:plan.assignments[0].id,status:'done',version:plan.version})).statusCode).toBe(403);
});
it('반년 엑셀의 범위·시간이 같은 집계와 일치하고 학생용에는 내부 열·기록 메모가 없다',async()=>{
 const plan=ctx.store.list<Plan>('plan')[0];
 const {buildPlanViews}=await import('@wb/shared');
 const views=buildPlanViews(plan);
 const ExcelJS=(await import('exceljs')).default;
 for(const audience of ['teacher','student']){
  const response=await app.inject({url:'/api/plans/'+plan.id+'/export.xlsx?levels=year,halfyear,quarter,month,week,day&audience='+audience,headers:{cookie}});
  expect(response.statusCode).toBe(200);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(response.rawPayload as never);
  expect(wb.worksheets.map(s=>s.name)).toEqual(['표지','연간','반년','분기','월간','주간','일간']);
  const sheet=wb.getWorksheet('반년')!;
  expect(sheet.rowCount).toBe(views.halfYears.length+1);
  for(let i=0;i<views.halfYears.length;i++) expect(sheet.getRow(i+2).getCell(2).value).toBe(views.halfYears[i].from+' ~ '+views.halfYears[i].to);
  if(audience==='student'){
   expect(sheet.getRow(1).values).not.toContain('총 수업시간');
   expect(JSON.stringify(wb.model)).not.toContain('[가상] 보존할 기록');
  }
 }
});
it('과정 버전이 바뀌면 오래된 계획 미리보기로 생성할 수 없다',async()=>{
 const key=await issue('write');
 const input={curriculumId:SAMPLE_IDS.curriculumParallel,settings:{startDate:'2026-04-06',endDate:'2026-04-30',weekdays:[1,4],minutesPerLesson:60,reviewMinutes:10,bufferMinutes:5,mode:'period',academicYearStartMonth:3,holidaySetIds:[],tracks:{review:0,advance:0,advanceWeekdays:null,currentMinMinutes:0}}};
 const preview=await request(key.token,'POST','/api/plans/preview',input);
 expect(preview.statusCode).toBe(200);
 const course=ctx.store.mustGet<import('@wb/shared').Curriculum>('curriculum',input.curriculumId);
 ctx.store.update('curriculum',{...course,title:'[가상] 변경된 과정'},course.version);
 const before=ctx.store.list<Plan>('plan').length;
 expect((await request(key.token,'POST','/api/plans',{...input,approvalId:preview.json().approvalId})).statusCode).toBe(409);
 expect(ctx.store.list<Plan>('plan')).toHaveLength(before);
});
