import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { seedAdmin, seedDemoTeacher, seedSamples } from '../src/seed.ts';
import { resetLoginLimiter } from '../src/routes/users.ts';
import { SAMPLE_IDS, type LearningItem, type Textbook } from '@wb/shared';

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
  it.each([[undefined, false], ['https', true]] as const)('로그인 쿠키는 접속 방식 %s에서 Secure=%s를 적용한다', async (protocol, secure) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin1234' }, headers: protocol ? { 'x-forwarded-proto': protocol } : undefined });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'wb_session')!;
    expect(cookie.secure ?? false).toBe(secure);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
  });

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

describe('교재 보충 연결', () => {
  const item = (patch: Partial<LearningItem> = {}) => ({ title: '연결 확인 항목', progressUnit: 'activity', minutes: 10, ...patch });
  const create = async (title: string, items: ReturnType<typeof item>[]) => {
    const res = await asAdmin({ method: 'POST', url: '/api/textbooks', payload: { title, items } });
    expect(res.statusCode).toBe(201);
    return res.json<Textbook>();
  };

  it('다른 교재의 항목을 연결하면 보충형 과정에 붙고, 복제도 같은 대상을 유지한다', async () => {
    const main = await create('보충 연결 주교재', [item({ title: '주교재 학습' })]);
    const supplement = await create('보충 연결 활동지', [item({ attachToItemId: main.items[0].id })]);
    const auto = await asAdmin({ method: 'POST', url: '/api/curricula/auto-assemble', payload: { textbooks: [{ textbookId: main.id, role: 'main' }, { textbookId: supplement.id, role: 'supplement' }], compositionMode: 'supplement', minutesPerSession: 60 } });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().sessions.flatMap((s: { entries: Array<{ itemId: string }> }) => s.entries).map((e: { itemId: string }) => e.itemId)).toEqual([main.items[0].id, supplement.items[0].id]);
    expect(auto.json().unassignedEntries).toEqual([]);
    const clone = await asAdmin({ method: 'POST', url: `/api/textbooks/${supplement.id}/clone` });
    expect(clone.statusCode).toBe(201);
    expect(clone.json<Textbook>().items[0].id).not.toBe(supplement.items[0].id);
    expect(clone.json<Textbook>().items[0].attachToItemId).toBe(main.items[0].id);
  });

  it('없는 대상·자기 자신·같은 교재·제외·보관 항목은 새로 연결할 수 없다', async () => {
    const main = await create('연결 경계 주교재', [item(), item({ excluded: true })]);
    const archived = await create('보관한 연결 주교재', [item()]);
    expect((await asAdmin({ method: 'POST', url: `/api/textbooks/${archived.id}/archive`, payload: { archived: true } })).statusCode).toBe(200);
    for (const target of ['없는 항목', main.items[1].id, archived.items[0].id]) {
      const res = await asAdmin({ method: 'POST', url: '/api/textbooks', payload: { title: '잘못된 보충 연결', items: [item({ attachToItemId: target })] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('보충 연결');
    }
    for (const target of ['self', 'same-book']) {
      const res = await asAdmin({ method: 'POST', url: '/api/textbooks', payload: { title: '교재 안의 보충 연결', items: [item({ id: 'self', attachToItemId: target }), item({ id: 'same-book' })] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('다른 교재');
    }
    const supplement = await create('수정 경계 활동지', [item({ attachToItemId: main.items[0].id })]);
    const invalid = await asAdmin({ method: 'PUT', url: `/api/textbooks/${supplement.id}`, payload: { ...supplement, items: [item({ ...supplement.items[0], attachToItemId: main.items[1].id })] } });
    expect(invalid.statusCode).toBe(400);
    const unchanged = (await asAdmin({ method: 'GET', url: `/api/textbooks/${supplement.id}` })).json<Textbook>();
    expect(unchanged.version).toBe(supplement.version);
    expect(unchanged.items[0].attachToItemId).toBe(main.items[0].id);
  });

  it.each(['보관', '제외', '삭제'])('대상이 %s돼도 기존 연결을 보존하며, 다른 항목으로 바꾸거나 해제할 수 있다', async (state) => {
    const main = await create(`기존 연결 ${state} 주교재`, [item(), item({ title: '바꿀 대상' })]);
    const supplement = await create(`기존 연결 ${state} 활동지`, [item({ attachToItemId: main.items[0].id })]);
    const changed = state === '보관'
      ? await asAdmin({ method: 'POST', url: `/api/textbooks/${main.id}/archive`, payload: { archived: true } })
      : await asAdmin({ method: 'PUT', url: `/api/textbooks/${main.id}`, payload: { ...main, items: state === '삭제' ? main.items.slice(1) : main.items.map((it, i) => i === 0 ? { ...it, excluded: true } : it) } });
    expect(changed.statusCode).toBe(200);
    const saved = await asAdmin({ method: 'PUT', url: `/api/textbooks/${supplement.id}`, payload: { ...supplement, title: '기존 연결 유지' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<Textbook>().items[0].attachToItemId).toBe(main.items[0].id);
    const target = await create('새 연결 주교재', [item()]);
    const current = saved.json<Textbook>();
    const switched = await asAdmin({ method: 'PUT', url: `/api/textbooks/${current.id}`, payload: { ...current, items: current.items.map((it) => ({ ...it, attachToItemId: target.items[0].id })) } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json<Textbook>().items[0].attachToItemId).toBe(target.items[0].id);
    const updated = switched.json<Textbook>();
    const cleared = await asAdmin({ method: 'PUT', url: `/api/textbooks/${updated.id}`, payload: { ...updated, items: updated.items.map((it) => ({ ...it, attachToItemId: undefined })) } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Textbook>().items[0].attachToItemId).toBeUndefined();
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
    const pub = await asAdmin({ method: 'POST', url: `/api/curricula/${c.id}/publish`, payload: { version: c.version } });
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
    // 과정이 쓰는 12~23쪽을 벗어나지 않는 개정 (범위를 넓히면 과정에서 고치라는 알림이 함께 온다)
    tb.items[0].range = { from: 12, to: 25 };
    tb.edition = '2027년 개정판';
    const put = await asAdmin({ method: 'PUT', url: `/api/textbooks/${SAMPLE_IDS.marketTextbook}`, payload: tb });
    expect(put.statusCode).toBe(200);
    expect((put.json().warnings ?? []).join(' ')).toContain('24~25');
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

describe('동시 기록 자동 병합과 달력 내보내기', () => {
  const expectOf = (a: { lessonId: string; itemId: string; portion?: { from: number; to: number }; minutes: number }) => ({ lessonId: a.lessonId, itemId: a.itemId, from: a.portion?.from ?? null, to: a.portion?.to ?? null, minutes: a.minutes });
  it('두 사람이 같은 버전 화면에서 동시에 기록해도 둘 다 저장된다 (기록은 추가만 하므로 병합)', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, settings } })).json();
    const [a1, a2] = p.assignments.filter((a: { lessonId: string }) => a.lessonId === p.lessons[0].id);
    const r1 = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: a1.id, status: 'done', version: p.version } });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().merged).toBe(false);
    // 관리자는 이전 버전 화면에서 기록 → 409 대신 병합
    const r2 = await asAdmin({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: a2.id, status: 'partial', completedFraction: 0.5, version: p.version, expect: expectOf(a2) } });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().merged).toBe(true);
    expect(r2.json().records.map((x: { assignmentId: string }) => x.assignmentId).sort()).toEqual([a1.id, a2.id].sort());
    // 이해 확인도 병합
    const c = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/checks`, payload: { lessonId: p.lessons[0].id, itemId: a1.itemId, textbookId: a1.textbookId, objectiveIds: [], result: 'confirmed', version: p.version } });
    expect(c.statusCode).toBe(200);
    expect(c.json().merged).toBe(true);
    // 다른 사람이 재편성으로 배정을 없앤 뒤 옛 화면에서 기록하면 409로 새로 고침 안내
    const bad = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: 'gone', status: 'done', version: p.version } });
    expect(bad.statusCode).toBe(409);
    // 일정 변경 연산은 여전히 버전이 다르면 409 (덮어쓰기 방지)
    const op = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/ops`, payload: { op: 'postpone', params: { lessonId: p.lessons[3].id }, version: p.version } });
    expect(op.statusCode).toBe(409);
  });

  it('그사이 재편성으로 같은 배정의 날짜가 바뀌었으면 옛 화면의 기록을 병합하지 않는다 (2차 리뷰)', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, settings } })).json();
    // 배정이 있는 수업 둘째 것의 배정을 화면에서 보고 있다
    const taught = p.lessons.filter((l: { id: string }) => p.assignments.some((a: { lessonId: string }) => a.lessonId === l.id));
    const seen = p.assignments.find((a: { lessonId: string }) => a.lessonId === taught[1].id);
    // 다른 사람이 첫 수업을 미뤄 뒤 배정이 다음 수업으로 밀린다
    const op = await asAdmin({ method: 'POST', url: `/api/plans/${p.id}/ops`, payload: { op: 'postpone', params: { lessonId: taught[0].id }, version: p.version } });
    expect(op.statusCode).toBe(200);
    const now = op.json().assignments.find((a: { id: string }) => a.id === seen.id);
    const r = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: seen.id, status: 'done', version: p.version, expect: expectOf(seen) } });
    // 미루기는 배정 id 를 그대로 두고 다음 수업으로 옮긴다: 같은 id 지만 화면에서 본 날짜가 아니다
    expect(now.id).toBe(seen.id);
    expect(now.lessonId).not.toBe(seen.lessonId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('새로 고쳐');
    // 그대로인 배정은 화면에서 본 내용이 같으므로 병합된다
    const same = op.json().assignments.find((a: { id: string; lessonId: string }) => p.assignments.some((b: { id: string; lessonId: string }) => b.id === a.id && b.lessonId === a.lessonId));
    if (same) {
      const ok = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: same.id, status: 'done', version: p.version, expect: expectOf(p.assignments.find((b: { id: string }) => b.id === same.id)) } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().merged).toBe(true);
    }
    // 화면에서 본 내용을 보내지 않은 옛 버전 기록도 병합하지 않는다
    const noExpect = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: op.json().assignments[0].id, status: 'done', version: p.version } });
    expect(noExpect.statusCode).toBe(409);
  });

  it('캘린더 파일(.ics)을 내려받는다', async () => {
    const p = (await asTeacher({ method: 'GET', url: '/api/plans' })).json()[0];
    const r = await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/calendar.ics?audience=student` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/calendar');
    expect(r.body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(r.body).toContain('BEGIN:VEVENT');
    expect(r.body).not.toContain('지도 메모');
  });
});

describe('리뷰 결함 회귀 (서버)', () => {
  it('#8 스냅샷 갱신은 새 과정 구성으로 다시 편성하고, 기록이 있으면 거부하며, version 이 필요하다', async () => {
    // 관리자 소유의 새 과정 (2차시만) → 계획 → 과정에 차시 추가 → 스냅샷 갱신
    const auto = (await asAdmin({ method: 'POST', url: '/api/curricula/auto-assemble', payload: { textbooks: [{ textbookId: SAMPLE_IDS.marketTextbook, role: 'main' }], compositionMode: 'sequential' } })).json();
    const c = (await asAdmin({ method: 'POST', url: '/api/curricula', payload: { title: '갱신 테스트 과정', ...(auto as object), sessions: auto.sessions.slice(0, 2), compositionMode: 'sequential' } })).json();
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: c.id, settings: { ...settings, endDate: '2026-05-31' } } })).json();
    const beforeItems = new Set(p.assignments.map((a: { itemId: string }) => a.itemId));
    const full = (await asAdmin({ method: 'PUT', url: `/api/curricula/${c.id}`, payload: { ...c, sessions: auto.sessions } })).json();
    expect(full.sessions.length).toBeGreaterThan(2);
    expect((await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/refresh-snapshot`, payload: {} })).statusCode).toBe(400); // version 없음
    const r = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/refresh-snapshot`, payload: { version: p.version } });
    expect(r.statusCode).toBe(200);
    const afterItems = new Set(r.json().assignments.map((a: { itemId: string }) => a.itemId));
    expect(afterItems.size).toBeGreaterThan(beforeItems.size);
    // 이전 버전으로 다시 요청하면 409
    expect((await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/refresh-snapshot`, payload: { version: p.version } })).statusCode).toBe(409);
    // 기록이 생기면 갱신 거부
    const cur = r.json();
    const rec = (await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: cur.assignments[0].id, status: 'done', version: cur.version } })).json();
    const refused = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/refresh-snapshot`, payload: { version: rec.version } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('기록');
  });

  it('보관된 과정으로는 계획을 만들 수 없다', async () => {
    const c = (await asAdmin({ method: 'POST', url: `/api/curricula/${SAMPLE_IDS.curriculumSupplement}/clone` })).json();
    await asAdmin({ method: 'POST', url: `/api/curricula/${c.id}/archive`, payload: { archived: true } });
    const r = await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: c.id, settings } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('보관');
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

describe('연간·분기·월간 열 선택 (엑셀)', () => {
  it('양식의 요약 열이 엑셀 연간·월간 시트 머리글에 반영된다', async () => {
    const tpls = (await asAdmin({ method: 'GET', url: '/api/templates' })).json() as Array<{ id: string; audience: string }>;
    const t = tpls.find((x) => x.audience === 'teacher')!;
    const full = (await asAdmin({ method: 'GET', url: '/api/templates' })).json().find((x: { id: string }) => x.id === t.id);
    const put = await asAdmin({ method: 'PUT', url: `/api/templates/${t.id}`, payload: { ...full, summaryColumns: { year: ['label', 'lessons', 'bad'], month: ['week', 'assigned'] } } });
    expect(put.statusCode).toBe(200);
    expect(put.json().summaryColumns).toEqual({ year: ['label', 'lessons'], month: ['week', 'assigned'] });
    const p = (await asTeacher({ method: 'GET', url: '/api/plans' })).json()[0];
    const x = await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/export.xlsx?template=${t.id}&levels=year,month` });
    expect(x.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as never);
    expect(wb.getWorksheet('연간')!.getRow(1).values).toEqual([undefined, '학년도', '수업 횟수']);
    expect(wb.getWorksheet('월간')!.getRow(1).values).toEqual([undefined, '월', '주', '배정 분량']);
    const total = [] as unknown[];
    wb.getWorksheet('월간')!.eachRow((r) => { if (String(r.getCell(1).value).endsWith('합계')) total.push(r.values); });
    expect(total.length).toBeGreaterThan(0);
  });
});

describe('캘린더 구독 주소', () => {
  it('만들기 → 로그인 없이 열림(학생용 내용) → 폐기하면 404, 복제본에는 따라가지 않음', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, settings } })).json();
    const made = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/calendar-feeds`, payload: { audience: 'student', label: '학부모', version: p.version } });
    expect(made.statusCode).toBe(200);
    const feed = made.json().calendarFeeds[0];
    expect(feed.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // 로그인 쿠키 없이 연다
    const open = await app.inject({ method: 'GET', url: `/api/feeds/${feed.token}.ics` });
    expect(open.statusCode).toBe(200);
    expect(open.headers['content-type']).toContain('text/calendar');
    expect(open.body).toContain('BEGIN:VEVENT');
    expect(open.body).not.toContain('지도 메모');
    // 추측한 주소·형식이 틀린 주소는 404
    expect((await app.inject({ method: 'GET', url: '/api/feeds/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/feeds/short.ics' })).statusCode).toBe(404);
    // 복제본에는 구독 주소가 없다
    const clone = (await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/clone` })).json();
    expect(clone.calendarFeeds ?? []).toHaveLength(0);
    // 폐기
    const rev = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/calendar-feeds/revoke`, payload: { token: feed.token, version: made.json().version } });
    expect(rev.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/feeds/${feed.token}.ics` })).statusCode).toBe(404);
  });

  it('계획에 접근할 수 없는 강사는 구독 주소를 만들 수 없다', async () => {
    const p = (await asAdmin({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings } })).json();
    expect((await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/calendar-feeds`, payload: { audience: 'teacher', version: p.version } })).statusCode).toBe(403);
  });
});

describe('기록 저장의 작은 응답 (휴대폰)', () => {
  it('slim 이면 계획 전체 대신 버전·남은 범위만 돌려주고, 저장은 그대로 된다', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, settings } })).json();
    const a = p.assignments.find((x: { textbookId: string }) => x.textbookId === SAMPLE_IDS.marketTextbook);
    const r = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: a.id, status: 'partial', completedPortion: { from: 12, to: 17 }, version: p.version, slim: true } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(['id', 'merged', 'planVersion', 'recordId', 'remaining', 'version'].sort());
    expect(body.remaining.portion).toEqual({ from: 18, to: 23 });
    expect(r.body.length).toBeLessThan(500);
    const full = (await asTeacher({ method: 'GET', url: `/api/plans/${p.id}` })).json();
    expect(full.records.some((x: { id: string }) => x.id === body.recordId)).toBe(true);
    expect(full.version).toBe(body.version);
    const c = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/checks`, payload: { lessonId: a.lessonId, itemId: a.itemId, textbookId: a.textbookId, objectiveIds: [], result: 'confirmed', version: body.version, slim: true } });
    expect(Object.keys(c.json()).sort()).toEqual(['checkId', 'id', 'merged', 'planVersion', 'version'].sort());
  });
});

describe('2차 리뷰 결함 회귀 (서버)', () => {
  it('구독 주소를 만든 사람이 비활성화되면 그 주소는 더 열리지 않는다', async () => {
    const made = await asAdmin({ method: 'POST', url: '/api/users', payload: { username: 'wb가상구독', password: 'feeduser1234', displayName: '구독 테스트' } });
    expect(made.statusCode).toBe(201);
    const cookie = await login('wb가상구독', 'feeduser1234');
    expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie }, payload: { currentPassword: 'feeduser1234', newPassword: 'feeduser-changed1234' } })).statusCode).toBe(200);
    const asUser = (opts: Record<string, unknown>) => app.inject({ ...opts, headers: { cookie } } as never);
    const p = (await asUser({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, settings } })).json();
    const feed = (await asUser({ method: 'POST', url: `/api/plans/${p.id}/calendar-feeds`, payload: { audience: 'teacher', version: p.version } })).json().calendarFeeds[0];
    expect((await app.inject({ method: 'GET', url: `/api/feeds/${feed.token}.ics` })).statusCode).toBe(200);
    expect((await asAdmin({ method: 'PUT', url: `/api/users/${made.json().id}`, payload: { active: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/feeds/${feed.token}.ics` })).statusCode).toBe(404);
    // 다시 활성화하면 열린다 (주소 자체를 폐기한 것은 아님)
    await asAdmin({ method: 'PUT', url: `/api/users/${made.json().id}`, payload: { active: true } });
    expect((await app.inject({ method: 'GET', url: `/api/feeds/${feed.token}.ics` })).statusCode).toBe(200);
    // 계획을 보관하면 404 (비활성화로 옛 로그인이 끊겼으므로 다시 로그인)
    const cookie2 = await login('wb가상구독', 'feeduser-changed1234');
    const asUser2 = (opts: Record<string, unknown>) => app.inject({ ...opts, headers: { cookie: cookie2 } } as never);
    expect((await asUser({ method: 'GET', url: `/api/plans/${p.id}` })).statusCode).toBe(401);
    const cur = (await asUser2({ method: 'GET', url: `/api/plans/${p.id}` })).json();
    const arch = await asUser2({ method: 'PUT', url: `/api/plans/${p.id}`, payload: { archived: true, version: cur.version } });
    expect(arch.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/feeds/${feed.token}.ics` })).statusCode).toBe(404);
  });

  it('확정된 계획의 선행 기초 확인은 바꿀 수 없다', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumAdvance, settings: { ...settings, endDate: '2027-02-26' } } })).json();
    const ok = (await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/advance-confirm`, payload: { confirmed: true, note: '진단평가 90점', version: p.version } })).json();
    // 미배정 범위는 제외 처리해 확정할 수 있게 한다
    let cur = ok;
    for (const u of ok.unassigned.filter((x: { reason: string }) => x.reason !== 'excluded')) {
      cur = (await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/ops`, payload: { op: 'exclude', params: { unassignedId: u.id, reason: '테스트: 다음 학기로' }, version: cur.version } })).json();
    }
    const conf = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/confirm`, payload: { version: cur.version } });
    expect(conf.statusCode).toBe(200);
    const res = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/advance-confirm`, payload: { confirmed: false, note: '', version: conf.json().version } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('확정');
  });

  it('이해 확인은 그 수업에 배정된 학습항목만 받고, 교재·목표는 서버가 정한다', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumParallel, settings } })).json();
    const lesson = p.lessons.find((l: { id: string }) => p.assignments.some((a: { lessonId: string }) => a.lessonId === l.id));
    const a = p.assignments.find((x: { lessonId: string }) => x.lessonId === lesson.id);
    const other = p.assignments.find((x: { lessonId: string; itemId: string }) => x.lessonId !== lesson.id && x.itemId !== a.itemId);
    // 다른 수업의 학습항목
    const bad = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/checks`, payload: { lessonId: lesson.id, itemId: other.itemId, result: 'confirmed', version: p.version } });
    expect(bad.statusCode).toBe(400);
    // 교재 id·없는 목표를 꾸며 보내도 배정의 교재, 항목의 목표만 남는다
    const ok = await asTeacher({ method: 'POST', url: `/api/plans/${p.id}/checks`, payload: { lessonId: lesson.id, itemId: a.itemId, textbookId: 'fake-tb', objectiveIds: ['fake-objective'], result: 'needs_review', version: p.version } });
    expect(ok.statusCode).toBe(200);
    const chk = ok.json().understandingChecks.at(-1);
    expect(chk.textbookId).toBe(a.textbookId);
    expect(chk.objectiveIds).not.toContain('fake-objective');
  });
});

describe('3차 리뷰 결함 회귀 (서버)', () => {
  let built3: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    built3 = await buildApp({ dbPath: ':memory:' });
    seedAdmin(built3.ctx, 'admin', 'admin1234');
    seedDemoTeacher(built3.ctx);
    seedSamples(built3.ctx);
    await built3.app.ready();
  });
  afterAll(async () => {
    await built3.app.close();
  });
  const auditRows = (action: string) =>
    (built3.ctx.store as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db.prepare('SELECT * FROM audit WHERE action = ?').all(action) as Array<Record<string, string>>;
  const inj = (opts: Record<string, unknown>) => built3.app.inject(opts as never);
  const loginTo = async (username: string, password: string) => {
    const res = await inj({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'wb_session')!;
    return `${c.name}=${c.value}`;
  };
  const as = (cookie: string) => (opts: Record<string, unknown>) => inj({ ...opts, headers: { cookie } });

  it('형식에 맞지 않는 아주 긴 아이디는 감사 로그에 그대로 남지 않는다', async () => {
    const res = await inj({ method: 'POST', url: '/api/auth/login', payload: { username: 'x'.repeat(200000), password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(auditRows('login_failed').every((r) => r.doc_id.length <= 32 || r.doc_id === '(형식 오류)')).toBe(true);
  });

  it('비밀번호를 바꾸거나 초기화하면 다른 기기의 로그인이 끊긴다', async () => {
    const admin = as(await loginTo('admin', 'admin1234'));
    await admin({ method: 'POST', url: '/api/users', payload: { username: 'wb가상세션', password: 'sess1pass!' } });
    const c1 = await loginTo('wb가상세션', 'sess1pass!');
    const c2 = await loginTo('wb가상세션', 'sess1pass!');
    expect((await as(c1)({ method: 'POST', url: '/api/auth/password', payload: { currentPassword: 'sess1pass!', newPassword: 'sess1pass2!' } })).statusCode).toBe(200);
    expect((await as(c1)({ method: 'GET', url: '/api/auth/me' })).json()?.username).toBe('wb가상세션');
    expect((await as(c2)({ method: 'GET', url: '/api/auth/me' })).json()).toBeNull();
    // 관리자 초기화는 모든 세션을 끊는다
    const users = (await admin({ method: 'GET', url: '/api/users' })).json();
    const id = users.find((u: { username: string }) => u.username === 'wb가상세션').id;
    expect((await admin({ method: 'PUT', url: `/api/users/${id}`, payload: { password: 'reset-pass-1' } })).statusCode).toBe(200);
    expect((await as(c1)({ method: 'GET', url: '/api/auth/me' })).json()).toBeNull();
    // 비활성화 뒤 다시 활성화해도 옛 세션은 살아나지 않는다
    const c3 = await loginTo('wb가상세션', 'reset-pass-1');
    await admin({ method: 'PUT', url: `/api/users/${id}`, payload: { active: false } });
    await admin({ method: 'PUT', url: `/api/users/${id}`, payload: { active: true } });
    expect((await as(c3)({ method: 'GET', url: '/api/auth/me' })).json()).toBeNull();
    const logged = auditRows('user_update').map((r) => r.detail).join(' | ');
    expect(logged).toContain('비밀번호 초기화');
    expect(logged).toContain('비활성화');
    expect(logged).not.toContain('reset-pass-1');
  });

  it('없는 아이디도 비밀번호 계산을 거친다 (응답 시간으로 아이디 존재 여부가 드러나지 않게)', async () => {
    const time = async (username: string) => {
      const t = performance.now();
      await inj({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'wrong-password' } });
      return performance.now() - t;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      known.push(await time('teacher'));
      unknown.push(await time(`nobody${i}`));
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[1];
    // 예전에는 없는 아이디가 30배 이상 빨랐다. 이제 같은 계산을 하므로 비슷하게 걸린다
    expect(med(unknown)).toBeGreaterThan(med(known) * 0.5);
  });

  it('계획 기간·복습 시간·보강 시간의 비정상 값을 거절한다', async () => {
    const t = as(await loginTo('teacher', 'teacher1234'));
    const make = (s: Record<string, unknown>) => t({ method: 'POST', url: '/api/plans/preview', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings: { ...settings, ...s } } });
    expect((await make({ startDate: '1000-01-01', endDate: '2999-12-31', weekdays: [0, 1, 2, 3, 4, 5, 6] })).statusCode).toBe(400);
    expect((await make({ reviewMinutes: -600 })).statusCode).toBe(400);
    expect((await make({ makeupDays: [{ date: '2026-04-11', minutes: -100 }] })).statusCode).toBe(400);
    expect((await make({ offDays: [null] })).statusCode).toBe(400);
    // 형식이 틀린 공휴일 목록 id 는 무시한다 (예전에는 DB 오류 문구가 그대로 나갔다)
    expect((await make({ holidaySetIds: [{}] })).statusCode).toBe(200);
    expect((await make({ endDate: '2029-01-01' })).statusCode).toBe(200);
  });

  it('부분 완료 범위는 배정 범위 안의 정수 구간이어야 한다', async () => {
    const t = as(await loginTo('teacher', 'teacher1234'));
    const p = (await t({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings } })).json();
    const a = p.assignments.find((x: { portion?: unknown }) => x.portion);
    const bad = await t({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: a.id, status: 'partial', completedPortion: { from: 900, to: -5 }, version: p.version } });
    expect(bad.statusCode).toBe(400);
    const ok = await t({ method: 'POST', url: `/api/plans/${p.id}/records`, payload: { assignmentId: a.id, status: 'partial', completedPortion: { from: a.portion.from, to: a.portion.from }, version: p.version } });
    expect(ok.statusCode).toBe(200);
  });

  it('과정 발행은 화면에서 본 버전이 지금 버전과 같아야 한다', async () => {
    const admin = as(await loginTo('admin', 'admin1234'));
    const c = (await admin({ method: 'GET', url: `/api/curricula/${SAMPLE_IDS.curriculumParallel}` })).json();
    const put = await admin({ method: 'PUT', url: `/api/curricula/${c.id}`, payload: { ...c, title: c.title + ' (수정)', version: c.version } });
    expect(put.statusCode).toBe(200);
    expect((await admin({ method: 'POST', url: `/api/curricula/${c.id}/publish`, payload: { version: c.version } })).statusCode).toBe(409);
    expect((await admin({ method: 'POST', url: `/api/curricula/${c.id}/publish`, payload: {} })).statusCode).toBe(400);
  });

  it('검토 의견·계획 이름의 길이를 제한한다', async () => {
    const t = as(await loginTo('teacher', 'teacher1234'));
    expect((await t({ method: 'POST', url: `/api/curricula/${SAMPLE_IDS.curriculumBasic}/comments`, payload: { text: 'x'.repeat(3000) } })).statusCode).toBe(400);
    expect((await t({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings, title: 'x'.repeat(500) } })).statusCode).toBe(400);
  });

  it('짝이 맞지 않는 대리 문자가 든 제목도 엑셀·달력 내보내기가 된다', async () => {
    const cookie = await loginTo('teacher', 'teacher1234');
    const t = as(cookie);
    const raw = JSON.stringify({ curriculumId: SAMPLE_IDS.curriculumBasic, settings, title: 'TITLE' }).replace('TITLE', 'A' + String.fromCharCode(92) + 'ud800B');
    const res = await inj({ method: 'POST', url: '/api/plans', headers: { cookie, 'content-type': 'application/json' }, payload: raw });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect((await t({ method: 'GET', url: `/api/plans/${id}/export.xlsx` })).statusCode).toBe(200);
    expect((await t({ method: 'GET', url: `/api/plans/${id}/calendar.ics` })).statusCode).toBe(200);
  });

  it('실제 과정이 샘플 교재를 쓰면 샘플 삭제를 거절하고 이유를 알려 준다', async () => {
    const admin = as(await loginTo('admin', 'admin1234'));
    const src = (await admin({ method: 'GET', url: `/api/curricula/${SAMPLE_IDS.curriculumBasic}` })).json();
    const real = await admin({ method: 'POST', url: '/api/curricula', payload: { ...src, id: undefined, title: '실제 과정', isSample: false } });
    expect(real.statusCode).toBe(201);
    const del = await admin({ method: 'DELETE', url: '/api/samples' });
    expect(del.statusCode).toBe(409);
    expect(JSON.stringify(del.json().details)).toContain('실제 과정');
    expect((await admin({ method: 'GET', url: '/api/samples' })).json().count).toBeGreaterThan(0);
  });

  it('관리자 설정 변경과 과정 보관이 감사 로그에 남는다', async () => {
    const admin = as(await loginTo('admin', 'admin1234'));
    const s = (await admin({ method: 'GET', url: '/api/settings' })).json();
    expect((await admin({ method: 'PUT', url: '/api/settings', payload: { ...s, version: s.version } })).statusCode).toBe(200);
    expect((await admin({ method: 'PUT', url: '/api/settings', payload: { ...s, defaultReviewMinutes: -5, version: s.version + 1 } })).statusCode).toBe(400);
    expect((await admin({ method: 'POST', url: `/api/curricula/${SAMPLE_IDS.curriculumAdvance}/archive`, payload: { archived: true } })).statusCode).toBe(200);
    expect(auditRows('update').some((r) => r.kind === 'settings')).toBe(true);
    expect(auditRows('archive').some((r) => r.kind === 'curriculum')).toBe(true);
  });
});

describe('3차 리뷰 결함 회귀 (엑셀 출력)', () => {
  const load = async (body: Buffer) => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);
    return wb;
  };
  const cells = (ws: { eachRow: (cb: (r: { values: unknown }) => void) => void }) => {
    const out: unknown[][] = [];
    ws.eachRow((r) => out.push((r.values as unknown[]).slice(1)));
    return out;
  };

  it('학생용 표지에는 변경 사항(이력 문구)을 넣지 않고, 분 열은 숫자 칸이다', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings } })).json();
    const st = await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/export.xlsx?audience=student` });
    expect(st.statusCode).toBe(200);
    const wb = await load(st.rawPayload);
    const cover = cells(wb.getWorksheet('표지')!);
    expect(cover.some((r) => r[0] === '변경 사항')).toBe(false);
    const te = await load((await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/export.xlsx?audience=teacher` })).rawPayload);
    expect(cells(te.getWorksheet('표지')!).some((r) => r[0] === '변경 사항')).toBe(true);
    const day = cells(te.getWorksheet('일간')!);
    const header = day[0] as string[];
    const mi = header.indexOf('시간(분)');
    expect(mi).toBeGreaterThanOrEqual(0);
    expect(day.slice(1).some((r) => typeof r[mi] === 'number')).toBe(true);
  });

  it('형식이 틀린 날짜 범위는 화면과 같이 무시하고 전체 계획을 내보낸다', async () => {
    const p = (await asTeacher({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings } })).json();
    const bad = await load((await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/export.xlsx?from=2026-4-1&to=2026-4-30&levels=day` })).rawPayload);
    const all = await load((await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/export.xlsx?levels=day` })).rawPayload);
    expect(cells(bad.getWorksheet('일간')!).length).toBe(cells(all.getWorksheet('일간')!).length);
    expect(cells(all.getWorksheet('일간')!).length).toBeGreaterThan(1);
    const ranged = await load((await asTeacher({ method: 'GET', url: `/api/plans/${p.id}/export.xlsx?from=2026-04-13&to=2026-04-19&levels=day` })).rawPayload);
    expect(cells(ranged.getWorksheet('표지')!).some((r) => r[0] === '출력 범위')).toBe(true);
  });
});

describe('4차 리뷰 결함 회귀 (교재·과정 편집 흐름)', () => {
  let b4: Awaited<ReturnType<typeof buildApp>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }>;
  beforeAll(async () => {
    b4 = await buildApp({ dbPath: ':memory:' });
    seedAdmin(b4.ctx, 'admin', 'admin1234');
    seedDemoTeacher(b4.ctx);
    seedSamples(b4.ctx);
    await b4.app.ready();
    const res = await b4.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin1234' } });
    const c = res.cookies.find((x) => x.name === 'wb_session')!;
    admin = (o) => b4.app.inject({ ...o, headers: { cookie: `${c.name}=${c.value}` } } as never);
  });
  afterAll(async () => {
    await b4.app.close();
  });
  const I = (k: number) => `${SAMPLE_IDS.marketTextbook}-i${k}`;
  const getTb = async () => (await admin({ method: 'GET', url: `/api/textbooks/${SAMPLE_IDS.marketTextbook}` })).json();

  it('과정 중간 차시부터 계획하면 앞 차시 항목은 배운 것으로 보고 선수 조건을 충족한다', async () => {
    const res = await admin({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumBasic, settings, fromSessionOrder: 4, toSessionOrder: 5 } });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.assignments.length).toBeGreaterThan(0);
    expect(p.unassigned.filter((u: { reason: string }) => u.reason === 'prerequisite')).toEqual([]);
    expect(p.snapshot.selection.fromSessionOrder).toBe(4);
    // 스냅샷을 갱신해도 고른 범위를 유지한다
    const ref = await admin({ method: 'POST', url: `/api/plans/${p.id}/refresh-snapshot`, payload: { version: p.version } });
    expect(ref.statusCode).toBe(200);
    expect(ref.json().snapshot.sessions.map((s: { order: number }) => s.order)).toEqual([4, 5]);
  });

  it('스냅샷 갱신은 선행 기초 확인을 유지하고, 계획 복제는 확인을 초기화한다', async () => {
    const p = (await admin({ method: 'POST', url: '/api/plans', payload: { curriculumId: SAMPLE_IDS.curriculumAdvance, settings: { ...settings, endDate: '2026-05-31' } } })).json();
    const ok = (await admin({ method: 'POST', url: `/api/plans/${p.id}/advance-confirm`, payload: { confirmed: true, note: '학생 A 진단평가 90점', version: p.version } })).json();
    const ref = (await admin({ method: 'POST', url: `/api/plans/${p.id}/refresh-snapshot`, payload: { version: ok.version } })).json();
    expect(ref.snapshot.advance.prerequisitesConfirmed).toBe(true);
    const clone = (await admin({ method: 'POST', url: `/api/plans/${p.id}/clone` })).json();
    expect(clone.snapshot.advance.prerequisitesConfirmed).toBe(false);
    expect(clone.blockers.join(' ')).toContain('기초 확인');
  });

  it('과정이 쓰는 항목을 지우거나 배치 범위 밖으로 줄이는 교재 저장은 막는다', async () => {
    const tb = await getTb();
    // 다른 항목의 선수 참조도 함께 지워, 과정 사용 검사만 걸리게 한다
    const items = tb.items.filter((i: { id: string }) => i.id !== I(3)).map((i: { prerequisiteItemIds: string[] }) => ({ ...i, prerequisiteItemIds: i.prerequisiteItemIds.filter((p) => p !== I(3)) }));
    const removed = await admin({ method: 'PUT', url: `/api/textbooks/${tb.id}`, payload: { ...tb, items } });
    expect(removed.statusCode).toBe(400);
    expect(JSON.stringify(removed.json().details)).toContain('과정');
    const shrunk = structuredClone(tb);
    shrunk.items[0].range = { from: 12, to: 17 };
    expect((await admin({ method: 'PUT', url: `/api/textbooks/${tb.id}`, payload: shrunk })).statusCode).toBe(400);
  });

  it('선수 학습 순환과 없는 항목 참조는 교재 저장에서 거절한다', async () => {
    const tb = await getTb();
    const cyc = structuredClone(tb);
    cyc.items.find((i: { id: string }) => i.id === I(3)).prerequisiteItemIds.push(I(4));
    const r1 = await admin({ method: 'PUT', url: `/api/textbooks/${tb.id}`, payload: cyc });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toContain('순환');
    const dangling = structuredClone(tb);
    dangling.items[0].prerequisiteItemIds = ['nope'];
    expect((await admin({ method: 'PUT', url: `/api/textbooks/${tb.id}`, payload: dangling })).statusCode).toBe(400);
  });

  it('과정 배치의 범위·비율·시간·사용 범위·중복 id 를 검사한다', async () => {
    const src = (await admin({ method: 'GET', url: `/api/curricula/${SAMPLE_IDS.curriculumBasic}` })).json();
    const post = (mut: (c: typeof src) => void) => {
      const c = structuredClone(src);
      delete c.id;
      mut(c);
      return admin({ method: 'POST', url: '/api/curricula', payload: c });
    };
    expect((await post((c) => { c.sessions[0].entries[0].portion = { from: 500, to: 520 }; })).statusCode).toBe(400);
    expect((await post((c) => { c.sessions[0].entries[0].portion = { from: 23, to: 12 }; })).statusCode).toBe(400);
    expect((await post((c) => { c.sessions[0].entries[0].fraction = -2; })).statusCode).toBe(400);
    expect((await post((c) => { c.sessions[0].entries[0].minutes = 0.5; })).statusCode).toBe(400);
    expect((await post((c) => { c.textbooks[0].excludedItemIds = [c.sessions[0].entries[0].itemId]; })).statusCode).toBe(400);
    expect((await post((c) => { c.sessions[1].entries[0].id = c.sessions[0].entries[0].id; })).statusCode).toBe(400);
    expect((await post((c) => { c.sessions[1].id = c.sessions[0].id; })).statusCode).toBe(400);
    expect((await post((c) => { c.sessions.push(null); })).statusCode).toBe(400);
    expect((await post((c) => { c.textbooks.push(null); })).statusCode).toBe(400);
    expect((await post(() => {})).statusCode).toBe(201);
  });

  it('교재의 제외 범위 목록에 null 이 있어도 500 대신 무시한다', async () => {
    const tb = await getTb();
    expect((await admin({ method: 'PUT', url: `/api/textbooks/${tb.id}`, payload: { ...tb, excludedRanges: [null] } })).statusCode).toBe(200);
  });
});
