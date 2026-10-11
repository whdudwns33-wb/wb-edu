import { buildApp } from './app.ts';
import { resolveDbPath, resolveStaticDir } from './paths.ts';
import { seedAdmin } from './seed.ts';

const port = Number(process.env.PORT ?? 3987);
const host = process.env.HOST ?? '127.0.0.1';
const dbPath = resolveDbPath();

const { app, ctx } = await buildApp({ dbPath, staticDir: resolveStaticDir(), logger: process.env.WB_LOG !== '0' });
const admin = seedAdmin(ctx);
if (admin.created) app.log.warn(`초기 관리자 계정을 만들었습니다: ${admin.username} (비밀번호를 곧바로 바꾸세요)`);

await app.listen({ port, host });
app.log.info(`WB 커리큘럼 플래너 서버: http://${host}:${port}  (DB: ${dbPath}, 모드: ${process.env.WB_MODE === 'prod' ? '운영' : '데모/개발'})`);
