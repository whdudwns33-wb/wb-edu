import type { FastifyInstance } from 'fastify';
import type { Curriculum, LearningItem, Plan, Textbook } from '@wb/shared';
import { MIN_DIFF_RATIO, MIN_SAMPLES, previewImport, isRangedUnit, PROGRESS_UNIT_LABEL, subtractRanges, timingSuggestions } from '@wb/shared';
import type { AppContext } from '../context.ts';
import { canAccessPlan } from './plans.ts';
import { HttpError, arr, bool, expectVersion, genId, newMeta, num, requireAdmin, requireUser, str, touched } from '../context.ts';

const UNITS = Object.keys(PROGRESS_UNIT_LABEL);

export function normalizeItem(raw: unknown, idx: number): LearningItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const progressUnit = UNITS.includes(str(r.progressUnit)) ? (str(r.progressUnit) as LearningItem['progressUnit']) : 'page';
  const rangeRaw = r.range as { from?: unknown; to?: unknown } | undefined;
  let range: LearningItem['range'];
  if (rangeRaw && typeof rangeRaw.from === 'number' && typeof rangeRaw.to === 'number') {
    if (!Number.isInteger(rangeRaw.from) || !Number.isInteger(rangeRaw.to) || rangeRaw.from < 0) throw new HttpError(400, `${idx + 1}번 항목: 범위는 0 이상의 정수여야 합니다.`);
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
    const unknown = it.prerequisiteItemIds.filter((p) => !ids.has(p));
    if (unknown.length) throw new HttpError(400, `'${it.title}'의 선수 학습에 이 교재에 없는 항목이 있습니다: ${unknown.join(', ')}`);
  }
  // 선수 관계가 돌고 돌면(가→나→가) 어느 항목도 먼저 배정할 수 없어, 편성에서 모두 '시간 부족'처럼 보인다
  const byId = new Map(items.map((it) => [it.id, it]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      const cycle = path.slice(path.indexOf(id)).concat(id).map((x) => byId.get(x)?.title ?? x);
      throw new HttpError(400, `선수 학습 관계가 순환합니다: ${cycle.join(' → ')}`);
    }
    state.set(id, 1);
    for (const p of byId.get(id)?.prerequisiteItemIds ?? []) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const it of items) visit(it.id, []);
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
    excludedRanges: arr<unknown>(r.excludedRanges).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((x) => ({
      id: str(x.id) || genId(),
      label: str(x.label),
      range: { from: num((x.range as Record<string, unknown>)?.from), to: num((x.range as Record<string, unknown>)?.to) },
    })),
    items,
    defaultUnit,
  };
}

/**
 * 교재를 고쳤을 때 이 교재를 쓰는 과정(보관 제외)과 맞는지 본다.
 *  - 막음: 과정이 쓰는 항목을 지움 / 과정의 배치 범위가 새 항목 범위를 벗어남 (그대로 두면 계획이 없는 항목을 배정하거나 진도가 100%를 넘는다)
 *  - 알림: 항목 범위가 넓어져 과정의 배치가 새 범위를 다 덮지 못함 (늘어난 쪽은 과정을 고쳐야 배정된다)
 */
export function curriculumUsage(store: AppContext['store'], textbookId: string, items: LearningItem[]): { blockers: string[]; warnings: string[] } {
  const byId = new Map(items.map((it) => [it.id, it]));
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const c of store.list<Curriculum>('curriculum')) {
    if (!c.textbooks.some((ref) => ref.textbookId === textbookId)) continue;
    const entries = [...c.sessions.flatMap((s) => s.entries), ...c.unassignedEntries].filter((e) => e.textbookId === textbookId);
    const covered = new Map<string, Array<{ from: number; to: number }>>();
    for (const e of entries) {
      const it = byId.get(e.itemId);
      if (!it) {
        blockers.push(`과정 '${c.title}'이(가) 지우려는 항목(${e.itemId})을 씁니다.`);
        continue;
      }
      if (e.portion && it.range && (e.portion.from < it.range.from || e.portion.to > it.range.to)) {
        blockers.push(`과정 '${c.title}'의 '${it.title}' 배치(${e.portion.from}~${e.portion.to})가 새 범위(${it.range.from}~${it.range.to}) 밖입니다.`);
      }
      if (e.activity === 'new' && it.range) covered.set(it.id, [...(covered.get(it.id) ?? []), e.portion ?? it.range]);
    }
    for (const [itemId, rs] of covered) {
      const it = byId.get(itemId)!;
      const missing = subtractRanges(it.range!, rs);
      if (missing.length) warnings.push(`과정 '${c.title}'의 '${it.title}' 배치가 ${missing.map((r) => `${r.from}~${r.to}`).join(', ')}을(를) 다루지 않습니다. 과정에서 배치를 고치세요.`);
    }
  }
  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
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
    const { blockers, warnings } = curriculumUsage(store, id, base.items);
    if (blockers.length) throw new HttpError(400, '이 교재를 쓰는 과정과 맞지 않아 저장하지 않았습니다. 과정에서 해당 배치를 먼저 고치거나 빼세요.', blockers.slice(0, 30));
    const doc: Textbook = touched({ ...existing, ...base, id, isSample: bool((req.body as Record<string, unknown>).isSample, existing.isSample), archived: bool((req.body as Record<string, unknown>).archived, existing.archived) }, user, ctx.now());
    const saved = store.update('textbook', doc, version);
    store.audit({ at: doc.updatedAt, userId: user.id, kind: 'textbook', docId: id, action: 'update', detail: doc.title });
    return warnings.length ? { ...saved, warnings } : saved;
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

  /** 실제 소요시간 기반 예상 시간 개선 제안 (모든 계획의 완료 기록 중 실제 분이 있는 것) */
  app.get('/api/textbooks/:id/time-suggestions', async (req) => {
    const user = requireUser(req);
    const tb = store.mustGet<Textbook>('textbook', (req.params as { id: string }).id);
    // 강사는 자기가 볼 수 있는 계획의 기록만 집계한다 (관리자는 전체)
    const plans = store.list<Plan>('plan', { includeArchived: true }).filter((p) => p.snapshot.textbooks.some((t) => t.id === tb.id) && canAccessPlan(user, p));
    return { suggestions: timingSuggestions(tb.id, tb.items, plans), planCount: plans.length, rule: `완료 기록의 실제 분을 항목 전체 기준으로 환산한 중앙값. 기록 ${MIN_SAMPLES}건 이상이고 현재 값과 ${MIN_DIFF_RATIO * 100}% 이상 차이 날 때만 제안하며 자동 적용하지 않음.` };
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
