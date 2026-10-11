import type { FastifyInstance } from 'fastify';
import type { Curriculum, CurriculumSession, CurriculumTextbookRef, SessionEntry, Textbook } from '@wb/shared';
import { autoAssemble, cloneCurriculum, curriculumTotals, renumber } from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, TEXT_LIMIT, arr, bool, expectVersion, genId, newMeta, num, requireAdmin, requireUser, str, touched } from '../context.ts';

const TRACKS = ['current', 'review', 'advance'];
const ACTIVITIES = ['new', 'practice', 'review', 'assessment', 'homework'];
const MODES = ['sequential', 'parallel', 'supplement'];

function normalizeEntry(raw: unknown, textbooks: Map<string, Textbook>): SessionEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const textbookId = str(r.textbookId);
  const itemId = str(r.itemId);
  const tb = textbooks.get(textbookId);
  if (!tb) throw new HttpError(400, `과정에 포함되지 않은 교재를 참조합니다: ${textbookId}`);
  const item = tb.items.find((i) => i.id === itemId);
  if (!item) throw new HttpError(400, `교재 '${tb.title}'에 없는 학습항목을 참조합니다: ${itemId}`);
  const portionRaw = r.portion as { from?: unknown; to?: unknown } | undefined;
  const portion = portionRaw && typeof portionRaw.from === 'number' && typeof portionRaw.to === 'number' ? { from: portionRaw.from, to: portionRaw.to } : undefined;
  const minutes = num(r.minutes, item.minutes);
  if (minutes <= 0) throw new HttpError(400, `'${item.title}' 배치 시간은 1분 이상이어야 합니다.`);
  return {
    id: str(r.id) || genId(),
    textbookId,
    itemId,
    track: TRACKS.includes(str(r.track)) ? (str(r.track) as SessionEntry['track']) : 'current',
    activity: ACTIVITIES.includes(str(r.activity)) ? (str(r.activity) as SessionEntry['activity']) : 'new',
    minutes,
    portion,
    fraction: typeof r.fraction === 'number' ? r.fraction : undefined,
    repeatPurpose: ['review', 'deepen', 'assessment'].includes(str(r.repeatPurpose)) ? (str(r.repeatPurpose) as SessionEntry['repeatPurpose']) : undefined,
    note: str(r.note) || undefined,
  };
}

export function normalizeCurriculum(raw: unknown, store: AppContext['store'], existing?: Curriculum) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const title = str(r.title).trim();
  if (!title) throw new HttpError(400, '과정명은 필수입니다.');
  const refs: CurriculumTextbookRef[] = arr<Record<string, unknown>>(r.textbooks).map((x) => {
    const tb = store.get<Textbook>('textbook', str(x.textbookId));
    if (!tb) throw new HttpError(400, `교재를 찾을 수 없습니다: ${str(x.textbookId)}`);
    return {
      textbookId: tb.id,
      edition: tb.edition,
      textbookVersion: tb.version,
      role: ['main', 'sub', 'supplement'].includes(str(x.role)) ? (str(x.role) as CurriculumTextbookRef['role']) : 'main',
      includedItemIds: Array.isArray(x.includedItemIds) ? (x.includedItemIds as string[]) : null,
      excludedItemIds: arr<string>(x.excludedItemIds),
    };
  });
  if (refs.length === 0) throw new HttpError(400, '교재를 1개 이상 선택하세요.');
  const textbooks = new Map(refs.map((ref) => [ref.textbookId, store.get<Textbook>('textbook', ref.textbookId)!]));
  const sessions: CurriculumSession[] = renumber(
    arr<Record<string, unknown>>(r.sessions).map((s, i) => ({
      id: str(s.id) || genId(),
      order: num(s.order, i + 1),
      title: str(s.title) || `${i + 1}차시`,
      entries: arr(s.entries).map((e) => normalizeEntry(e, textbooks)),
      marker: ['review', 'assessment', 'buffer'].includes(str(s.marker)) ? (str(s.marker) as CurriculumSession['marker']) : undefined,
    })),
  );
  const unassignedEntries = arr(r.unassignedEntries).map((e) => normalizeEntry(e, textbooks));
  const adv = r.advance as Record<string, unknown> | undefined;
  const advance: Curriculum['advance'] | undefined = adv
    ? {
        type: ['next_semester', 'next_grade', 'domain', 'vacation'].includes(str(adv.type)) ? (str(adv.type) as NonNullable<Curriculum['advance']>['type']) : 'next_semester',
        currentGrade: str(adv.currentGrade),
        actualStage: str(adv.actualStage),
        targetDescription: str(adv.targetDescription),
        targetDate: str(adv.targetDate),
        currentMinMinutes: num(adv.currentMinMinutes, 0),
        requiredObjectiveIds: arr<string>(adv.requiredObjectiveIds),
        prerequisitesConfirmed: bool(adv.prerequisitesConfirmed, false),
        prerequisitesConfirmedBy: str(adv.prerequisitesConfirmedBy) || undefined,
        prerequisitesConfirmedAt: str(adv.prerequisitesConfirmedAt) || undefined,
      }
    : undefined;
  return {
    id: existing?.id ?? genId(),
    title,
    subject: str(r.subject) || textbooks.values().next().value?.subject || '기타',
    target: str(r.target),
    goal: str(r.goal),
    textbooks: refs,
    compositionMode: MODES.includes(str(r.compositionMode)) ? (str(r.compositionMode) as Curriculum['compositionMode']) : 'sequential',
    sessions,
    unassignedEntries,
    recommendedPerWeek: num(r.recommendedPerWeek, 2),
    recommendedMinutesPerSession: num(r.recommendedMinutesPerSession, 60),
    reviewMinutesPerSession: num(r.reviewMinutesPerSession, 10),
    bufferMinutesPerSession: num(r.bufferMinutesPerSession, 5),
    assessmentEvery: num(r.assessmentEvery, 0),
    status: ['draft', 'reviewing', 'verified'].includes(str(r.status)) ? (str(r.status) as Curriculum['status']) : 'draft',
    origin: (str(r.origin) === 'recommended' ? 'recommended' : 'custom') as Curriculum['origin'],
    advance,
  };
}

function structuralKey(c: Pick<Curriculum, 'sessions' | 'textbooks' | 'unassignedEntries' | 'compositionMode'>): string {
  return JSON.stringify({ s: c.sessions, t: c.textbooks, u: c.unassignedEntries, m: c.compositionMode });
}

export function registerCurriculumRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  app.get('/api/curricula', async (req) => {
    requireUser(req);
    const includeArchived = (req.query as { archived?: string }).archived === '1';
    return store.list<Curriculum>('curriculum', { includeArchived }).map((c) => ({ ...c, totals: curriculumTotals(c) }));
  });

  app.get('/api/curricula/:id', async (req) => {
    requireUser(req);
    const c = store.mustGet<Curriculum>('curriculum', (req.params as { id: string }).id);
    return { ...c, totals: curriculumTotals(c) };
  });

  app.post('/api/curricula', async (req, reply) => {
    const user = requireAdmin(req);
    const at = ctx.now();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const base = normalizeCurriculum(body, store);
    const doc: Curriculum = { ...base, curriculumVersion: 1, reviewComments: [], ...newMeta(user, at, bool(body.isSample, false)) };
    store.insert('curriculum', doc);
    store.audit({ at, userId: user.id, kind: 'curriculum', docId: doc.id, action: 'create', detail: doc.title });
    reply.code(201);
    return doc;
  });

  app.put('/api/curricula/:id', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<Curriculum>('curriculum', id);
    const version = expectVersion(req.body);
    const base = normalizeCurriculum(req.body, store, existing);
    const body = req.body as Record<string, unknown>;
    let curriculumVersion = existing.curriculumVersion;
    let status = base.status;
    // 검증된 과정의 구조가 바뀌면 과정 버전을 올리고 검토 상태를 초안으로 되돌린다 (권장안을 가져왔다고 검증됨으로 표시하지 않음)
    if (existing.status === 'verified' && structuralKey(base) !== structuralKey(existing)) {
      curriculumVersion += 1;
      status = 'draft';
    }
    const doc: Curriculum = touched(
      {
        ...existing,
        ...base,
        id,
        status,
        curriculumVersion,
        reviewComments: existing.reviewComments,
        isSample: bool(body.isSample, existing.isSample),
        archived: bool(body.archived, existing.archived),
      },
      user,
      ctx.now(),
    );
    const saved = store.update('curriculum', doc, version);
    store.audit({ at: doc.updatedAt, userId: user.id, kind: 'curriculum', docId: id, action: 'update', detail: `${doc.title} v${doc.curriculumVersion}` });
    return saved;
  });

  /** 새 과정 버전 발행 (명시적 개정) */
  app.post('/api/curricula/:id/publish', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<Curriculum>('curriculum', id);
    // 발행은 '내가 검토한 내용'을 검증됨으로 표시하는 것이므로, 화면에서 본 버전이 지금 버전과 같아야 한다
    const version = expectVersion(req.body);
    const doc = touched({ ...existing, curriculumVersion: existing.curriculumVersion + 1, status: 'verified' as const }, user, ctx.now());
    const saved = store.update('curriculum', doc, version);
    store.audit({ at: doc.updatedAt, userId: user.id, kind: 'curriculum', docId: id, action: 'publish', detail: `v${doc.curriculumVersion}` });
    return saved;
  });

  app.post('/api/curricula/:id/archive', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<Curriculum>('curriculum', id);
    const archived = bool((req.body as Record<string, unknown>)?.archived, true);
    const doc = touched({ ...existing, archived }, user, ctx.now());
    const saved = store.update('curriculum', doc, existing.version);
    store.audit({ at: doc.updatedAt, userId: user.id, kind: 'curriculum', docId: id, action: archived ? 'archive' : 'restore', detail: doc.title });
    return saved;
  });

  app.post('/api/curricula/:id/clone', async (req, reply) => {
    const user = requireAdmin(req);
    const src = store.mustGet<Curriculum>('curriculum', (req.params as { id: string }).id);
    const at = ctx.now();
    const doc = cloneCurriculum(src, user.id, at);
    doc.isSample = src.isSample;
    store.insert('curriculum', doc);
    store.audit({ at, userId: user.id, kind: 'curriculum', docId: doc.id, action: 'clone', detail: `from ${src.id}` });
    reply.code(201);
    return doc;
  });

  /** 검토 의견 추가 (강사도 가능) */
  app.post('/api/curricula/:id/comments', async (req) => {
    const user = requireUser(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<Curriculum>('curriculum', id);
    const text = str((req.body as Record<string, unknown>)?.text).trim();
    if (!text) throw new HttpError(400, '의견 내용을 입력하세요.');
    // 의견은 모든 사람이 불러오는 과정 문서에 붙으므로 길이와 개수를 제한한다
    if (text.length > TEXT_LIMIT.comment) throw new HttpError(400, `의견은 ${TEXT_LIMIT.comment}자 이하로 입력하세요.`);
    if (existing.reviewComments.length >= 300) throw new HttpError(400, '이 과정의 의견이 너무 많습니다(300건). 과정을 복제해 새로 검토하세요.');
    const at = ctx.now();
    const doc = touched({ ...existing, reviewComments: [...existing.reviewComments, { id: genId(), at, by: user.displayName, text }] }, user, at);
    return store.update('curriculum', doc, existing.version);
  });

  /** 자동 구성 (저장하지 않고 차시 초안을 돌려준다) */
  app.post('/api/curricula/auto-assemble', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const refs: CurriculumTextbookRef[] = arr<Record<string, unknown>>(body.textbooks).map((x) => {
      const tb = store.get<Textbook>('textbook', str(x.textbookId));
      if (!tb) throw new HttpError(400, `교재를 찾을 수 없습니다: ${str(x.textbookId)}`);
      return {
        textbookId: tb.id,
        edition: tb.edition,
        textbookVersion: tb.version,
        role: ['main', 'sub', 'supplement'].includes(str(x.role)) ? (str(x.role) as CurriculumTextbookRef['role']) : 'main',
        includedItemIds: Array.isArray(x.includedItemIds) ? (x.includedItemIds as string[]) : null,
        excludedItemIds: arr<string>(x.excludedItemIds),
      };
    });
    const textbooks = new Map(refs.map((ref) => [ref.textbookId, store.get<Textbook>('textbook', ref.textbookId)!]));
    const mode = MODES.includes(str(body.compositionMode)) ? (str(body.compositionMode) as Curriculum['compositionMode']) : 'sequential';
    const result = autoAssemble(refs, textbooks, mode, {
      minutesPerSession: num(body.minutesPerSession, 60),
      reviewMinutes: num(body.reviewMinutes, 10),
      bufferMinutes: num(body.bufferMinutes, 5),
      assessmentEvery: num(body.assessmentEvery, 0),
      track: TRACKS.includes(str(body.track)) ? (str(body.track) as SessionEntry['track']) : 'current',
    });
    return { textbooks: refs, sessions: result.sessions, unassignedEntries: result.unassigned };
  });
}
