import type { FastifyInstance } from 'fastify';
import type { LearningItem, Textbook } from '@wb/shared';
import { previewImport, isRangedUnit, PROGRESS_UNIT_LABEL } from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, arr, bool, expectVersion, genId, newMeta, num, requireAdmin, requireUser, str, touched } from '../context.ts';

const UNITS = Object.keys(PROGRESS_UNIT_LABEL);

export function normalizeItem(raw: unknown, idx: number): LearningItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const progressUnit = UNITS.includes(str(r.progressUnit)) ? (str(r.progressUnit) as LearningItem['progressUnit']) : 'page';
  const rangeRaw = r.range as { from?: unknown; to?: unknown } | undefined;
  let range: LearningItem['range'];
  if (rangeRaw && typeof rangeRaw.from === 'number' && typeof rangeRaw.to === 'number') {
    if (rangeRaw.to < rangeRaw.from) throw new HttpError(400, `${idx + 1}번 항목: 범위의 끝이 시작보다 작습니다.`);
    range = { from: rangeRaw.from, to: rangeRaw.to };
  }
  if (isRangedUnit(progressUnit) && !range) throw new HttpError(400, `${idx + 1}번 항목: ${PROGRESS_UNIT_LABEL[progressUnit]} 단위는 시작·끝 범위가 필요합니다.`);
  const title = str(r.title).trim();
  if (!title) throw new HttpError(400, `${idx + 1}번 항목: 제목이 비어 있습니다.`);
  const minutes = num(r.minutes, 0);
  if (minutes <= 0) throw new HttpError(400, `${idx + 1}번 항목(${title}): 예상 소요시간은 1분 이상이어야 합니다.`);
  const difficulty = num(r.difficulty, 0);
  const usage = ['class', 'homework', 'both'].includes(str(r.usage)) ? (str(r.usage) as LearningItem['usage']) : 'both';
  return {
    id: str(r.id) || genId(),
    unit: str(r.unit),
    subunit: str(r.subunit),
    order: num(r.order, idx + 1),
    title,
    objective: str(r.objective),
    objectiveIds: arr<string>(r.objectiveIds).filter((x) => typeof x === 'string'),
    progressUnit,
    range,
    quantity: Math.max(1, num(r.quantity, 1)),
    minutes,
    minutesSource: str(r.minutesSource) === 'estimated' ? 'estimated' : 'entered',
    difficulty: difficulty >= 1 && difficulty <= 5 ? (difficulty as LearningItem['difficulty']) : undefined,
    splittable: bool(r.splittable, true),
    prerequisiteItemIds: arr<string>(r.prerequisiteItemIds).filter((x) => typeof x === 'string'),
    usage,
    materials: str(r.materials) || undefined,
    teachingNote: str(r.teachingNote) || undefined,
    attachToItemId: str(r.attachToItemId) || undefined,
    excluded: bool(r.excluded, false),
    extra: typeof r.extra === 'object' && r.extra ? Object.fromEntries(Object.entries(r.extra as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {},
  };
}

export function normalizeTextbook(raw: unknown, existing?: Textbook): Omit<Textbook, keyof import('@wb/shared').AuditMeta> & { id: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const title = str(r.title).trim();
  if (!title) throw new HttpError(400, '교재명은 필수입니다.');
  const kind = str(r.kind) === 'inhouse' ? 'inhouse' : 'market';
  const items = arr(r.items).map((it, i) => normalizeItem(it, i));
  // 항목 id 중복·선수 참조 검사
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) throw new HttpError(400, `학습항목 id 중복: ${it.id}`);
    ids.add(it.id);
  }
  for (const it of items) {
    if (it.prerequisiteItemIds.includes(it.id)) throw new HttpError(400, `'${it.title}'은(는) 자기 자신을 선수 학습으로 가질 수 없습니다.`);
  }
  const verification = ['unverified', 'reviewing', 'verified'].includes(str(r.verification)) ? (str(r.verification) as Textbook['verification']) : 'unverified';
  const defaultUnit = UNITS.includes(str(r.defaultUnit)) ? (str(r.defaultUnit) as Textbook['defaultUnit']) : items[0]?.progressUnit ?? 'page';
  return {
    id: existing?.id ?? str(r.id) ?? genId(),
    kind,
    title,
    publisher: str(r.publisher),
    subject: str(r.subject) || '기타',
    schoolLevel: (['초', '중', '고', '공통'].includes(str(r.schoolLevel)) ? str(r.schoolLevel) : '공통') as Textbook['schoolLevel'],
    grade: str(r.grade),
    semester: str(r.semester),
    stage: str(r.stage),
    edition: str(r.edition),
    isbn: str(r.isbn) || undefined,
    sourceUrl: str(r.sourceUrl) || undefined,
    verification,
    usageNote: str(r.usageNote),
    pdfPageOffset: num(r.pdfPageOffset, 0),
    excludedRanges: arr<Record<string, unknown>>(r.excludedRanges).map((x) => ({
      id: str(x.id) || genId(),
      label: str(x.label),
      range: { from: num((x.range as Record<string, unknown>)?.from), to: num((x.range as Record<string, unknown>)?.to) },
    })),
    items,
    defaultUnit,
  };
}

export function registerTextbookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  app.get('/api/textbooks', async (req) => {
    requireUser(req);
    const includeArchived = (req.query as { archived?: string }).archived === '1';
    return store.list<Textbook>('textbook', { includeArchived });
  });

  app.get('/api/textbooks/:id', async (req) => {
    requireUser(req);
    return store.mustGet<Textbook>('textbook', (req.params as { id: string }).id);
  });

  app.post('/api/textbooks', async (req, reply) => {
    const user = requireAdmin(req);
    const at = ctx.now();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const base = normalizeTextbook(body);
    const doc: Textbook = { ...base, id: genId(), ...newMeta(user, at, bool(body.isSample, false)) };
    store.insert('textbook', doc);
    store.audit({ at, userId: user.id, kind: 'textbook', docId: doc.id, action: 'create', detail: doc.title });
    reply.code(201);
    return doc;
  });

  app.put('/api/textbooks/:id', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<Textbook>('textbook', id);
    const version = expectVersion(req.body);
    const base = normalizeTextbook(req.body, existing);
    const doc: Textbook = touched({ ...existing, ...base, id, isSample: bool((req.body as Record<string, unknown>).isSample, existing.isSample), archived: bool((req.body as Record<string, unknown>).archived, existing.archived) }, user, ctx.now());
    const saved = store.update('textbook', doc, version);
    store.audit({ at: doc.updatedAt, userId: user.id, kind: 'textbook', docId: id, action: 'update', detail: doc.title });
    return saved;
  });

  app.post('/api/textbooks/:id/archive', async (req) => {
    const user = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const existing = store.mustGet<Textbook>('textbook', id);
    const archived = bool((req.body as Record<string, unknown>)?.archived, true);
    const doc = touched({ ...existing, archived }, user, ctx.now());
    const saved = store.update('textbook', doc, existing.version);
    store.audit({ at: doc.updatedAt, userId: user.id, kind: 'textbook', docId: id, action: archived ? 'archive' : 'restore', detail: doc.title });
    return saved;
  });

  app.post('/api/textbooks/:id/clone', async (req, reply) => {
    const user = requireAdmin(req);
    const src = store.mustGet<Textbook>('textbook', (req.params as { id: string }).id);
    const at = ctx.now();
    const idMap = new Map<string, string>();
    const items = src.items.map((it) => {
      const nid = genId();
      idMap.set(it.id, nid);
      return { ...it, id: nid };
    });
    for (const it of items) {
      it.prerequisiteItemIds = it.prerequisiteItemIds.map((p) => idMap.get(p) ?? p);
      if (it.attachToItemId) it.attachToItemId = idMap.get(it.attachToItemId) ?? it.attachToItemId;
    }
    const doc: Textbook = { ...structuredClone(src), id: genId(), title: `${src.title} (복제)`, items, ...newMeta(user, at, src.isSample), verification: 'unverified' };
    store.insert('textbook', doc);
    store.audit({ at, userId: user.id, kind: 'textbook', docId: doc.id, action: 'clone', detail: `from ${src.id}` });
    reply.code(201);
    return doc;
  });

  /** 표 붙여넣기 미리보기 (저장하지 않음) */
  app.post('/api/textbooks/import-preview', async (req) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = str(body.text);
    const defaultUnit = UNITS.includes(str(body.defaultUnit)) ? (str(body.defaultUnit) as LearningItem['progressUnit']) : undefined;
    return previewImport(text, { defaultUnit, defaultMinutes: num(body.defaultMinutes, 0) || undefined });
  });
}
