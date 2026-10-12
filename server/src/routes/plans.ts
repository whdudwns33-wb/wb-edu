import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AppSettings, Curriculum, CurriculumTextbookRef, HolidaySet, ISODate, LearningObjective, OutputTemplate, Plan, PlanSettings, PlanSnapshot, ProgressRecord, SessionUser, Textbook, UnderstandingCheck } from '@wb/shared';
import {
  addMakeupDay,
  autoAssemble,
  advancePrerequisiteGaps,
  applySettingsAndReschedule,
  buildPlanViews,
  cancelLesson,
  confirmBlockers,
  continueAssignment,
  dayView,
  diffDays,
  diffSchedule,
  excludeUnassigned,
  extraLabelMap,
  generateSchedule,
  isISODate,
  itemCompletionSummary,
  objectiveMap,
  overbookedLessons,
  planToIcal,
  pinAssignment,
  postponeLesson,
  remainingAfterRecord,
  rescheduleRemaining,
  scheduleStateOf,
  supplementSuggestion,
  swapLessons,
  textbookProgress,
  todayKST,
  undoHistory,
  unpinAssignment,
  type OpResult,
  type ScheduleContext,
} from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, TEXT_LIMIT, arr, bool, expectVersion, genId, newMeta, num, requireAdmin, requireUser, safeFileName, str, text, touched } from '../context.ts';

/** 계획 기간 상한 (약 3년). 기간 우선·목표일·보강일 모두에 적용 */
const MAX_PLAN_DAYS = 1100;
import { buildWorkbook, type Level } from '../export.ts';

// ──────────────────────────────────────────────
// 보조
// ──────────────────────────────────────────────

export function canAccessPlan(user: SessionUser, plan: Plan): boolean {
  if (user.role === 'admin') return true;
  return plan.createdBy === user.id || plan.allowedUserIds.includes(user.id);
}

function mustAccess(user: SessionUser, plan: Plan): Plan {
  if (!canAccessPlan(user, plan)) throw new HttpError(403, '이 계획에 접근할 권한이 없습니다.');
  return plan;
}

export function buildSnapshot(store: AppContext['store'], curriculum: Curriculum, at: string): PlanSnapshot {
  // 교재를 고친 뒤 과정이 없어진 항목·교재를 가리키면, 계획이 없는 항목을 배정하게 되므로 만들지 않는다
  const tbs = new Map(curriculum.textbooks.map((ref) => [ref.textbookId, store.get<Textbook>('textbook', ref.textbookId)]));
  const missing = [...curriculum.sessions.flatMap((s) => s.entries), ...curriculum.unassignedEntries]
    .filter((e) => !tbs.get(e.textbookId)?.items.some((i) => i.id === e.itemId))
    .map((e) => `${tbs.get(e.textbookId)?.title ?? e.textbookId}: ${e.itemId}`);
  if (missing.length) throw new HttpError(400, `과정 '${curriculum.title}'이(가) 교재에 없는 학습항목을 가리킵니다. 과정을 열어 배치를 고친 뒤 다시 시도하세요.`, [...new Set(missing)].slice(0, 20));
  return {
    curriculumId: curriculum.id,
    curriculumTitle: curriculum.title,
    curriculumVersion: curriculum.curriculumVersion,
    compositionMode: curriculum.compositionMode,
    takenAt: at,
    sessions: structuredClone(curriculum.sessions),
    textbooks: curriculum.textbooks.map((ref) => {
      const tb = store.mustGet<Textbook>('textbook', ref.textbookId);
      return {
        id: tb.id,
        title: tb.title,
        edition: tb.edition,
        kind: tb.kind,
        publisher: tb.publisher,
        textbookVersion: tb.version,
        defaultUnit: tb.defaultUnit,
        pdfPageOffset: tb.pdfPageOffset,
        items: structuredClone(tb.items),
      };
    }),
    advance: curriculum.advance ? structuredClone(curriculum.advance) : undefined,
  };
}

export function holidayDatesFor(store: AppContext['store'], settings: PlanSettings): ISODate[] {
  const out: ISODate[] = [];
  for (const id of settings.holidaySetIds) {
    const hs = store.get<HolidaySet>('holidaySet', id);
    if (!hs) continue;
    for (const h of hs.holidays) if (h.enabled) out.push(h.date);
  }
  return out;
}

export function normalizeSettings(raw: unknown, defaults?: PlanSettings): PlanSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const startDate = str(r.startDate, defaults?.startDate ?? '');
  if (!isISODate(startDate)) throw new HttpError(400, '시작일 형식이 올바르지 않습니다 (YYYY-MM-DD).');
  const endDate = str(r.endDate, defaults?.endDate ?? '');
  if (endDate && !isISODate(endDate)) throw new HttpError(400, '종료일 형식이 올바르지 않습니다.');
  const targetDate = str(r.targetDate, defaults?.targetDate ?? '');
  if (targetDate && !isISODate(targetDate)) throw new HttpError(400, '목표 완료일 형식이 올바르지 않습니다.');
  if (endDate && endDate < startDate) throw new HttpError(400, '종료일은 시작일보다 뒤여야 합니다.');
  // 기간 상한: 아주 긴 기간(예: 1000~2999년)은 수업이 수십만 회가 되어 서버가 멈추고 문서가 수백 MB가 된다
  for (const [label, d] of [['종료일', endDate], ['목표 완료일', targetDate]] as const) {
    if (d && diffDays(startDate, d) > MAX_PLAN_DAYS) throw new HttpError(400, `${label}은 시작일로부터 ${MAX_PLAN_DAYS}일(약 3년) 안이어야 합니다.`);
  }
  const weekdays = arr<number>(r.weekdays ?? defaults?.weekdays).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const makeup = arr<Record<string, unknown>>(r.makeupDays ?? defaults?.makeupDays);
  if (weekdays.length === 0 && makeup.length === 0) throw new HttpError(400, '수업 요일을 1개 이상 선택하세요.');
  const mode = str(r.mode, defaults?.mode ?? 'period') === 'pace' ? 'pace' : 'period';
  if (mode === 'period' && !endDate && !targetDate) throw new HttpError(400, '기간 우선 편성은 종료일 또는 목표 완료일이 필요합니다.');
  const minutesPerLesson = num(r.minutesPerLesson, defaults?.minutesPerLesson ?? 60);
  const reviewMinutes = num(r.reviewMinutes, defaults?.reviewMinutes ?? 0);
  const bufferMinutes = num(r.bufferMinutes, defaults?.bufferMinutes ?? 0);
  if (minutesPerLesson <= 0 || minutesPerLesson > 600) throw new HttpError(400, '회당 수업시간은 1~600분이어야 합니다.');
  if (reviewMinutes < 0 || bufferMinutes < 0) throw new HttpError(400, '복습·여유 시간은 0분 이상이어야 합니다.');
  if (reviewMinutes + bufferMinutes >= minutesPerLesson) throw new HttpError(400, '복습·여유 시간 합이 회당 수업시간 이상입니다. 새 진도 시간이 없습니다.');
  const month = num(r.academicYearStartMonth, defaults?.academicYearStartMonth ?? 3);
  const tr = (r.tracks ?? defaults?.tracks ?? {}) as Record<string, unknown>;
  const tracks: PlanSettings['tracks'] = {
    review: Math.max(0, num(tr.review, 0)),
    advance: Math.max(0, num(tr.advance, 0)),
    advanceWeekdays: Array.isArray(tr.advanceWeekdays) ? (tr.advanceWeekdays as number[]).filter((d) => Number.isInteger(d)) : null,
    currentMinMinutes: Math.max(0, num(tr.currentMinMinutes, 0)),
  };
  const dateList = (key: string, list: unknown) => {
    const items = arr<unknown>(list);
    if (items.length > 1000) throw new HttpError(400, `${key}은(는) 1000개까지 넣을 수 있습니다.`);
    return items.map((raw): Record<string, unknown> => {
      if (!raw || typeof raw !== 'object') throw new HttpError(400, `${key} 항목 형식이 올바르지 않습니다.`);
      const x = raw as Record<string, unknown>;
      const date = str(x.date);
      if (!isISODate(date)) throw new HttpError(400, `${key} 날짜 형식 오류: ${String(date).slice(0, 20)}`);
      if (Math.abs(diffDays(startDate, date)) > MAX_PLAN_DAYS) throw new HttpError(400, `${key} 날짜 ${date}가 계획 기간에서 너무 멉니다.`);
      return { ...x, date };
    });
  };
  // 보강·고정 일정의 분: 음수나 아주 큰 값은 수업 가능 시간 계산을 망가뜨린다
  const eventMinutes = (key: string, v: unknown, allowZero: boolean): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < (allowZero ? 0 : 1) || v > 600) throw new HttpError(400, `${key} 시간은 ${allowZero ? 0 : 1}~600분이어야 합니다.`);
    return Math.round(v);
  };
  return {
    startDate,
    endDate,
    targetDate,
    weekdays: [...new Set(weekdays)].sort(),
    minutesPerLesson,
    reviewMinutes,
    bufferMinutes,
    mode,
    academicYearStartMonth: month >= 1 && month <= 12 ? month : 3,
    tracks,
    holidaySetIds: arr<unknown>(r.holidaySetIds ?? defaults?.holidaySetIds).filter((x): x is string => typeof x === 'string').slice(0, 20),
    offDays: dateList('휴강', r.offDays ?? defaults?.offDays).map((x) => ({ id: str(x.id).slice(0, 64) || genId(), date: str(x.date), reason: text(x.reason, TEXT_LIMIT.title, '휴강 사유') || '휴강', source: str(x.source) === 'holiday' ? 'holiday' : 'manual' })),
    makeupDays: dateList('보강', r.makeupDays ?? defaults?.makeupDays).map((x) => ({ id: str(x.id).slice(0, 64) || genId(), date: str(x.date), minutes: eventMinutes('보강', x.minutes, false), note: text(x.note, TEXT_LIMIT.title, '보강 메모') })),
    fixedEvents: dateList('고정 일정', r.fixedEvents ?? defaults?.fixedEvents).map((x) => ({ id: str(x.id).slice(0, 64) || genId(), date: str(x.date), title: text(x.title, TEXT_LIMIT.title, '고정 일정 이름') || '고정 일정', minutes: eventMinutes('고정 일정', x.minutes, true) ?? 0 })),
    maxDays: Math.min(1500, Math.max(30, num(r.maxDays, defaults?.maxDays ?? 400))),
  };
}

/**
 * 학습 범위 선택(특정 차시 구간·특정 항목)을 스냅샷에 적용한다.
 * 선택 범위 앞 차시에만 나오는 항목은 이미 배운 것으로 보고 기록해 둔다 (그 항목을 선수로 둔 뒤 항목이 막히지 않게).
 */
export function applySelection(snapshot: PlanSnapshot, sel: { fromSessionOrder?: number; toSessionOrder?: number; includeItemIds?: string[] }): PlanSnapshot {
  const from = sel.fromSessionOrder || 0;
  const to = sel.toSessionOrder || 0;
  const only = sel.includeItemIds ?? [];
  if (!from && !to && only.length === 0) return snapshot;
  const all = snapshot.sessions;
  let sessions = all.filter((s) => (!from || s.order >= from) && (!to || s.order <= to));
  if (only.length) sessions = sessions.map((s) => ({ ...s, entries: s.entries.filter((e) => only.includes(e.itemId)) })).filter((s) => s.entries.length > 0);
  const firstOrder = sessions.length ? Math.min(...sessions.map((s) => s.order)) : 0;
  // 선택 범위의 첫 차시보다 앞 차시의 새 학습·연습 배치 분량 (선수 조건 판단에서 배운 것으로 본다)
  const assumedDone = all
    .filter((s) => s.order < firstOrder)
    .flatMap((s) => s.entries)
    .filter((e) => e.activity === 'new' || e.activity === 'practice')
    .map((e) => ({ itemId: e.itemId, portion: e.portion, fraction: e.fraction }));
  return { ...snapshot, sessions, selection: { fromSessionOrder: from || undefined, toSessionOrder: to || undefined, includeItemIds: only.length ? only : undefined, assumedDone } };
}

function ctxFor(store: AppContext['store'], plan: Plan): ScheduleContext {
  return { snapshot: plan.snapshot, holidayDates: holidayDatesFor(store, plan.settings) };
}

/** 저장용 Plan 본문 (응답에는 스냅샷 포함) */
function planResponse(plan: Plan) {
  return { ...plan, blockers: confirmBlockers(plan), overbooked: overbookedLessons(plan) };
}

// ──────────────────────────────────────────────
// 라우트
// ──────────────────────────────────────────────

export function registerPlanRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  const listAccessible = (user: SessionUser, includeArchived = false) => store.list<Plan>('plan', { includeArchived }).filter((p) => canAccessPlan(user, p));

  app.get('/api/plans', async (req) => {
    const user = requireUser(req);
    const includeArchived = (req.query as { archived?: string }).archived === '1';
    return listAccessible(user, includeArchived).map((p) => ({
      id: p.id,
      title: p.title,
      subject: p.subject,
      target: p.target,
      status: p.status,
      planVersion: p.planVersion,
      curriculumTitle: p.snapshot.curriculumTitle,
      curriculumVersion: p.snapshot.curriculumVersion,
      startDate: p.settings.startDate,
      endDate: p.endDateComputed || p.settings.endDate,
      lessonCount: p.lessons.filter((l) => l.status === 'scheduled' || l.status === 'makeup').length,
      unassignedCount: p.unassigned.filter((u) => u.reason !== 'excluded').length,
      recordCount: p.records.length,
      updatedAt: p.updatedAt,
      isSample: p.isSample,
      archived: p.archived,
      createdBy: p.createdBy,
      version: p.version,
    }));
  });

  app.get('/api/plans/:id', async (req) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    return planResponse(plan);
  });

  /** 계획 만들기: 과정 선택 → 범위 선택 → 시작일·요일·시간 → 편성 */
  app.post('/api/plans', async (req, reply) => {
    const user = requireUser(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const curriculum = store.get<Curriculum>('curriculum', str(r.curriculumId));
    if (!curriculum) throw new HttpError(400, '표준과정을 선택하세요.');
    if (curriculum.archived) throw new HttpError(400, '보관된 과정으로는 계획을 만들 수 없습니다.');
    const at = ctx.now();
    const settings = normalizeSettings(r.settings);
    // 학습 범위 선택: 특정 차시 구간 또는 특정 항목만 (중간 지점부터 적용)
    const snapshot = applySelection(buildSnapshot(store, curriculum, at), { fromSessionOrder: num(r.fromSessionOrder, 0), toSessionOrder: num(r.toSessionOrder, 0), includeItemIds: arr<unknown>(r.includeItemIds).filter((x): x is string => typeof x === 'string') });
    if (snapshot.sessions.length === 0) throw new HttpError(400, '선택한 범위에 학습항목이 없습니다.');
    if (snapshot.advance && !r.settings) settings.tracks.currentMinMinutes = snapshot.advance.currentMinMinutes;

    const res = generateSchedule(settings, { snapshot, holidayDates: holidayDatesFor(store, settings) });
    const plan: Plan = {
      id: genId(),
      title: text(r.title, TEXT_LIMIT.title, '계획 이름') || `${curriculum.title} 계획`,
      subject: curriculum.subject,
      target: r.target === undefined ? curriculum.target : text(r.target, TEXT_LIMIT.title, '대상'),
      classOrStudentRef: text(r.classOrStudentRef, TEXT_LIMIT.title, '반·학생 표시'),
      curriculumId: curriculum.id,
      snapshot,
      settings,
      lessons: res.lessons,
      assignments: res.assignments,
      unassigned: res.unassigned,
      records: [],
      understandingChecks: [],
      status: 'draft',
      planVersion: 1,
      endDateComputed: res.endDateComputed,
      history: [{ id: genId(), at, by: user.id, action: 'generate', description: `자동 편성 (${settings.mode === 'period' ? '기간 우선' : '속도 우선'})${res.warnings.length ? ' · ' + res.warnings.join(' ') : ''}` }],
      author: r.author === undefined ? user.displayName : text(r.author, TEXT_LIMIT.title, '작성자'),
      reviewer: text(r.reviewer, TEXT_LIMIT.title, '검토자'),
      requiredObjectiveIds: arr<unknown>(r.requiredObjectiveIds).filter((x): x is string => typeof x === 'string').slice(0, 500),
      allowedUserIds: arr<unknown>(r.allowedUserIds).filter((x): x is string => typeof x === 'string').slice(0, 200),
      ...newMeta(user, at, bool(r.isSample, curriculum.isSample)),
    };
    store.insert('plan', plan);
    store.audit({ at, userId: user.id, kind: 'plan', docId: plan.id, action: 'create', detail: plan.title });
    reply.code(201);
    return { ...planResponse(plan), warnings: res.warnings };
  });

  /** 편성 미리보기 (저장하지 않음) */
  app.post('/api/plans/preview', async (req) => {
    requireUser(req);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const curriculum = store.get<Curriculum>('curriculum', str(r.curriculumId));
    if (!curriculum) throw new HttpError(400, '표준과정을 선택하세요.');
    if (curriculum.archived) throw new HttpError(400, '보관된 과정으로는 계획을 만들 수 없습니다.');
    const settings = normalizeSettings(r.settings);
    const snapshot = applySelection(buildSnapshot(store, curriculum, ctx.now()), { fromSessionOrder: num(r.fromSessionOrder, 0), toSessionOrder: num(r.toSessionOrder, 0), includeItemIds: arr<unknown>(r.includeItemIds).filter((x): x is string => typeof x === 'string') });
    const res = generateSchedule(settings, { snapshot, holidayDates: holidayDatesFor(store, settings) });
    return { lessons: res.lessons, assignments: res.assignments, unassigned: res.unassigned, endDateComputed: res.endDateComputed, warnings: res.warnings, shortageMinutes: res.shortageMinutes, snapshot };
  });

  /** 기본 정보 수정 (제목·대상·작성자·필수 목표·허용 강사) */
  app.put('/api/plans/:id', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const doc: Plan = touched(
      {
        ...existing,
        title: r.title === undefined ? existing.title : text(r.title, TEXT_LIMIT.title, '계획 이름') || existing.title,
        target: r.target === undefined ? existing.target : text(r.target, TEXT_LIMIT.title, '대상'),
        classOrStudentRef: r.classOrStudentRef === undefined ? existing.classOrStudentRef : text(r.classOrStudentRef, TEXT_LIMIT.title, '반·학생 표시'),
        author: r.author === undefined ? existing.author : text(r.author, TEXT_LIMIT.title, '작성자'),
        reviewer: r.reviewer === undefined ? existing.reviewer : text(r.reviewer, TEXT_LIMIT.title, '검토자'),
        requiredObjectiveIds: Array.isArray(r.requiredObjectiveIds) ? arr<unknown>(r.requiredObjectiveIds).filter((x): x is string => typeof x === 'string').slice(0, 500) : existing.requiredObjectiveIds,
        allowedUserIds: user.role === 'admin' && Array.isArray(r.allowedUserIds) ? arr<unknown>(r.allowedUserIds).filter((x): x is string => typeof x === 'string').slice(0, 200) : existing.allowedUserIds,
        archived: bool(r.archived, existing.archived),
        lessons: Array.isArray(r.lessonNotes)
          ? existing.lessons.map((l) => {
              const n = arr<unknown>(r.lessonNotes).find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && str((x as Record<string, unknown>).lessonId) === l.id);
              return n ? { ...l, note: n.note === undefined ? l.note : text(n.note, TEXT_LIMIT.note, '수업 메모'), checklist: n.checklist === undefined ? l.checklist : text(n.checklist, TEXT_LIMIT.note, '확인 사항') } : l;
            })
          : existing.lessons,
      },
      user,
      ctx.now(),
    );
    const saved = store.update('plan', doc, version);
    // 보관·이름·허용 강사 변경은 감사 로그에 남긴다
    const changes = [
      doc.archived !== existing.archived ? (doc.archived ? '보관' : '보관 해제') : '',
      doc.title !== existing.title ? `이름: ${existing.title} → ${doc.title}` : '',
      doc.allowedUserIds.join(',') !== existing.allowedUserIds.join(',') ? `허용 강사 ${existing.allowedUserIds.length}명 → ${doc.allowedUserIds.length}명` : '',
    ].filter(Boolean);
    if (changes.length) store.audit({ at: saved.updatedAt, userId: user.id, kind: 'plan', docId: saved.id, action: 'update', detail: changes.join(', ').slice(0, 500) });
    return planResponse(saved);
  });

  /** 스냅샷을 현재 과정·교재로 갱신 (초안만) */
  app.post('/api/plans/:id/refresh-snapshot', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    if (existing.status === 'confirmed') throw new HttpError(400, '확정된 계획은 사용한 교재 판본과 과정 버전을 보존합니다. 새 버전으로 계획을 다시 만드세요.');
    // 기록·고정이 있으면 새 과정 구조와 기존 진행을 안전하게 맞출 수 없으므로 막는다 (기록을 지우거나 잘못 연결하지 않기 위해)
    if (existing.records.length > 0 || existing.assignments.some((a) => a.locked)) {
      throw new HttpError(400, '실제 기록이나 고정 배정이 있는 계획은 스냅샷을 갱신할 수 없습니다. 계획을 복제한 뒤 복제본에서 갱신하거나 새 계획을 만드세요.');
    }
    const curriculum = store.mustGet<Curriculum>('curriculum', existing.curriculumId);
    const at = ctx.now();
    // 계획을 만들 때 고른 학습 범위를 다시 적용하고, 담당자의 선행 기초 확인은 그대로 둔다 (계획 단위의 선택이므로)
    const snapshot = applySelection(buildSnapshot(store, curriculum, at), existing.snapshot.selection ?? {});
    if (snapshot.sessions.length === 0) throw new HttpError(400, '갱신한 과정에서 이 계획의 학습 범위에 해당하는 차시가 없습니다. 새 계획을 만드세요.');
    const prevAdv = existing.snapshot.advance;
    if (snapshot.advance && prevAdv?.prerequisitesConfirmed) {
      snapshot.advance = { ...snapshot.advance, prerequisitesConfirmed: true, prerequisitesConfirmedBy: prevAdv.prerequisitesConfirmedBy, prerequisitesConfirmedAt: prevAdv.prerequisitesConfirmedAt };
    }
    // 새 스냅샷의 차시 구성으로 처음부터 다시 편성한다 (기존 수업 id 는 날짜 기준으로 보존)
    const res = generateSchedule(existing.settings, { snapshot, holidayDates: holidayDatesFor(store, existing.settings) }, existing.lessons);
    const before = scheduleStateOf(existing);
    const next: Plan = {
      ...existing,
      snapshot,
      lessons: res.lessons,
      assignments: res.assignments,
      unassigned: res.unassigned,
      endDateComputed: res.endDateComputed,
      planVersion: existing.planVersion + 1,
      history: [...existing.history, { id: genId(), at, by: user.id, action: 'reschedule', description: `과정 v${curriculum.curriculumVersion}·교재 최신 판본으로 스냅샷을 갱신하고 다시 편성했습니다.`, before }],
    };
    const saved = store.update('plan', touched(next, user, at), version);
    return { ...planResponse(saved), diff: diffSchedule(before, scheduleStateOf(saved)), warnings: res.warnings };
  });

  /** 일정 수정 연산 (dryRun 이면 비교만 돌려주고 저장하지 않는다) */
  app.post('/api/plans/:id/ops', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const r = (req.body ?? {}) as Record<string, unknown>;
    const op = str(r.op);
    const p = (r.params ?? {}) as Record<string, unknown>;
    const dryRun = bool(r.dryRun, false);
    const at = ctx.now();
    const meta = { by: user.id, at };
    const sctx = ctxFor(store, existing);
    let result: OpResult;
    try {
      switch (op) {
        case 'reschedule': {
          const from = str(p.fromDate) || todayKST();
          if (!isISODate(from)) throw new HttpError(400, '날짜 형식 오류');
          result = rescheduleRemaining(existing, sctx, from, meta);
          break;
        }
        case 'cancel_lesson':
          result = cancelLesson(existing, sctx, str(p.lessonId), str(p.reason), meta);
          break;
        case 'add_makeup': {
          const date = str(p.date);
          if (!isISODate(date)) throw new HttpError(400, '보강일 형식 오류');
          result = addMakeupDay(existing, sctx, date, typeof p.minutes === 'number' ? p.minutes : undefined, str(p.note), meta);
          break;
        }
        case 'postpone':
          result = postponeLesson(existing, sctx, str(p.lessonId), meta);
          break;
        case 'continue': {
          const rem = remainingAfterRecord(existing, str(p.assignmentId));
          if (!rem) throw new HttpError(400, '이어서 진행할 남은 범위가 없습니다. 부분 완료 기록을 먼저 입력하세요.');
          result = continueAssignment(existing, sctx, str(p.assignmentId), rem, meta);
          break;
        }
        case 'swap':
          result = swapLessons(existing, sctx, str(p.lessonIdA), str(p.lessonIdB), meta);
          break;
        case 'pin': {
          const date = str(p.date);
          if (!isISODate(date)) throw new HttpError(400, '날짜 형식 오류');
          result = pinAssignment(existing, sctx, str(p.assignmentId), date, meta);
          break;
        }
        case 'unpin':
          result = unpinAssignment(existing, str(p.assignmentId), meta);
          break;
        case 'exclude':
          result = excludeUnassigned(existing, str(p.unassignedId), str(p.reason), meta);
          break;
        case 'undo':
          result = undoHistory(existing, str(p.historyId), meta);
          break;
        case 'settings': {
          const settings = normalizeSettings(p.settings, existing.settings);
          const planWith: Plan = { ...existing, settings };
          result = applySettingsAndReschedule(existing, { snapshot: existing.snapshot, holidayDates: holidayDatesFor(store, planWith.settings) }, settings, meta);
          break;
        }
        default:
          throw new HttpError(400, `알 수 없는 연산: ${op}`);
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // 편성 규칙이 거절한 경우(한글 안내문을 가진 일반 Error)만 400 으로 알려 준다.
      // 그 밖의 예외(TypeError, DB 오류 등)는 내부 사정을 노출하지 않도록 500 처리로 넘긴다.
      if (e instanceof Error && e.constructor === Error && /[가-힣]/.test(e.message)) throw new HttpError(400, e.message);
      throw e;
    }
    if (dryRun) {
      return { diff: result.diff, warnings: result.warnings, description: result.description, preview: { lessons: result.plan.lessons, assignments: result.plan.assignments, unassigned: result.plan.unassigned } };
    }
    const version = expectVersion(r);
    const saved = store.update('plan', touched(result.plan, user, at), version);
    store.audit({ at, userId: user.id, kind: 'plan', docId: saved.id, action: op, detail: result.description });
    return { ...planResponse(saved), diff: result.diff, warnings: result.warnings, description: result.description };
  });

  /** 실제 진도 기록 (추가만 하며, 최신 기록이 유효) */
  app.post('/api/plans/:id/records', async (req) => {
    const user = requireUser(req);
    // 기록은 추가만 하므로, 다른 사람이 먼저 저장해 버전이 달라도 최신 계획에 그대로 덧붙인다 (자동 병합).
    // 서버에서 읽기~저장 사이에 await 가 없어 이 처리 안에서는 다른 저장이 끼어들지 않는다.
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const r = (req.body ?? {}) as Record<string, unknown>;
    const merged = typeof r.version === 'number' && r.version !== existing.version;
    const a = existing.assignments.find((x) => x.id === str(r.assignmentId));
    if (!a) throw new HttpError(merged ? 409 : 400, merged ? '다른 사용자가 일정을 바꿔 이 배정이 없어졌습니다. 새로 고친 뒤 다시 기록하세요.' : '배정을 찾을 수 없습니다.');
    const status = str(r.status);
    if (!['done', 'partial', 'not_done', 'excluded'].includes(status)) throw new HttpError(400, '상태 값이 올바르지 않습니다.');
    const lesson = existing.lessons.find((l) => l.id === a.lessonId);
    if (!lesson) throw new HttpError(409, '이 배정의 수업을 찾을 수 없습니다. 새로 고친 뒤 다시 기록하세요.');
    // 자동 병합은 '내가 본 배정'과 '지금 배정'이 같을 때만 한다.
    // 그사이 일정 재배치로 같은 배정 id 의 날짜·범위·시간이 바뀌었다면, 화면에서 본 것과 다른 수업에 기록이 붙으므로 거절한다.
    if (merged) {
      const ex = (r.expect ?? undefined) as { lessonId?: unknown; itemId?: unknown; from?: unknown; to?: unknown; minutes?: unknown } | undefined;
      const same =
        !!ex &&
        ex.lessonId === a.lessonId &&
        ex.itemId === a.itemId &&
        (ex.from ?? null) === (a.portion?.from ?? null) &&
        (ex.to ?? null) === (a.portion?.to ?? null) &&
        ex.minutes === a.minutes;
      if (!same) throw new HttpError(409, '다른 사용자가 그사이 이 배정의 날짜나 범위를 바꿨습니다. 새로 고쳐 바뀐 내용을 확인한 뒤 다시 기록하세요.');
    }
    const cp = r.completedPortion as { from?: unknown; to?: unknown } | undefined;
    if (status === 'partial' && cp && (cp.from !== undefined || cp.to !== undefined)) {
      // 완료 범위는 이 배정이 다루는 범위 안의 정수 구간이어야 한다 (뒤집힌 범위·바깥 범위는 '이어서 진행'을 망가뜨린다)
      const item = existing.snapshot.textbooks.find((t) => t.id === a.textbookId)?.items.find((i) => i.id === a.itemId);
      const span = a.portion ?? item?.range;
      const ok =
        Number.isInteger(cp.from) && Number.isInteger(cp.to) && (cp.from as number) <= (cp.to as number) && (!span || ((cp.from as number) >= span.from && (cp.to as number) <= span.to));
      if (!ok) throw new HttpError(400, span ? `완료 범위는 ${span.from}~${span.to} 안에서 시작 ≤ 끝인 정수로 입력하세요.` : '완료 범위는 시작 ≤ 끝인 정수로 입력하세요.');
    }
    const at = ctx.now();
    const rec: ProgressRecord = {
      id: genId(),
      assignmentId: a.id,
      lessonId: a.lessonId,
      date: lesson.date,
      status: status as ProgressRecord['status'],
      completedPortion: status === 'partial' && cp && typeof cp.from === 'number' && typeof cp.to === 'number' ? { from: cp.from, to: cp.to } : undefined,
      completedFraction: status === 'partial' && typeof r.completedFraction === 'number' ? Math.min(1, Math.max(0, r.completedFraction)) : undefined,
      actualMinutes: typeof r.actualMinutes === 'number' && r.actualMinutes > 0 && r.actualMinutes <= 600 ? Math.round(r.actualMinutes) : undefined,
      reason: text(r.reason, TEXT_LIMIT.title, '사유'),
      note: text(r.note, TEXT_LIMIT.note, '메모'),
      recordedAt: at,
      recordedBy: user.id,
    };
    if (status === 'excluded' && !rec.reason) throw new HttpError(400, '제외 사유를 입력하세요.');
    if (status === 'partial' && !rec.completedPortion && rec.completedFraction === undefined) throw new HttpError(400, '부분 완료는 완료한 범위 또는 비율이 필요합니다.');
    const doc: Plan = touched({ ...existing, records: [...existing.records, rec], history: [...existing.history, { id: genId(), at, by: user.id, action: 'record', description: `${lesson.date} 기록: ${status}` }] }, user, at);
    const saved = store.update('plan', doc, existing.version);
    // slim: 휴대폰처럼 응답의 계획 전체가 필요 없는 화면은 작은 응답만 받는다 (1년 계획이면 전체 응답이 1MB 안팎)
    if (bool(r.slim, false)) return { id: saved.id, version: saved.version, planVersion: saved.planVersion, recordId: rec.id, remaining: remainingAfterRecord(saved, a.id), merged };
    return { ...planResponse(saved), remaining: remainingAfterRecord(saved, a.id), merged };
  });

  app.post('/api/plans/:id/checks', async (req) => {
    const user = requireUser(req);
    // 이해 확인도 추가만 하므로 버전이 달라도 최신 계획에 덧붙인다 (자동 병합)
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const r = (req.body ?? {}) as Record<string, unknown>;
    const merged = typeof r.version === 'number' && r.version !== existing.version;
    const lesson = existing.lessons.find((l) => l.id === str(r.lessonId));
    if (!lesson) throw new HttpError(merged ? 409 : 400, merged ? '다른 사용자가 일정을 바꿔 이 수업이 없어졌습니다. 새로 고친 뒤 다시 기록하세요.' : '수업을 찾을 수 없습니다.');
    if (lesson.status !== 'scheduled' && lesson.status !== 'makeup') throw new HttpError(409, '휴강·취소된 수업에는 이해 확인을 기록할 수 없습니다.');
    const result = str(r.result);
    if (!['confirmed', 'needs_review', 'not_confirmed'].includes(result)) throw new HttpError(400, '결과 값이 올바르지 않습니다.');
    // 학습항목은 그 수업에 실제로 배정된 것이어야 하고, 교재·목표는 클라이언트 값이 아니라 배정·교재 스냅샷에서 가져온다
    const itemId = str(r.itemId);
    const asg = existing.assignments.find((x) => x.lessonId === lesson.id && x.itemId === itemId);
    if (!asg) throw new HttpError(merged ? 409 : 400, '이 수업에 배정되지 않은 학습항목입니다. 새로 고친 뒤 다시 기록하세요.');
    const item = existing.snapshot.textbooks.find((t) => t.id === asg.textbookId)?.items.find((i) => i.id === itemId);
    const allowedObjectives = new Set(item?.objectiveIds ?? []);
    const objectiveIds = arr<string>(r.objectiveIds).filter((o) => typeof o === 'string' && allowedObjectives.has(o));
    const at = ctx.now();
    const chk: UnderstandingCheck = { id: genId(), lessonId: lesson.id, itemId, textbookId: asg.textbookId, objectiveIds, result: result as UnderstandingCheck['result'], note: text(r.note, TEXT_LIMIT.note, '메모'), checkedAt: at, checkedBy: user.id };
    const doc: Plan = touched({ ...existing, understandingChecks: [...existing.understandingChecks, chk] }, user, at);
    const savedChk = store.update('plan', doc, existing.version);
    if (bool(r.slim, false)) return { id: savedChk.id, version: savedChk.version, planVersion: savedChk.planVersion, checkId: chk.id, merged };
    return { ...planResponse(savedChk), merged };
  });

  app.post('/api/plans/:id/confirm', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const blockers = confirmBlockers(existing);
    if (blockers.length) throw new HttpError(400, '확정할 수 없습니다.', blockers);
    const at = ctx.now();
    const doc: Plan = touched({ ...existing, status: 'confirmed', confirmedAt: at, confirmedBy: user.id, history: [...existing.history, { id: genId(), at, by: user.id, action: 'confirm', description: `계획 v${existing.planVersion} 확정 (과정 v${existing.snapshot.curriculumVersion}, 교재 판본 보존)` }] }, user, at);
    const saved = store.update('plan', doc, version);
    store.audit({ at, userId: user.id, kind: 'plan', docId: saved.id, action: 'confirm', detail: saved.title });
    return planResponse(saved);
  });

  app.post('/api/plans/:id/unconfirm', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const at = ctx.now();
    const doc: Plan = touched({ ...existing, status: 'draft', history: [...existing.history, { id: genId(), at, by: user.id, action: 'manual_edit', description: '확정 해제' }] }, user, at);
    const saved = store.update('plan', doc, version);
    store.audit({ at, userId: user.id, kind: 'plan', docId: saved.id, action: 'unconfirm', detail: saved.title });
    return planResponse(saved);
  });

  /** 복제: 학생정보·완료 기록·이해 확인·이력은 복제하지 않는다 */
  app.post('/api/plans/:id/clone', async (req, reply) => {
    const user = requireUser(req);
    const src = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const at = ctx.now();
    const idMap = new Map(src.lessons.map((l) => [l.id, genId()]));
    const lessons = src.lessons.map((l) => ({ ...l, id: idMap.get(l.id)!, note: '', checklist: '' }));
    const aMap = new Map(src.assignments.map((a) => [a.id, genId()]));
    const assignments = src.assignments.map((a) => ({ ...a, id: aMap.get(a.id)!, lessonId: idMap.get(a.lessonId) ?? a.lessonId, continuedFrom: a.continuedFrom ? aMap.get(a.continuedFrom) : undefined }));
    const plan: Plan = {
      ...structuredClone(src),
      id: genId(),
      title: `${src.title} (복제)`,
      classOrStudentRef: '',
      target: '',
      lessons,
      assignments,
      unassigned: src.unassigned.map((u) => ({ ...u, id: genId(), continuedFrom: u.continuedFrom ? aMap.get(u.continuedFrom) : undefined })),
      // 선행 기초 확인은 특정 학생에 대한 담당자 판단이므로 복제본은 새로 확인한다 (근거가 담긴 이력도 복제하지 않는다)
      snapshot: src.snapshot.advance ? { ...structuredClone(src.snapshot), advance: { ...src.snapshot.advance, prerequisitesConfirmed: false, prerequisitesConfirmedBy: undefined, prerequisitesConfirmedAt: undefined } } : structuredClone(src.snapshot),
      records: [],
      understandingChecks: [],
      status: 'draft',
      planVersion: 1,
      confirmedAt: undefined,
      confirmedBy: undefined,
      history: [{ id: genId(), at, by: user.id, action: 'create', description: `'${src.title}' 복제 (학생정보·완료 기록 제외)` }],
      allowedUserIds: [],
      calendarFeeds: undefined,
      ...newMeta(user, at, src.isSample),
    };
    store.insert('plan', plan);
    reply.code(201);
    return planResponse(plan);
  });

  // ── 보기·집계 ──

  app.get('/api/plans/:id/views', async (req) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const q = req.query as { from?: string; to?: string };
    const range = q.from && q.to && isISODate(q.from) && isISODate(q.to) ? { from: q.from, to: q.to } : undefined;
    return { views: buildPlanViews(plan, range), textbookProgress: textbookProgress(plan), items: itemCompletionSummary(plan) };
  });

  app.get('/api/plans/:id/objectives', async (req) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const q = req.query as { from?: string; to?: string };
    const range = q.from && q.to && isISODate(q.from) && isISODate(q.to) ? { from: q.from, to: q.to } : undefined;
    const objectives = store.list<LearningObjective>('objective');
    return { statuses: objectiveMap(plan, objectives, range), advanceGaps: advancePrerequisiteGaps(plan, objectives) };
  });

  app.get('/api/plans/:id/audit', async (req) => {
    const user = requireUser(req);
    mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    return store.auditFor('plan', (req.params as { id: string }).id);
  });

  app.get('/api/plans/:id/export.xlsx', async (req, reply) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const q = req.query as { audience?: string; levels?: string; from?: string; to?: string; template?: string };
    const levels = (q.levels ? q.levels.split(',') : ['year', 'quarter', 'month', 'week', 'day']).filter((l): l is Level => ['year', 'quarter', 'month', 'week', 'day'].includes(l));
    // 출력 양식: 지정되면 양식의 대상(강사/학생)과 열 선택을 따른다
    const template = q.template ? store.get<OutputTemplate>('template', q.template) : null;
    if (q.template && !template) throw new HttpError(400, '출력 양식을 찾을 수 없습니다.');
    const audience: 'teacher' | 'student' = template ? template.audience : q.audience === 'student' ? 'student' : 'teacher';
    const appSettings = store.get<AppSettings>('settings', 'app');
    const buf = await buildWorkbook(plan, { audience, levels, from: q.from, to: q.to, template, extraLabels: extraLabelMap(appSettings?.subjectFields) });
    const fname = encodeURIComponent(safeFileName(`${plan.title}_v${plan.planVersion}_${audience === "student" ? "학생용" : "강사용"}.xlsx`));
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
    return reply.send(buf);
  });

  /** 오늘(또는 지정일) 수업 — 휴대폰 화면용 */
  app.get('/api/today', async (req) => {
    const user = requireUser(req);
    const q = req.query as { date?: string };
    const date = q.date && isISODate(q.date) ? q.date : todayKST();
    const out = [] as Array<{ planId: string; planTitle: string; target: string; version: number; status: string; day: ReturnType<typeof dayView> }>;
    for (const p of listAccessible(user)) {
      for (const l of p.lessons) {
        if (l.date !== date) continue;
        out.push({ planId: p.id, planTitle: p.title, target: p.target, version: p.version, status: p.status, day: dayView(p, l) });
      }
    }
    return { date, lessons: out };
  });

  /** 달력 파일(.ics) 내보내기: 구글·애플·아웃룩 캘린더에서 '가져오기'로 사용 */
  /**
   * 캘린더 구독 (로그인 없이 비밀 주소로 연다). 캘린더 앱이 주기적으로 다시 받아 가므로 일정 변경이 자동 반영된다.
   * 주소를 모르면 열 수 없고, 폐기하거나 계획을 보관하면 404 가 된다.
   */
  app.get('/api/feeds/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    const token = file.endsWith('.ics') ? file.slice(0, -4) : file;
    if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return reply.code(404).send({ error: 'Not found' });
    const plan = store.listContaining<Plan>('plan', token).find((p) => p.calendarFeeds?.some((f) => f.token === token));
    const feed = plan?.calendarFeeds?.find((f) => f.token === token);
    if (!plan || !feed) return reply.code(404).send({ error: 'Not found' });
    // 주소를 만든 사람이 비활성화됐거나 이 계획의 접근 권한을 잃었으면 그 주소도 더는 열리지 않는다
    const creator = store.getUser(feed.createdBy);
    if (!creator || !creator.active || !canAccessPlan({ id: creator.id, username: creator.username, displayName: creator.displayName, role: creator.role }, plan)) {
      return reply.code(404).send({ error: 'Not found' });
    }
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return reply.send(planToIcal(plan, { audience: feed.audience }));
  });

  /** 캘린더 구독 주소 만들기 (계획에 접근할 수 있는 사람) */
  app.post('/api/plans/:id/calendar-feeds', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const audience = str(r.audience) === 'student' ? 'student' : 'teacher';
    const feeds = existing.calendarFeeds ?? [];
    if (feeds.length >= 10) throw new HttpError(400, '구독 주소는 계획마다 10개까지 만들 수 있습니다. 쓰지 않는 주소를 폐기하세요.');
    const at = ctx.now();
    const feed = { token: randomBytes(24).toString('base64url'), audience, createdAt: at, createdBy: user.id, label: str(r.label).slice(0, 40) || (audience === 'student' ? '학생·학부모용' : '강사용') } as const;
    const doc: Plan = touched({ ...existing, calendarFeeds: [...feeds, feed] }, user, at);
    store.audit({ at, userId: user.id, kind: 'plan', docId: existing.id, action: 'calendar_feed_create', detail: `${feed.label} (${audience})` });
    return planResponse(store.update('plan', doc, version));
  });

  /** 캘린더 구독 주소 폐기 */
  app.post('/api/plans/:id/calendar-feeds/revoke', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const token = str((req.body as Record<string, unknown>).token);
    const feeds = existing.calendarFeeds ?? [];
    if (!feeds.some((f) => f.token === token)) throw new HttpError(404, '구독 주소를 찾을 수 없습니다.');
    const at = ctx.now();
    const doc: Plan = touched({ ...existing, calendarFeeds: feeds.filter((f) => f.token !== token) }, user, at);
    store.audit({ at, userId: user.id, kind: 'plan', docId: existing.id, action: 'calendar_feed_revoke', detail: token.slice(0, 6) });
    return planResponse(store.update('plan', doc, version));
  });

  app.get('/api/plans/:id/calendar.ics', async (req, reply) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const q = req.query as { audience?: string; cancelled?: string };
    const body = planToIcal(plan, { audience: q.audience === 'student' ? 'student' : 'teacher', includeCancelled: q.cancelled === '1' });
    const fname = encodeURIComponent(safeFileName(`${plan.title}_v${plan.planVersion}.ics`));
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
    return reply.send(body);
  });

  /** 선수 학습 부족 시 보충 제안 (제안만, 확정은 담당자) */
  app.get('/api/plans/:id/supplement', async (req) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const objectives = store.list<LearningObjective>('objective');
    const textbooks = store.list<Textbook>('textbook');
    return { advance: plan.snapshot.advance ?? null, ...supplementSuggestion(plan, objectives, textbooks) };
  });

  /** 보충 제안에서 고른 항목으로 보충 과정 초안을 만든다 (표준과정은 관리자만 만든다) */
  app.post('/api/plans/:id/supplement-curriculum', async (req, reply) => {
    const user = requireAdmin(req);
    const plan = store.mustGet<Plan>('plan', (req.params as { id: string }).id);
    const r = (req.body ?? {}) as Record<string, unknown>;
    const picks = arr<Record<string, unknown>>(r.items).map((x) => ({ textbookId: str(x.textbookId), itemId: str(x.itemId) }));
    if (picks.length === 0) throw new HttpError(400, '보충할 학습항목을 1개 이상 고르세요.');
    const tbIds = [...new Set(picks.map((p) => p.textbookId))];
    const textbooks = new Map<string, Textbook>();
    for (const id of tbIds) {
      const tb = store.get<Textbook>('textbook', id);
      if (!tb) throw new HttpError(400, `교재를 찾을 수 없습니다: ${id}`);
      for (const p of picks.filter((x) => x.textbookId === id)) if (!tb.items.some((i) => i.id === p.itemId)) throw new HttpError(400, `교재 '${tb.title}'에 없는 학습항목입니다: ${p.itemId}`);
      textbooks.set(id, tb);
    }
    const refs: CurriculumTextbookRef[] = tbIds.map((id, i) => {
      const tb = textbooks.get(id)!;
      return { textbookId: id, edition: tb.edition, textbookVersion: tb.version, role: i === 0 ? 'main' : 'sub', includedItemIds: picks.filter((p) => p.textbookId === id).map((p) => p.itemId), excludedItemIds: [] };
    });
    const minutes = num(r.minutesPerSession, plan.settings.minutesPerLesson);
    const { sessions, unassigned } = autoAssemble(refs, textbooks, 'sequential', { minutesPerSession: minutes, reviewMinutes: plan.settings.reviewMinutes, bufferMinutes: plan.settings.bufferMinutes, assessmentEvery: 0, track: 'review' });
    const at = ctx.now();
    const doc: Curriculum = {
      id: genId(),
      title: str(r.title) || `[보충 제안] ${plan.title}`,
      subject: plan.subject,
      target: plan.target,
      goal: `선행 전 기초 보충: ${str(r.goal) || plan.snapshot.advance?.targetDescription || ''}`.trim(),
      textbooks: refs,
      compositionMode: 'sequential',
      sessions,
      unassignedEntries: unassigned,
      recommendedPerWeek: Math.max(1, plan.settings.weekdays.length),
      recommendedMinutesPerSession: minutes,
      reviewMinutesPerSession: plan.settings.reviewMinutes,
      bufferMinutesPerSession: plan.settings.bufferMinutes,
      assessmentEvery: 0,
      curriculumVersion: 1,
      status: 'draft',
      origin: 'custom',
      reviewComments: [{ id: genId(), at, by: user.displayName, text: `계획 '${plan.title}'의 선수 학습 부족 제안에서 만든 초안입니다. 검토 후 사용하세요.` }],
      ...newMeta(user, at, plan.isSample),
    };
    store.insert('curriculum', doc);
    store.audit({ at, userId: user.id, kind: 'curriculum', docId: doc.id, action: 'create_from_supplement', detail: `plan ${plan.id}` });
    reply.code(201);
    return doc;
  });

  /** 선행 과정의 기초 확인 (담당자 확정). 계획 스냅샷의 확인 여부만 바꾸고 과정 구조는 건드리지 않는다 */
  app.post('/api/plans/:id/advance-confirm', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    if (!existing.snapshot.advance) throw new HttpError(400, '선행 설정이 없는 계획입니다.');
    // 확정된 계획의 스냅샷은 보존한다 (확정 해제 후 바꾸게 한다)
    if (existing.status === 'confirmed') throw new HttpError(400, '확정된 계획입니다. 선행 기초 확인을 바꾸려면 먼저 확정을 해제하세요.');
    const confirmed = bool(r.confirmed, true);
    const note = str(r.note).trim();
    if (confirmed && !note) throw new HttpError(400, '확인 근거(예: 진단 결과, 이해 확인 기록)를 적어 주세요.');
    const at = ctx.now();
    const advance = { ...existing.snapshot.advance, prerequisitesConfirmed: confirmed, prerequisitesConfirmedBy: confirmed ? user.displayName : undefined, prerequisitesConfirmedAt: confirmed ? at : undefined };
    const doc: Plan = touched(
      {
        ...existing,
        snapshot: { ...existing.snapshot, advance },
        history: [...existing.history, { id: genId(), at, by: user.id, action: 'manual_edit', description: confirmed ? `선행 기초 확인: ${note}` : `선행 기초 확인 해제${note ? `: ${note}` : ''}` }],
      },
      user,
      at,
    );
    return planResponse(store.update('plan', doc, version));
  });

  /** 동시 편집 알림용 가벼운 버전 조회 (교재·과정·계획) */
  app.get('/api/versions/:kind/:id', async (req) => {
    const user = requireUser(req);
    const { kind, id } = req.params as { kind: string; id: string };
    if (!['textbook', 'curriculum', 'plan'].includes(kind)) throw new HttpError(400, '지원하지 않는 종류입니다.');
    const doc = store.mustGet<Plan>(kind as 'plan', id);
    if (kind === 'plan') mustAccess(user, doc);
    const by = store.getUser(doc.updatedBy);
    return { version: doc.version, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, updatedByName: by?.displayName ?? '알 수 없음' };
  });

  // dryRun 비교에 쓰는 보조 (현재 상태 요약)
  app.get('/api/plans/:id/state-summary', async (req) => {
    const user = requireUser(req);
    const plan = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const s = scheduleStateOf(plan);
    return diffSchedule(s, s);
  });
}
