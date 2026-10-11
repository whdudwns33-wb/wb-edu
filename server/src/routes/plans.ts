import type { FastifyInstance } from 'fastify';
import type { Curriculum, HolidaySet, ISODate, LearningObjective, OutputTemplate, Plan, PlanSettings, PlanSnapshot, ProgressRecord, SessionUser, Textbook, UnderstandingCheck } from '@wb/shared';
import {
  addMakeupDay,
  advancePrerequisiteGaps,
  applySettingsAndReschedule,
  buildPlanViews,
  cancelLesson,
  confirmBlockers,
  continueAssignment,
  dayView,
  diffSchedule,
  excludeUnassigned,
  generateSchedule,
  isISODate,
  itemCompletionSummary,
  objectiveMap,
  overbookedLessons,
  pinAssignment,
  postponeLesson,
  remainingAfterRecord,
  rescheduleRemaining,
  scheduleStateOf,
  swapLessons,
  textbookProgress,
  todayKST,
  undoHistory,
  unpinAssignment,
  type OpResult,
  type ScheduleContext,
} from '@wb/shared';
import type { AppContext } from '../context.ts';
import { HttpError, arr, bool, expectVersion, genId, newMeta, num, requireUser, str, touched } from '../context.ts';
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
  const weekdays = arr<number>(r.weekdays ?? defaults?.weekdays).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  const makeup = arr<Record<string, unknown>>(r.makeupDays ?? defaults?.makeupDays);
  if (weekdays.length === 0 && makeup.length === 0) throw new HttpError(400, '수업 요일을 1개 이상 선택하세요.');
  const mode = str(r.mode, defaults?.mode ?? 'period') === 'pace' ? 'pace' : 'period';
  if (mode === 'period' && !endDate && !targetDate) throw new HttpError(400, '기간 우선 편성은 종료일 또는 목표 완료일이 필요합니다.');
  const minutesPerLesson = num(r.minutesPerLesson, defaults?.minutesPerLesson ?? 60);
  const reviewMinutes = num(r.reviewMinutes, defaults?.reviewMinutes ?? 0);
  const bufferMinutes = num(r.bufferMinutes, defaults?.bufferMinutes ?? 0);
  if (minutesPerLesson <= 0) throw new HttpError(400, '회당 수업시간은 1분 이상이어야 합니다.');
  if (reviewMinutes + bufferMinutes >= minutesPerLesson) throw new HttpError(400, '복습·여유 시간 합이 회당 수업시간 이상입니다. 새 진도 시간이 없습니다.');
  const month = num(r.academicYearStartMonth, defaults?.academicYearStartMonth ?? 3);
  const tr = (r.tracks ?? defaults?.tracks ?? {}) as Record<string, unknown>;
  const tracks: PlanSettings['tracks'] = {
    review: Math.max(0, num(tr.review, 0)),
    advance: Math.max(0, num(tr.advance, 0)),
    advanceWeekdays: Array.isArray(tr.advanceWeekdays) ? (tr.advanceWeekdays as number[]).filter((d) => Number.isInteger(d)) : null,
    currentMinMinutes: Math.max(0, num(tr.currentMinMinutes, 0)),
  };
  const dateList = (key: string, list: unknown) =>
    arr<Record<string, unknown>>(list).map((x): Record<string, unknown> => {
      const date = str(x.date);
      if (!isISODate(date)) throw new HttpError(400, `${key} 날짜 형식 오류: ${date}`);
      return { ...x, date };
    });
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
    holidaySetIds: arr<string>(r.holidaySetIds ?? defaults?.holidaySetIds),
    offDays: dateList('휴강', r.offDays ?? defaults?.offDays).map((x) => ({ id: str(x.id) || genId(), date: str(x.date), reason: str(x.reason) || '휴강', source: str(x.source) === 'holiday' ? 'holiday' : 'manual' })),
    makeupDays: dateList('보강', r.makeupDays ?? defaults?.makeupDays).map((x) => ({ id: str(x.id) || genId(), date: str(x.date), minutes: typeof x.minutes === 'number' ? x.minutes : undefined, note: str(x.note) })),
    fixedEvents: dateList('고정 일정', r.fixedEvents ?? defaults?.fixedEvents).map((x) => ({ id: str(x.id) || genId(), date: str(x.date), title: str(x.title) || '고정 일정', minutes: Math.max(0, num(x.minutes, 0)) })),
    maxDays: Math.min(1500, Math.max(30, num(r.maxDays, defaults?.maxDays ?? 400))),
  };
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
    const at = ctx.now();
    const settings = normalizeSettings(r.settings);
    const snapshot = buildSnapshot(store, curriculum, at);
    // 학습 범위 선택: 특정 차시 구간 또는 특정 항목만 (중간 지점부터 적용)
    const fromSession = num(r.fromSessionOrder, 0);
    const toSession = num(r.toSessionOrder, 0);
    const onlyItemIds = arr<string>(r.includeItemIds);
    if (fromSession || toSession) snapshot.sessions = snapshot.sessions.filter((s) => (!fromSession || s.order >= fromSession) && (!toSession || s.order <= toSession));
    if (onlyItemIds.length) snapshot.sessions = snapshot.sessions.map((s) => ({ ...s, entries: s.entries.filter((e) => onlyItemIds.includes(e.itemId)) })).filter((s) => s.entries.length > 0);
    if (snapshot.sessions.length === 0) throw new HttpError(400, '선택한 범위에 학습항목이 없습니다.');
    if (snapshot.advance && !r.settings) settings.tracks.currentMinMinutes = snapshot.advance.currentMinMinutes;

    const res = generateSchedule(settings, { snapshot, holidayDates: holidayDatesFor(store, settings) });
    const plan: Plan = {
      id: genId(),
      title: str(r.title) || `${curriculum.title} 계획`,
      subject: curriculum.subject,
      target: str(r.target, curriculum.target),
      classOrStudentRef: str(r.classOrStudentRef),
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
      author: str(r.author, user.displayName),
      reviewer: str(r.reviewer),
      requiredObjectiveIds: arr<string>(r.requiredObjectiveIds),
      allowedUserIds: arr<string>(r.allowedUserIds),
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
    const settings = normalizeSettings(r.settings);
    const snapshot = buildSnapshot(store, curriculum, ctx.now());
    const fromSession = num(r.fromSessionOrder, 0);
    const toSession = num(r.toSessionOrder, 0);
    if (fromSession || toSession) snapshot.sessions = snapshot.sessions.filter((s) => (!fromSession || s.order >= fromSession) && (!toSession || s.order <= toSession));
    const onlyItemIds = arr<string>(r.includeItemIds);
    if (onlyItemIds.length) snapshot.sessions = snapshot.sessions.map((s) => ({ ...s, entries: s.entries.filter((e) => onlyItemIds.includes(e.itemId)) })).filter((s) => s.entries.length > 0);
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
        title: str(r.title, existing.title),
        target: str(r.target, existing.target),
        classOrStudentRef: str(r.classOrStudentRef, existing.classOrStudentRef),
        author: str(r.author, existing.author),
        reviewer: str(r.reviewer, existing.reviewer),
        requiredObjectiveIds: Array.isArray(r.requiredObjectiveIds) ? arr<string>(r.requiredObjectiveIds) : existing.requiredObjectiveIds,
        allowedUserIds: user.role === 'admin' && Array.isArray(r.allowedUserIds) ? arr<string>(r.allowedUserIds) : existing.allowedUserIds,
        archived: bool(r.archived, existing.archived),
        lessons: Array.isArray(r.lessonNotes)
          ? existing.lessons.map((l) => {
              const n = arr<Record<string, unknown>>(r.lessonNotes).find((x) => str(x.lessonId) === l.id);
              return n ? { ...l, note: str(n.note, l.note), checklist: str(n.checklist, l.checklist) } : l;
            })
          : existing.lessons,
      },
      user,
      ctx.now(),
    );
    return planResponse(store.update('plan', doc, version));
  });

  /** 스냅샷을 현재 과정·교재로 갱신 (초안만) */
  app.post('/api/plans/:id/refresh-snapshot', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    if (existing.status === 'confirmed') throw new HttpError(400, '확정된 계획은 사용한 교재 판본과 과정 버전을 보존합니다. 새 버전으로 계획을 다시 만드세요.');
    const curriculum = store.mustGet<Curriculum>('curriculum', existing.curriculumId);
    const at = ctx.now();
    const snapshot = buildSnapshot(store, curriculum, at);
    const planWith: Plan = { ...existing, snapshot };
    const res = applySettingsAndReschedule(planWith, ctxFor(store, planWith), existing.settings, { by: user.id, at });
    res.plan.history[res.plan.history.length - 1].description = `과정 v${curriculum.curriculumVersion}·교재 최신 판본으로 스냅샷을 갱신하고 재편성했습니다.`;
    const saved = store.update('plan', touched(res.plan, user, at), existing.version);
    return { ...planResponse(saved), diff: res.diff, warnings: res.warnings };
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
      throw new HttpError(400, (e as Error).message);
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
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const a = existing.assignments.find((x) => x.id === str(r.assignmentId));
    if (!a) throw new HttpError(400, '배정을 찾을 수 없습니다.');
    const status = str(r.status);
    if (!['done', 'partial', 'not_done', 'excluded'].includes(status)) throw new HttpError(400, '상태 값이 올바르지 않습니다.');
    const lesson = existing.lessons.find((l) => l.id === a.lessonId)!;
    const cp = r.completedPortion as { from?: unknown; to?: unknown } | undefined;
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
      reason: str(r.reason),
      note: str(r.note),
      recordedAt: at,
      recordedBy: user.id,
    };
    if (status === 'excluded' && !rec.reason) throw new HttpError(400, '제외 사유를 입력하세요.');
    if (status === 'partial' && !rec.completedPortion && rec.completedFraction === undefined) throw new HttpError(400, '부분 완료는 완료한 범위 또는 비율이 필요합니다.');
    const doc: Plan = touched({ ...existing, records: [...existing.records, rec], history: [...existing.history, { id: genId(), at, by: user.id, action: 'record', description: `${lesson.date} 기록: ${status}` }] }, user, at);
    const saved = store.update('plan', doc, version);
    return { ...planResponse(saved), remaining: remainingAfterRecord(saved, a.id) };
  });

  app.post('/api/plans/:id/checks', async (req) => {
    const user = requireUser(req);
    const existing = mustAccess(user, store.mustGet<Plan>('plan', (req.params as { id: string }).id));
    const version = expectVersion(req.body);
    const r = req.body as Record<string, unknown>;
    const lesson = existing.lessons.find((l) => l.id === str(r.lessonId));
    if (!lesson) throw new HttpError(400, '수업을 찾을 수 없습니다.');
    const result = str(r.result);
    if (!['confirmed', 'needs_review', 'not_confirmed'].includes(result)) throw new HttpError(400, '결과 값이 올바르지 않습니다.');
    const at = ctx.now();
    const chk: UnderstandingCheck = { id: genId(), lessonId: lesson.id, itemId: str(r.itemId), textbookId: str(r.textbookId), objectiveIds: arr<string>(r.objectiveIds), result: result as UnderstandingCheck['result'], note: str(r.note), checkedAt: at, checkedBy: user.id };
    const doc: Plan = touched({ ...existing, understandingChecks: [...existing.understandingChecks, chk] }, user, at);
    return planResponse(store.update('plan', doc, version));
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
    return planResponse(store.update('plan', doc, version));
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
      unassigned: src.unassigned.map((u) => ({ ...u, id: genId() })),
      records: [],
      understandingChecks: [],
      status: 'draft',
      planVersion: 1,
      confirmedAt: undefined,
      confirmedBy: undefined,
      history: [{ id: genId(), at, by: user.id, action: 'create', description: `'${src.title}' 복제 (학생정보·완료 기록 제외)` }],
      allowedUserIds: [],
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
    const buf = await buildWorkbook(plan, { audience, levels, from: q.from, to: q.to, template });
    const fname = encodeURIComponent(`${plan.title}_v${plan.planVersion}_${audience === 'student' ? '학생용' : '강사용'}.xlsx`);
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
