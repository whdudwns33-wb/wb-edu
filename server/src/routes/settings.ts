import type { FastifyInstance } from 'fastify';
import type { AppSettings, HolidaySet, LearningObjective, OutputTemplate } from '@wb/shared';
import { DEFAULT_STUDENT_COLUMNS, DEFAULT_TEACHER_COLUMNS, OUTPUT_COLUMNS, cleanSummaryColumns, defaultHolidaySets, isISODate } from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, arr, bool, expectVersion, genId, newMeta, num, requireAdmin, requireUser, str, touched } from '../context.ts';

export const DEFAULT_SUBJECT_FIELDS: AppSettings['subjectFields'] = [
  { subject: '독해', fields: [{ key: 'passage', label: '지문' }, { key: 'skill', label: '독해 기능' }] },
  { subject: '국어', fields: [{ key: 'passage', label: '지문' }, { key: 'skill', label: '독해 기능' }, { key: 'grammar', label: '문법' }] },
  { subject: '수학', fields: [{ key: 'concept', label: '개념' }, { key: 'type', label: '유형' }, { key: 'wrong', label: '오답' }] },
  { subject: '영어', fields: [{ key: 'text', label: '본문' }, { key: 'vocab', label: '어휘' }, { key: 'grammar', label: '문법' }, { key: 'listening', label: '듣기' }] },
  { subject: '자체', fields: [{ key: 'activity', label: '활동' }, { key: 'materials', label: '준비물' }, { key: 'version', label: '제작 버전' }] },
];

const COLUMN_KEYS = new Set<string>(OUTPUT_COLUMNS.map((c) => c.key));
/** 양식 열 목록에서 정의되지 않은 키를 걸러낸다 */
function validColumns(cols: string[]): string[] {
  return cols.filter((c, i) => COLUMN_KEYS.has(c) && cols.indexOf(c) === i);
}

export function ensureDefaults(ctx: AppContext, by = 'system') {
  const { store } = ctx;
  const at = ctx.now();
  if (!store.get<AppSettings>('settings', 'app')) {
    store.insert<AppSettings>('settings', {
      id: 'app',
      academicYearStartMonth: 3,
      defaultMinutesPerLesson: 60,
      defaultReviewMinutes: 10,
      defaultBufferMinutes: 5,
      subjectFields: DEFAULT_SUBJECT_FIELDS,
      organizationName: 'WB 커리큘럼 플래너',
      createdAt: at,
      createdBy: by,
      updatedAt: at,
      updatedBy: by,
      version: 1,
      archived: false,
      isSample: false,
    });
  }
  const sets = store.list<HolidaySet>('holidaySet', { includeArchived: true });
  if (sets.length === 0) for (const hs of defaultHolidaySets(by, at)) store.insert('holidaySet', hs);
  const templates = store.list<OutputTemplate>('template', { includeArchived: true });
  if (templates.length === 0) {
    store.insert<OutputTemplate>('template', { id: 'tpl-teacher', name: '강사용 기본', audience: 'teacher', columns: [...DEFAULT_TEACHER_COLUMNS], headerNote: '내부용: 지도 메모·시간 배분 포함', footerNote: '', createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, version: 1, archived: false, isSample: false });
    store.insert<OutputTemplate>('template', { id: 'tpl-student', name: '학생·학부모용 기본', audience: 'student', columns: [...DEFAULT_STUDENT_COLUMNS], headerNote: '학습목표·범위·과제 중심', footerNote: '', createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, version: 1, archived: false, isSample: false });
  }
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  // ── 운영 설정 ──
  app.get('/api/settings', async (req) => {
    requireUser(req);
    return store.mustGet<AppSettings>('settings', 'app');
  });

  app.put('/api/settings', async (req) => {
    const user = requireAdmin(req);
    const existing = store.mustGet<AppSettings>('settings', 'app');
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const month = num(r.academicYearStartMonth, existing.academicYearStartMonth);
    if (month < 1 || month > 12) throw new HttpError(400, '학년도 시작월은 1~12 사이여야 합니다.');
    const doc: AppSettings = touched(
      {
        ...existing,
        academicYearStartMonth: month,
        defaultMinutesPerLesson: num(r.defaultMinutesPerLesson, existing.defaultMinutesPerLesson),
        defaultReviewMinutes: num(r.defaultReviewMinutes, existing.defaultReviewMinutes),
        defaultBufferMinutes: num(r.defaultBufferMinutes, existing.defaultBufferMinutes),
        organizationName: str(r.organizationName, existing.organizationName),
        subjectFields: Array.isArray(r.subjectFields)
          ? arr<Record<string, unknown>>(r.subjectFields).map((s) => ({ subject: str(s.subject), fields: arr<Record<string, unknown>>(s.fields).map((f) => ({ key: str(f.key), label: str(f.label) })).filter((f) => f.key) }))
          : existing.subjectFields,
      },
      user,
      ctx.now(),
    );
    return store.update('settings', doc, version);
  });

  // ── 공휴일 ──
  app.get('/api/holiday-sets', async (req) => {
    requireUser(req);
    return store.list<HolidaySet>('holidaySet').sort((a, b) => a.year - b.year);
  });

  app.put('/api/holiday-sets/:id', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<HolidaySet>('holidaySet', id);
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const holidays = arr<Record<string, unknown>>(r.holidays).map((h) => {
      const date = str(h.date);
      if (!isISODate(date)) throw new HttpError(400, `날짜 형식 오류: ${date}`);
      return { id: str(h.id) || genId(), date, name: str(h.name), year: num(h.year, Number(date.slice(0, 4))), source: str(h.source, existing.source), verified: bool(h.verified, false), enabled: bool(h.enabled, true) };
    });
    const doc: HolidaySet = touched({ ...existing, name: str(r.name, existing.name), source: str(r.source, existing.source), holidays }, user, ctx.now());
    return store.update('holidaySet', doc, version);
  });

  app.post('/api/holiday-sets', async (req, reply) => {
    const user = requireAdmin(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const year = num(r.year, 0);
    if (!year) throw new HttpError(400, '연도를 입력하세요.');
    const at = ctx.now();
    const doc: HolidaySet = { id: genId(), name: str(r.name) || `공휴일 ${year}`, year, source: str(r.source) || '직접 입력', holidays: [], ...newMeta(user, at) };
    store.insert('holidaySet', doc);
    reply.code(201);
    return doc;
  });

  // ── 출력 양식 ──
  app.get('/api/templates', async (req) => {
    requireUser(req);
    return store.list<OutputTemplate>('template');
  });

  app.put('/api/templates/:id', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<OutputTemplate>('template', id);
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const doc: OutputTemplate = touched({ ...existing, name: str(r.name, existing.name), audience: str(r.audience) === 'student' ? 'student' : 'teacher', columns: validColumns(arr<string>(r.columns)), summaryColumns: r.summaryColumns === undefined ? existing.summaryColumns : cleanSummaryColumns(r.summaryColumns), headerNote: str(r.headerNote, existing.headerNote), footerNote: str(r.footerNote, existing.footerNote) }, user, ctx.now());
    return store.update('template', doc, version);
  });

  app.post('/api/templates', async (req, reply) => {
    const user = requireAdmin(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const at = ctx.now();
    const doc: OutputTemplate = { id: genId(), name: str(r.name) || '새 양식', audience: str(r.audience) === 'student' ? 'student' : 'teacher', columns: validColumns(arr<string>(r.columns)), summaryColumns: cleanSummaryColumns(r.summaryColumns), headerNote: str(r.headerNote), footerNote: str(r.footerNote), ...newMeta(user, at) };
    store.insert('template', doc);
    reply.code(201);
    return doc;
  });

  // ── 학습목표 ──
  app.get('/api/objectives', async (req) => {
    requireUser(req);
    return store.list<LearningObjective>('objective').sort((a, b) => a.code.localeCompare(b.code));
  });

  const normalizeObjective = (r: Record<string, unknown>, existing?: LearningObjective) => {
    const code = str(r.code).trim();
    const title = str(r.title).trim();
    if (!code || !title) throw new HttpError(400, '목표 코드와 제목은 필수입니다.');
    const prereq = arr<string>(r.prerequisiteObjectiveIds);
    return {
      id: existing?.id ?? genId(),
      code,
      title,
      subject: str(r.subject) || '기타',
      schoolLevel: (['초', '중', '고', '공통'].includes(str(r.schoolLevel)) ? str(r.schoolLevel) : '공통') as LearningObjective['schoolLevel'],
      grade: str(r.grade),
      description: str(r.description),
      prerequisiteObjectiveIds: prereq,
      prerequisiteVerified: bool(r.prerequisiteVerified, false),
      verificationNote: str(r.verificationNote),
    };
  };

  app.post('/api/objectives', async (req, reply) => {
    const user = requireAdmin(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const at = ctx.now();
    const doc: LearningObjective = { ...normalizeObjective(r), ...newMeta(user, at, bool(r.isSample, false)) };
    store.insert('objective', doc);
    reply.code(201);
    return doc;
  });

  app.put('/api/objectives/:id', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<LearningObjective>('objective', id);
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const doc: LearningObjective = touched({ ...existing, ...normalizeObjective(r, existing), archived: bool(r.archived, existing.archived) }, user, ctx.now());
    return store.update('objective', doc, version);
  });

  app.post('/api/objectives/:id/archive', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<LearningObjective>('objective', id);
    return store.update('objective', touched({ ...existing, archived: bool((req.body as Record<string, unknown>)?.archived, true) }, user, ctx.now()), existing.version);
  });

  // ── 샘플 데이터 관리 ──
  app.get('/api/samples', async (req) => {
    requireUser(req);
    return { count: store.countSamples() };
  });

  app.delete('/api/samples', async (req) => {
    const user = requireAdmin(req);
    const n = store.deleteSamples();
    store.audit({ at: ctx.now(), userId: user.id, kind: 'samples', docId: '-', action: 'delete', detail: `${n}건` });
    return { deleted: n };
  });
}
