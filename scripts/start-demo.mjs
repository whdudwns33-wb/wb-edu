#!/usr/bin/env node
/**
 * 개발·데모 서버 (npm run start:demo).
 * 학원 PC 처럼 운영 서버가 3987 포트를 쓰는 PC에서도 함께 띄울 수 있게 기본 포트를 3988 로 둔다.
 * 데모 DB(server/data/wb-edu.demo.sqlite)만 쓰며 운영 DB·.env.prod 는 읽지 않는다.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, TSX_CLI } from './prod-env.mjs';

const env = { ...process.env, PORT: process.env.PORT ?? '3988' };
delete env.WB_MODE;
delete env.WB_DB_PATH;
const child = spawn(process.execPath, [TSX_CLI, join(ROOT, 'server', 'src', 'index.ts')], { cwd: join(ROOT, 'server'), env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
