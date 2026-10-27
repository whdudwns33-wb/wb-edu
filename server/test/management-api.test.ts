import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
const {app,ctx}=await buildApp({dbPath:':memory:'});
const savedInitial=process.env.WB_USER_INITIAL_PASSWORD;
let origin='';const cookies:Record<string,string>={};
beforeAll(async()=>{
 process.env.WB_USER_INITIAL_PASSWORD='qa-initial-value';
 for(const [id,username,role] of [['owner','qaowner','owner'],['manager','qamanager','admin'],['teacher','wb가상강사','teacher']] as const){ctx.store.insertUser({id,username,role,displayName:'[가상] '+id,passwordHash:hashPassword('qa-login-value'),createdAt:ctx.now()});const r=await app.inject({method:'POST',url:'/api/auth/login',payload:{username,password:'qa-login-value'}});cookies[id]='wb_session='+r.cookies[0].value;}
 origin=await app.listen({host:'127.0.0.1',port:0});
});
afterAll(async()=>{await app.close();if(savedInitial===undefined)delete process.env.WB_USER_INITIAL_PASSWORD;else process.env.WB_USER_INITIAL_PASSWORD=savedInitial;});
async function issue(scope='manage',who='manager'){const r=await app.inject({method:'POST',url:'/api/api-tokens',headers:{cookie:cookies[who]},payload:{name:'[가상] 운영 관리 검사',scope}});return {status:r.statusCode,...r.json()};}
async function send(token:string,url:string,method:'GET'|'POST'|'PUT'='GET',payload?:object,key:string=randomUUID()){const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+token,'idempotency-key':key}});return {status:r.statusCode,data:r.json(),body:r.body};}
it('기존 read/write 키는 관리 범위로 확대되지 않고 강사는 manage 키를 발급할 수 없다',async()=>{
 for(const scope of ['read','write']){const k=await issue(scope);for(const p of ['/api/users','/api/settings','/api/holiday-sets','/api/templates','/api/objectives'])expect((await send(k.token,p)).status).toBe(403);}
 expect((await issue('manage','teacher')).status).toBe(403);
});
it('운영 관리 키는 기본 업무를 포함하고 임의 경로·키 재발급·SQL·명령 실행을 허용하지 않는다',async()=>{
 const k=await issue();expect((await send(k.token,'/api/textbooks')).status).toBe(200);
 for(const p of ['/api/api-tokens','/api/auth/me','/api/sql','/api/exec'])expect((await send(k.token,p)).status).toBe(403);
});
it('사용자 등록·수정·중복 방지·동시 수정 차단과 비밀번호 비노출',async()=>{
 const k=await issue();const payload={username:'wb관리검사',displayName:'[가상] 관리 검사',role:'teacher',useInitialPassword:true};const requestId=randomUUID();const a=await send(k.token,'/api/users','POST',payload,requestId);expect(a.status).toBe(201);expect(a.body).not.toMatch(/passwordHash|qa-initial-value/);expect(a.data.mustChangePassword).toBe(true);expect((await send(k.token,'/api/users','POST',payload,requestId)).data.id).toBe(a.data.id);
 const edited=await send(k.token,'/api/users/'+a.data.id,'PUT',{displayName:'[가상] 새 이름',expectRevision:a.data.revision});expect(edited.status).toBe(200);expect(edited.data.revision).not.toBe(a.data.revision);
 expect((await send(k.token,'/api/users/'+a.data.id,'PUT',{displayName:'[가상] 충돌',expectRevision:a.data.revision})).status).toBe(409);
 expect((await send(k.token,'/api/users','POST',{...payload,username:'wb직접암호',password:'qa-direct-value'})).status).toBe(400);
});
it('관리자 키는 원장 변경·승격 불가, 원장도 마지막 원장과 자기 권한을 보호한다',async()=>{
 const k=await issue();const users=(await send(k.token,'/api/users')).data;const owner=users.find((u:{id:string})=>u.id==='owner');
 expect((await send(k.token,'/api/users/owner','PUT',{displayName:'[가상] 거절',expectRevision:owner.revision})).status).toBe(403);
 expect((await send(k.token,'/api/users','POST',{username:'qafakeowner',role:'owner',useInitialPassword:true})).status).toBe(403);
 const own=await issue('manage','owner');expect((await send(own.token,'/api/users/owner','PUT',{active:false,expectRevision:owner.revision})).status).toBe(400);
});
it('휴일·설정·양식·학습목표 수정에 현재 version과 중복 방지 키를 적용한다',async()=>{
 const k=await issue();const hs=await send(k.token,'/api/holiday-sets','POST',{year:2028,name:'[가상] 휴일'});expect(hs.status).toBe(201);expect((await send(k.token,'/api/holiday-sets/'+hs.data.id,'PUT',{...hs.data,holidays:[{date:'2028-01-01',name:'[가상] 휴일'}]})).status).toBe(200);
 expect((await send(k.token,'/api/holiday-sets/'+hs.data.id,'PUT',hs.data)).status).toBe(409);
 const settings=(await send(k.token,'/api/settings')).data;expect((await send(k.token,'/api/settings','PUT',{...settings,organizationName:'[가상] 기관'})).status).toBe(200);
 const tpl=await send(k.token,'/api/templates','POST',{name:'[가상] 출력',audience:'student',columns:['date']});expect(tpl.status).toBe(201);expect((await send(k.token,'/api/templates/'+tpl.data.id,'PUT',{...tpl.data,name:'[가상] 수정'})).status).toBe(200);
 const obj=await send(k.token,'/api/objectives','POST',{code:'QA1',title:'[가상] 목표'});expect(obj.status).toBe(201);expect((await send(k.token,'/api/objectives/'+obj.data.id,'PUT',{...obj.data,title:'[가상] 목표 수정'})).status).toBe(200);
});
it('운영 관리 초기화는 지정 초기값만 쓰고 대상의 기존 세션·키를 폐기한다',async()=>{
 const k=await issue();const teacherKey=await issue('write','teacher');const target=(await send(k.token,'/api/users')).data.find((u:{id:string})=>u.id==='teacher');
 const reset=await send(k.token,'/api/users/teacher','PUT',{expectRevision:target.revision,useInitialPassword:true});expect(reset.status).toBe(200);expect(reset.data.mustChangePassword).toBe(true);expect(reset.body).not.toContain('qa-initial-value');
 expect((await send(teacherKey.token,'/api/textbooks')).status).toBe(401);expect((await app.inject({url:'/api/auth/me',headers:{cookie:cookies.teacher}})).json()).toBeNull();
 const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'wb가상강사',password:'qa-initial-value'}});expect(login.statusCode).toBe(200);expect(login.json().mustChangePassword).toBe(true);
});
it('실제 MCP 32개 도구와 운영 관리 호출, 역할 축소 후 재시도 차단',async()=>{
 const k=await issue();const client=new Client({name:'wb-manage-test',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+k.token}}}));
 try{expect((await client.listTools()).tools).toHaveLength(32);const parse=(r:Awaited<ReturnType<typeof client.callTool>>)=>JSON.parse((r.content as {text:string}[])[0].text);expect(parse(await client.callTool({name:'get_settings',arguments:{}})).status).toBe(200);const a=await client.callTool({name:'create_holiday_sets',arguments:{data:{year:2029,name:'[가상] MCP 휴일'},requestId:'manage-mcp-create',confirm:true}});expect(parse(a).status).toBe(201);const hs=parse(a).data;expect(parse(await client.callTool({name:'update_holiday_sets',arguments:{id:hs.id,data:{...hs,name:'[가상] MCP 수정'},requestId:'manage-mcp-update',confirm:true}})).status).toBe(200);
 const replay=await send(k.token,'/api/templates','POST',{name:'[가상] 권한 재검사'},'manage-downgrade');expect(replay.status).toBe(201);ctx.store.updateUser('manager',{role:'teacher'});expect((await send(k.token,'/api/templates','POST',{name:'[가상] 권한 재검사'},'manage-downgrade')).status).toBe(403);
 }finally{ctx.store.updateUser('manager',{role:'admin'});await client.close();}
});
