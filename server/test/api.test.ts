import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { seedAdmin, seedDemoTeacher, seedSamples } from '../src/seed.ts';
import { resetLoginLimiter } from '../src/routes/users.ts';
import { SAMPLE_IDS } from '@wb/shared';

let app: FastifyInstance;
let adminCookie = '';
let teacherCookie = '';

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'wb_session')!;
  return `${cookie.name}=${cookie.value}`;
}

const settings = {
  startDate: '2026-04-06',
  endDate: '2026-04-30',
  weekdays: [1, 4],
  minutesPerLesson: 60,
  reviewMinutes: 10,
  bufferMinutes: 5,
  mode: 'period',
  academicYearStartMonth: 3,
  holidaySetIds: [],
  tracks: { review: 0, advance: 0, advanceWeekdays: null, currentMinMinutes: 0 },
};

beforeAll(async () => {
  const built = await buildApp({ dbPath: ':memory:' });
  app = built.app;
  seedAdmin(built.ctx, 'admin', 'admin1234');
  seedDemoTeacher(built.ctx);
  seedSamples(built.ctx);
  await app.ready();
  adminCookie = await login('admin', 'admin1234');
  teacherCookie = await login('teacher', 'teacher1234');
});

afterAll(async () => {
  await app.close();
});

const asAdmin = (opts: Record<string, unknown>) => app.inject({ ...opts, headers: { cookie: adminCookie } } as never);
const asTeacher = (opts: Record<string, unknown>) => app.inject({ ...opts, headers: { cookie: teacherCookie } } as never);

describe('인증·권한', () => {
  it('로그인 없이 API 접근 시 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/textbooks' });
    expect(res.statusCode).toBe(401);
  });

  it('잘못된 비밀번호는 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
  });

  it('강사는 교재를 수정할 수 없다 (403)', async () => {
    const res = await asTeacher({ method: 'POST', url: '/api/textbooks', payload: { title: 'x', items: [] } });
    expect(res.statusCode).toBe(403);
  });

  it('강사는 교재·과정을 조회할 수 있다', async () => {
    const res = await asTeacher({ method: 'GET', url: '/api/curricula' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(4);
  });
});

describe('교재 보관함', () => {
  let tbId = '';
  let version = 0;

  it('교재 등록·조회', async () => {
    const res = await asAdmin({
      method: 'POST',
      url: '/api/textbooks',
      payload: {
        kind: 'inhouse',
        title: '테스트 교재',
        subject: '수학',
        schoolLevel: '초',
        edition: 'v1',
        items: [
          { title: '1. 분수', unit: '1단원', order: 1, progressUnit: 'page', range: { from: 12, to: 23 }, minutes: 30, splittable: true },
          { title: '2. 소수', unit: '1단원', order: 2, progressUnit: 'page', range: { from: 24, to: 35 }, minutes: 30, splittable: true },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const tb = res.json();
    tbId = tb.id;
    version = tb.version;
    expect(tb.items).toHaveLength(2);
    const get = await asAdmin({ method: 'GET', url: `/api/textbooks/${tbId}` });
    expect(get.json().title).toBe('테스트 교재');
  });

  it('범위 오류·시간 누락은 400', async () => {
    const res = await asAdmin({ method: 'POST', url: '/api/textbooks', payload: { title: 'bad', items: [{ title: 'x', progressUnit: 'page', range: { from: 10, to: 5 }, minutes: 10 }] } });
    expect(res.statusCode).toBe(400);
    const res2 = await asAdmin({ method: 'POST', url: '/api/textbooks', payload: { title: 'bad', items: [{ title: 'x', progressUnit: 'activity', minutes: 0 }] } });
    expect(res2.statusCode).toBe(400);
  });

  it('동시 수정 충돌은 409', async () => {
    const get = await asAdmin({ method: 'GET', url: `/api/textbooks/${tbId}` });
    const doc = get.json();
    const ok = await asAdmin({ method: 'PUT', url: `/api/textbooks/${tbId}`, payload: { ...doc, title: '수정 1' } });
    expect(ok.statusCode).toBe(200);
    const stale = await asAdmin({ method: 'PUT', url: `/api/textbooks/${tbId}`, payload: { ...doc, title: '수정 2 (stale)' } });
    expect(stale.statusCode).toBe(409);
    const latest = await asAdmin({ method: 'GET', url: `/api/textbooks/${tbId}` });
    expect(latest.json().title).toBe('수정 1');
    expect(latest.json().version).toBe(version + 1);
  });

  it('붙여넣기 미리보기', async () => {
    const res = await asAdmin({ method: 'POST', url: '/api/textbooks/import-preview', payload: { text: '대단원\t제목\t단위\t시작\t끝\t시간\n1단원\t분수\t쪽\t12\t23\t30' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].range).toEqual({ from: 12, to: 23 });
  });

  it('교재 복제·보관', async () => {
    const clone = await asAdmin({ method: 'POST', url: `/api/textbooks/${tbId}/clone` });
    expect(clone.statusCode).toBe(201);
    expect(clone.json().title).toContain('복제');
    const arch = await asAdmin({ method: 'POST', url: `/api/textbooks/${clone.json().id}/archive`, payload: { archived: true } });
    expect(arch.statusCode).toBe(200);
    const list = await asAdmin({ method: 'GET', url: '/api/textbooks' });
    expect(list.json().some((t: { id: string }) => t.id === clone.json().id)).toBe(false);
    const all = await asAdmin({ method: 'GET', url: '/api/textbooks?archived=1' });
    expect(all.json().some((t: { id: string }) => t.id === clone.json().id)).toBe(true);
  });
});

describe('표준과정', () => {
  it('자동 구성 → 저장 → 복제', async () => {
    const auto = await asAdmin({
      method: 'POST',
      url: '/api/curricula/auto-assemble',
      payload: { textbooks: [{ textbookId: SAMPLE_IDS.marketTextbook, role: 'main' }, { textbookId: SAMPLE_IDS.inhouseTextbook, role: 'sub' }], compositionMode: 'parallel', minutesPerSession: 60, reviewMinutes: 10, bufferMinutes: 5 },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().sessions).toHaveLength(8);
    const create = await asAdmin({ method: 'POST', url: '/api/curricula', payload: { title: 'API 병행안', ...(auto.json() as object), compositionMode: 'parallel', target: '초5' } });
    expect(create.statusCode).toBe(201);
    const c = create.json();
    expect(c.curriculumVersion).toBe(1);
    const clone = await asAdmin({ method: 'POST', url: `/api/curricula/${c.id}/clone` });
    expect(clone.statusCode).toBe(201);
    expect(clone.json().reviewComments).toHaveLength(0);
  });

  it('검증된 과정의 구조를 바꾸면 과정 버전이 오르고 초안으로 돌아간다', async () => {
    const get = await asAdmin({ method: 'GET', url: `/api/curricula/${SAMPLE_IDS.curriculumBasic}` });
    const c = get.json();
    const pub = await asAdmin({ method: 'POST', url: `/api/curricula/${c.id}/publish` });
    expect(pub.json().status).toBe('verified');
    expect(pub.json().curriculumVersion).toBe(2);
    const edited = pub.json();
    edited.sessions = edited.sessions.slice(0, 2);
    const put = await asAdmin({ method: 'PUT', url: `/api/curricula/${c.id}`, payload: edited });
    expect(put.statusCode).toBe(200);
    expect(put.json().curriculumVersion).toBe(3);
    expect(put.json().status).toBe('draft');
  });
});

describe('실행 계획', () => {
  let planId = '';
  let version = 0;

  it('계획 만들기 → 저장 → 재조회 (시나리오 13)', async () => {
    const res = await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, title: '테스트 계획', settings } });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    planId = p.id;
    version = p.version;
    expect(p.lessons).toHaveLength(8);
    expect(p.unassigned).toHaveLength(0);
    expect(p.snapshot.textbooks).toHaveLength(2);
    const again = await asTeacher({ method: 'GET', url: `/api/plans/${planId}` });
    expect(again.statusCode).toBe(200);
    expect(again.json().assignments).toHaveLength(p.assignments.length);
    expect(again.json().assignments.filter((a: { activity: string }) => a.activity !== 'homework').reduce((s: number, a: { minutes: number }) => s + a.minutes, 0)).toBe(360);
  });

  it('다른 강사의 계획은 관리자만 볼 수 있다', async () => {
    const res = await asAdmin({ method: 'GET', url: `/api/plans/${planId}` });
    expect(res.statusCode).toBe(200);
  });

  it('미리보기 비교(dryRun) 후 수업 취소 → 45분 부족', async () => {
    const get = await asTeacher({ method: 'GET', url: `/api/plans/${planId}` });
    const p = get.json();
    const lesson = p.lessons.find((l: { date: string }) => l.date === '2026-04-20');
    const dry = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/ops`, payload: { op: 'cancel_lesson', params: { lessonId: lesson.id, reason: '휴강' }, dryRun: true } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().diff.unassignedMinutesAfter).toBe(45);
    // dryRun 은 저장하지 않음
    const still = await asTeacher({ method: 'GET', url: `/api/plans/${planId}` });
    expect(still.json().unassigned).toHaveLength(0);
    const real = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/ops`, payload: { op: 'cancel_lesson', params: { lessonId: lesson.id, reason: '휴강' }, version: p.version } });
    expect(real.statusCode).toBe(200);
    expect(real.json().unassigned.reduce((s: number, u: { minutes: number }) => s + u.minutes, 0)).toBe(45);
    expect(real.json().blockers.length).toBeGreaterThan(0);
    version = real.json().version;
  });

  it('미배정이 있으면 확정이 막힌다 → 보강 추가 후 확정', async () => {
    const fail = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/confirm`, payload: { version } });
    expect(fail.statusCode).toBe(400);
    const makeup = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/ops`, payload: { op: 'add_makeup', params: { date: '2026-04-22', note: '보강' }, version } });
    expect(makeup.statusCode).toBe(200);
    expect(makeup.json().unassigned).toHaveLength(0);
    version = makeup.json().version;
    const ok = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/confirm`, payload: { version } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('confirmed');
    version = ok.json().version;
  });

  it('교재·과정 개정 후에도 확정 계획은 유지된다 (시나리오 11)', async () => {
    const tb = (await asAdmin({ method: 'GET', url: `/api/textbooks/${SAMPLE_IDS.marketTextbook}` })).json();
    tb.items[0].title = '개정된 제목';
    tb.items[0].range = { from: 1, to: 3 };
    tb.edition = '2027년 개정판';
    const put = await asAdmin({ method: 'PUT', url: `/api/textbooks/${SAMPLE_IDS.marketTextbook}`, payload: tb });
    expect(put.statusCode).toBe(200);
    const plan = (await asTeacher({ method: 'GET', url: `/api/plans/${planId}` })).json();
    const snapItem = plan.snapshot.textbooks.find((t: { id: string }) => t.id === SAMPLE_IDS.marketTextbook).items[0];
    expect(snapItem.title).not.toBe('개정된 제목');
    expect(snapItem.range).toEqual({ from: 12, to: 23 });
    expect(plan.snapshot.textbooks.find((t: { id: string }) => t.id === SAMPLE_IDS.marketTextbook).edition).toBe('2026년 개정판 (가상)');
    const refresh = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/refresh-snapshot` });
    expect(refresh.statusCode).toBe(400); // 확정 계획은 스냅샷 갱신 불가
  });

  it('진도 기록 → 남은 범위 → 이어서 진행', async () => {
    const plan = (await asTeacher({ method: 'GET', url: `/api/plans/${planId}` })).json();
    const a = plan.assignments.find((x: { textbookId: string; lessonId: string }) => x.textbookId === SAMPLE_IDS.marketTextbook && x.lessonId === plan.lessons[0].id);
    const rec = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/records`, payload: { assignmentId: a.id, status: 'partial', completedPortion: { from: 12, to: 17 }, version: plan.version } });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().remaining.portion).toEqual({ from: 18, to: 23 });
    const cont = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/ops`, payload: { op: 'continue', params: { assignmentId: a.id }, version: rec.json().version } });
    expect(cont.statusCode).toBe(200);
    const c = cont.json().assignments.find((x: { continuedFrom?: string }) => x.continuedFrom === a.id);
    expect(c.portion).toEqual({ from: 18, to: 23 });
    version = cont.json().version;
    // 기록은 보존
    expect(cont.json().records).toHaveLength(1);
  });

  it('보기 집계와 엑셀 출력이 같은 원본을 쓴다', async () => {
    const v = await asTeacher({ method: 'GET', url: `/api/plans/${planId}/views` });
    expect(v.statusCode).toBe(200);
    expect(v.json().views.header.planVersion).toBeGreaterThan(1);
    expect(v.json().textbookProgress).toHaveLength(2);
    const x = await asTeacher({ method: 'GET', url: `/api/plans/${planId}/export.xlsx?audience=teacher` });
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.rawPayload.length).toBeGreaterThan(5000);
    const s = await asTeacher({ method: 'GET', url: `/api/plans/${planId}/export.xlsx?audience=student&levels=week,day` });
    expect(s.statusCode).toBe(200);
  });

  it('출력 양식의 열 선택이 엑셀에 적용되고 학생용은 내부 열을 제외한다', async () => {
    const tpls = (await asAdmin({ method: 'GET', url: '/api/templates' })).json() as Array<{ id: string; audience: string; version: number; columns: string[] }>;
    const student = tpls.find((t) => t.audience === 'student')!;
    // 학생용 양식에 내부 열(지도 메모)을 넣어도 저장은 되지만 출력에서는 제외된다
    const put = await asAdmin({ method: 'PUT', url: `/api/templates/${student.id}`, payload: { ...student, columns: ['date', 'range', 'teachingNote', 'bogus'] } });
    expect(put.statusCode).toBe(200);
    expect(put.json().columns).toEqual(['date', 'range', 'teachingNote']); // 정의되지 않은 키 제거
    const x = await asTeacher({ method: 'GET', url: `/api/plans/${planId}/export.xlsx?template=${student.id}&levels=day` });
    expect(x.statusCode).toBe(200);
    expect(decodeURIComponent(String(x.headers['content-disposition']))).toContain('학생용');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as never);
    const day = wb.getWorksheet('일간')!;
    expect(day.getRow(1).values).toEqual([undefined, '날짜', '범위']);
    const bad = await asTeacher({ method: 'GET', url: `/api/plans/${planId}/export.xlsx?template=no-such` });
    expect(bad.statusCode).toBe(400);
  });

  it('학습목표 지도와 오늘 수업', async () => {
    const o = await asTeacher({ method: 'GET', url: `/api/plans/${planId}/objectives` });
    expect(o.statusCode).toBe(200);
    expect(o.json().statuses.length).toBeGreaterThan(0);
    const t = await asTeacher({ method: 'GET', url: '/api/today?date=2026-04-09' });
    expect(t.json().lessons.some((l: { planId: string }) => l.planId === planId)).toBe(true);
  });

  it('복제 시 학생정보·완료 기록이 따라오지 않는다 (시나리오 12)', async () => {
    const plan = (await asTeacher({ method: 'GET', url: `/api/plans/${planId}` })).json();
    const put = await asTeacher({ method: 'PUT', url: `/api/plans/${planId}`, payload: { version: plan.version, classOrStudentRef: '홍길동(가상)', target: '초5 A반' } });
    expect(put.statusCode).toBe(200);
    const clone = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/clone` });
    expect(clone.statusCode).toBe(201);
    const c = clone.json();
    expect(c.records).toHaveLength(0);
    expect(c.classOrStudentRef).toBe('');
    expect(c.target).toBe('');
    expect(c.status).toBe('draft');
    expect(c.assignments.length).toBe(plan.assignments.length);
  });

  it('되돌리기는 이후 기록이 있으면 거부한다', async () => {
    const plan = (await asTeacher({ method: 'GET', url: `/api/plans/${planId}` })).json();
    const cancelEntry = plan.history.find((h: { action: string }) => h.action === 'cancel_lesson');
    const res = await asTeacher({ method: 'POST', url: `/api/plans/${planId}/ops`, payload: { op: 'undo', params: { historyId: cancelEntry.id }, version: plan.version } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('기록');
  });

  it('속도 우선 계획은 완료 예정일을 돌려준다', async () => {
    const res = await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings: { ...settings, endDate: '', mode: 'pace' } } });
    expect(res.statusCode).toBe(201);
    expect(res.json().endDateComputed).toBeTruthy();
  });

  it('입력 검증: 요일 없음 → 400', async () => {
    const res = await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings: { ...settings, weekdays: [] } } });
    expect(res.statusCode).toBe(400);
  });
});

describe('선행 보충 제안과 기초 확인 (시나리오 10)', () => {
  it('제안 → 관리자가 보충 과정 초안 생성(강사는 403) → 기초 확인 전 확정 불가 → 확인 후 확정', async () => {
    const created = await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumAdvance, settings: { ...settings, endDate: '2026-05-31' } } });
    expect(created.statusCode).toBe(201);
    let plan = created.json();
    expect(plan.snapshot.advance.requiredObjectiveIds).toEqual(['sample-obj-RD-5-01']);
    const sug = await asTeacher({ method: 'GET', url: `/api/plans/${plan.id}/supplement` });
    expect(sug.statusCode).toBe(200);
    const s = sug.json();
    expect(s.objectives.map((o: { objective: { code: string } }) => o.objective.code)).toEqual(['RD-5-01']);
    expect(s.items.length).toBeGreaterThan(0);
    const picks = s.items.map((i: { textbookId: string; itemId: string }) => ({ textbookId: i.textbookId, itemId: i.itemId }));
    // 강사는 표준과정을 만들 수 없다
    expect((await asTeacher({ method: 'POST', url: `/api/plans/${plan.id}/supplement-curriculum`, payload: { items: picks } })).statusCode).toBe(403);
    const draft = await asAdmin({ method: 'POST', url: `/api/plans/${plan.id}/supplement-curriculum`, payload: { items: picks } });
    expect(draft.statusCode).toBe(201);
    const c = draft.json();
    expect(c.status).toBe('draft');
    expect(c.title).toContain('[보충 제안]');
    expect(c.sessions.flatMap((x: { entries: Array<{ track: string }> }) => x.entries).every((e: { track: string }) => e.track === 'review')).toBe(true);
    // 없는 항목은 400
    expect((await asAdmin({ method: 'POST', url: `/api/plans/${plan.id}/supplement-curriculum`, payload: { items: [{ textbookId: SAMPLE_IDS.marketTextbook, itemId: 'nope' }] } })).statusCode).toBe(400);

    // 선행 계획: 미배정이 없더라도 기초 확인 전에는 확정 불가
    expect(plan.blockers.some((b: string) => b.includes('기초 확인'))).toBe(true);
    // 근거 없이 확인하면 400
    expect((await asTeacher({ method: 'POST', url: `/api/plans/${plan.id}/advance-confirm`, payload: { confirmed: true, note: '', version: plan.version } })).statusCode).toBe(400);
    const ok = await asTeacher({ method: 'POST', url: `/api/plans/${plan.id}/advance-confirm`, payload: { confirmed: true, note: '진단평가 90점', version: plan.version } });
    expect(ok.statusCode).toBe(200);
    plan = ok.json();
    expect(plan.snapshot.advance.prerequisitesConfirmed).toBe(true);
    expect(plan.snapshot.advance.prerequisitesConfirmedBy).toBe('샘플 강사');
    expect(plan.blockers.some((b: string) => b.includes('기초 확인'))).toBe(false);
    expect(plan.history.at(-1).description).toContain('진단평가 90점');
    // 과정 원본의 선행 확인 상태는 바뀌지 않는다
    const cur = (await asAdmin({ method: 'GET', url: `/api/curricula/${SAMPLE_IDS.curriculumAdvance}` })).json();
    expect(cur.advance.prerequisitesConfirmed).toBe(false);
  });
});

describe('동시 편집 알림용 버전 조회', () => {
  it('교재 버전과 마지막 수정자를 돌려주고, 수정되면 버전이 오른다', async () => {
    const v1 = (await asTeacher({ method: 'GET', url: `/api/versions/textbook/${SAMPLE_IDS.inhouseTextbook}` })).json();
    expect(v1.version).toBeGreaterThanOrEqual(1);
    const tb = (await asAdmin({ method: 'GET', url: `/api/textbooks/${SAMPLE_IDS.inhouseTextbook}` })).json();
    await asAdmin({ method: 'PUT', url: `/api/textbooks/${SAMPLE_IDS.inhouseTextbook}`, payload: { ...tb, usageNote: tb.usageNote + '!' } });
    const v2 = (await asTeacher({ method: 'GET', url: `/api/versions/textbook/${SAMPLE_IDS.inhouseTextbook}` })).json();
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.updatedByName).toBe('관리자');
  });

  it('지원하지 않는 종류는 400, 접근 권한 없는 계획은 403', async () => {
    expect((await asTeacher({ method: 'GET', url: '/api/versions/user/x' })).statusCode).toBe(400);
    const p = (await asAdmin({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings } })).json();
    expect((await asTeacher({ method: 'GET', url: `/api/versions/plan/${p.id}` })).statusCode).toBe(403);
    expect((await asAdmin({ method: 'GET', url: `/api/versions/plan/${p.id}` })).statusCode).toBe(200);
  });
});

describe('보안·실제 소요시간', () => {
  it('같은 IP·아이디로 10회 실패하면 429로 잠기고, 다른 아이디는 영향받지 않는다', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'locktest', password: 'x' } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'locktest', password: 'x' } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toContain('잠겼습니다');
    const other = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'teacher', password: 'teacher1234' } });
    expect(other.statusCode).toBe(200);
    resetLoginLimiter();
  });

  it('완료 기록의 실제 분이 저장되고 교재 개선 제안에 집계된다', async () => {
    const res = await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings } });
    expect(res.statusCode).toBe(201);
    let plan = res.json();
    const a = plan.assignments.find((x: { textbookId: string; activity: string }) => x.textbookId === SAMPLE_IDS.marketTextbook && x.activity === 'new');
    const rec = await asTeacher({ method: 'POST', url: `/api/plans/${plan.id}/records`, payload: { assignmentId: a.id, status: 'done', actualMinutes: 50, version: plan.version } });
    expect(rec.statusCode).toBe(200);
    plan = rec.json();
    expect(plan.records.at(-1).actualMinutes).toBe(50);
    const bad = await asTeacher({ method: 'POST', url: `/api/plans/${plan.id}/records`, payload: { assignmentId: a.id, status: 'done', actualMinutes: 9999, version: plan.version } });
    expect(bad.json().records.at(-1).actualMinutes).toBeUndefined(); // 범위 밖 값은 무시
    const sug = await asTeacher({ method: 'GET', url: `/api/textbooks/${SAMPLE_IDS.marketTextbook}/time-suggestions` });
    expect(sug.statusCode).toBe(200);
    const s = sug.json().suggestions.find((x: { itemId: string }) => x.itemId === a.itemId);
    expect(s.samples.length).toBeGreaterThanOrEqual(1);
    expect(s.suggestedMinutes).toBeNull(); // 1건뿐이라 제안 없음
  });
});

describe('설정', () => {
  it('공휴일 세트는 출처·연도·확인 상태를 가지며 수정 가능', async () => {
    const list = await asAdmin({ method: 'GET', url: '/api/holiday-sets' });
    expect(list.statusCode).toBe(200);
    const hs = list.json().find((h: { year: number }) => h.year === 2026);
    expect(hs.source).toContain('규정');
    expect(hs.holidays.every((h: { verified: boolean }) => h.verified === false)).toBe(true);
    hs.holidays[0].verified = true;
    hs.holidays.push({ date: '2026-07-20', name: '여름방학 시작(휴강)', enabled: true });
    const put = await asAdmin({ method: 'PUT', url: `/api/holiday-sets/${hs.id}`, payload: hs });
    expect(put.statusCode).toBe(200);
    expect(put.json().holidays.some((h: { date: string }) => h.date === '2026-07-20')).toBe(true);
  });

  it('학년도 시작월 설정', async () => {
    const s = (await asAdmin({ method: 'GET', url: '/api/settings' })).json();
    const put = await asAdmin({ method: 'PUT', url: '/api/settings', payload: { ...s, academicYearStartMonth: 1 } });
    expect(put.json().academicYearStartMonth).toBe(1);
    const bad = await asAdmin({ method: 'PUT', url: '/api/settings', payload: { ...(put.json() as object), academicYearStartMonth: 13 } });
    expect(bad.statusCode).toBe(400);
  });

  it('샘플 데이터 수·삭제 권한', async () => {
    const n = await asTeacher({ method: 'GET', url: '/api/samples' });
    expect(n.json().count).toBeGreaterThan(0);
    const del = await asTeacher({ method: 'DELETE', url: '/api/samples' });
    expect(del.statusCode).toBe(403);
  });
});
