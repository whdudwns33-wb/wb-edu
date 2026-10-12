/**
 * 자동 편성 엔진 (순수 함수, 결정적).
 *
 * 규칙 요약
 *  - 한국 달력 실제 날짜를 사용한다. 한 달 = 4주 같은 고정 계산을 하지 않는다.
 *  - 수업일 = 시작일~종료일 중 수업 요일이면서 공휴일/휴강일이 아닌 날 + 보강일.
 *    공휴일·휴강에 걸린 수업 요일은 상태 'holiday'/'cancelled' 수업으로 남겨 월간 보기에 표시한다.
 *  - 회당 새 진도 가능시간 = 회당 수업시간 − 복습 − 여유 − 그날 고정 일정.
 *  - 트랙 배분: 현행 최소 확보시간을 먼저 보장하고, 복습·보충/선행 트랙은 설정한 회당 분 안에서 배정한다.
 *  - 같은 교재 안에서는 순서를 지킨다. 다른 교재 항목은 앞으로 당겨 배치할 수 있다(병행형).
 *  - 분할 가능 항목만 남은 시간에 맞춰 나눈다. 분할 불가 항목은 다음 수업으로 넘긴다.
 *  - 선수 학습 항목이 배정되지 않았으면 그 항목은 배정하지 않는다.
 *  - 숙제 활동은 수업시간을 쓰지 않는다 (별도 분량).
 *  - 같은 입력은 같은 결과를 낸다.
 */
import type {
  Assignment,
  ISODate,
  Lesson,
  LearningItem,
  Plan,
  PlanSettings,
  PlanSnapshot,
  ScheduleState,
  SessionEntry,
  Track,
  UnassignedEntry,
  UnassignedReason,
} from './types.ts';
import { addDays, eachDay, weekday, compareDates } from './dates.ts';
import { isRangedUnit, itemQuantity, rangeCount, splitRangeByMinutes, normalizeRanges, subtractRanges } from './units.ts';

// ──────────────────────────────────────────────
// 보조 타입
// ──────────────────────────────────────────────

/** 편성 대기열의 한 단위 (과정 차시 항목 또는 재편성 중인 기존 배정) */
export interface QueueEntry {
  sessionId: string;
  sessionOrder: number;
  entryId: string;
  textbookId: string;
  itemId: string;
  track: Track;
  activity: Assignment['activity'];
  minutes: number;
  portion?: { from: number; to: number };
  fraction?: number;
  continuedFrom?: string;
  repeatPurpose?: SessionEntry['repeatPurpose'];
  /** 기존 배정을 유지하며 재편성할 때 원래 id를 보존 */
  preserveId?: string;
}

export interface ScheduleContext {
  snapshot: PlanSnapshot;
  /** 적용 공휴일 날짜 */
  holidayDates: ISODate[];
  idGen?: () => string;
}

export interface ScheduleResult extends ScheduleState {
  warnings: string[];
  /** 부족한 총 분 (미배정 중 time_short 합계) */
  shortageMinutes: number;
}

export interface ScheduleDiff {
  affectedLessonDates: ISODate[];
  unassignedMinutesBefore: number;
  unassignedMinutesAfter: number;
  unassignedCountBefore: number;
  unassignedCountAfter: number;
  endDateBefore: ISODate | '';
  endDateAfter: ISODate | '';
  warnings: string[];
}

let idCounter = 0;
export function defaultIdGen(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  idCounter += 1;
  return `id-${Date.now().toString(36)}-${idCounter}`;
}

// ──────────────────────────────────────────────
// 항목 조회
// ──────────────────────────────────────────────

export function snapshotItemIndex(snapshot: PlanSnapshot): Map<string, { item: LearningItem; textbookId: string }> {
  const m = new Map<string, { item: LearningItem; textbookId: string }>();
  for (const tb of snapshot.textbooks) {
    for (const it of tb.items) m.set(it.id, { item: it, textbookId: tb.id });
  }
  return m;
}

function entryIsSplittable(entry: QueueEntry, item: LearningItem | undefined): boolean {
  if (!item) return false;
  if (!item.splittable) return false;
  if (isRangedUnit(item.progressUnit)) {
    const r = entry.portion ?? item.range;
    return rangeCount(r) >= 2;
  }
  return entry.minutes >= 10; // 수량형은 10분 이상일 때만 비율 분할
}

// ──────────────────────────────────────────────
// 수업일 생성
// ──────────────────────────────────────────────

export interface BuildLessonsOptions {
  settings: PlanSettings;
  holidayDates: ISODate[];
  /** 기존 수업 (id·상태 보존용) */
  existing?: Lesson[];
  /** 속도 우선일 때 탐색 종료일 */
  horizonEnd?: ISODate;
  idGen?: () => string;
  /**
   * 설정이 바뀌어도 반드시 남겨야 하는 수업 (완료 기록·고정 배정이 있는 수업).
   * 새 설정의 수업일이 아니게 되어도 그대로 두며, 새 진도는 더 넣지 않는다.
   */
  preserve?: Lesson[];
  /** preserve 수업마다 이미 쓰고 있는 분 (가능시간을 그만큼으로 줄여 새 진도가 들어가지 않게 한다) */
  preserveUsedMinutes?: Map<string, number>;
}

export function buildLessons(opts: BuildLessonsOptions): Lesson[] {
  const { settings, holidayDates } = opts;
  const idGen = opts.idGen ?? defaultIdGen;
  const existingByDate = new Map<string, Lesson>();
  for (const l of opts.existing ?? []) existingByDate.set(l.date, l);

  const holidaySet = new Set(holidayDates);
  const offByDate = new Map<string, string>();
  for (const o of settings.offDays) offByDate.set(o.date, o.reason);
  const makeupByDate = new Map(settings.makeupDays.map((m) => [m.date, m]));
  const fixedByDate = new Map<string, number>();
  for (const f of settings.fixedEvents) fixedByDate.set(f.date, (fixedByDate.get(f.date) ?? 0) + f.minutes);

  // 정규 수업일은 원래 종료일까지만 만든다
  const regularEnd: ISODate =
    settings.mode === 'period'
      ? settings.endDate || settings.targetDate || addDays(settings.startDate, settings.maxDays)
      : opts.horizonEnd ?? addDays(settings.startDate, settings.maxDays);
  // 종료일 이후의 보강일은 그 날짜만 수업일로 더한다 (사이의 정규 요일은 늘리지 않음)
  let end: ISODate = regularEnd;
  for (const m of settings.makeupDays) if (m.date > end && m.date >= settings.startDate) end = m.date;

  const weekdaySet = new Set(settings.weekdays);
  const out: Lesson[] = [];

  for (const date of eachDay(settings.startDate, end)) {
    const isClassDay = weekdaySet.has(weekday(date)) && date <= regularEnd;
    const makeup = makeupByDate.get(date);
    if (!isClassDay && !makeup) continue;

    const existing = existingByDate.get(date);
    const total = makeup?.minutes ?? settings.minutesPerLesson;
    const fixedMin = fixedByDate.get(date) ?? 0;

    let status: Lesson['status'] = 'scheduled';
    let note = existing?.note ?? '';
    if (makeup) {
      status = 'makeup';
      if (!note) note = makeup.note ? `보강: ${makeup.note}` : '보강';
    }
    if (offByDate.has(date)) {
      status = 'cancelled';
      note = offByDate.get(date) ?? '휴강';
    } else if (holidaySet.has(date) && !makeup) {
      status = 'holiday';
      if (!note) note = '공휴일';
    }
    // 휴강은 settings.offDays 가 기준이다 (휴강 처리 연산도 offDays 에 기록한다).
    // 휴강일을 설정에서 지우면 다시 수업이 되며, 휴강 사유였던 메모는 지운다.
    if (status === 'scheduled' && existing?.status === 'cancelled' && note === existing.note) note = '';

    const active = status === 'scheduled' || status === 'makeup';
    const review = active ? settings.reviewMinutes : 0;
    const buffer = active ? settings.bufferMinutes : 0;
    const available = active ? Math.max(0, total - review - buffer - fixedMin) : 0;

    out.push({
      id: existing?.id ?? idGen(),
      date,
      status,
      totalMinutes: active ? total : 0,
      availableMinutes: available,
      reviewMinutes: review,
      bufferMinutes: buffer,
      fixedMinutes: active ? fixedMin : 0,
      note,
      checklist: existing?.checklist ?? '',
    });
  }
  // 기록·고정이 있는 수업은 새 설정의 수업일이 아니어도 남긴다 (기록을 잃지 않기 위해)
  const outById = new Map(out.map((l) => [l.id, l]));
  for (const keep of opts.preserve ?? []) {
    const used = opts.preserveUsedMinutes?.get(keep.id) ?? 0;
    const now = outById.get(keep.id);
    // 새 설정에서도 수업이고 기록·고정 분량을 담을 수 있으면 새 값 그대로
    if (now && (now.status === 'scheduled' || now.status === 'makeup') && now.availableMinutes >= used) continue;
    const sameDate = out.findIndex((l) => l.date === keep.date);
    const kept: Lesson = {
      ...keep,
      status: keep.status === 'makeup' ? 'makeup' : 'scheduled',
      availableMinutes: Math.min(keep.availableMinutes, used),
      note: keep.note && keep.note.includes('설정 변경') ? keep.note : `${keep.note ? keep.note + ' · ' : ''}설정 변경 후에도 기록·고정 때문에 유지`,
    };
    if (sameDate >= 0) out.splice(sameDate, 1, kept);
    else out.push(kept);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 완료 기록이나 고정 배정이 있어 지워지면 안 되는 수업과, 각 수업에서 그 배정들이 쓰는 분 */
export function protectedLessons(plan: Plan): { lessons: Lesson[]; usedMinutes: Map<string, number> } {
  const recorded = recordedAssignmentIds(plan);
  const used = new Map<string, number>();
  for (const a of plan.assignments) {
    if (!(a.locked || recorded.has(a.id))) continue;
    used.set(a.lessonId, (used.get(a.lessonId) ?? 0) + (a.activity === 'homework' ? 0 : a.minutes));
  }
  return { lessons: plan.lessons.filter((l) => used.has(l.id)), usedMinutes: used };
}

/** buildLessons 를 계획에 맞게 호출 (기존 수업 id 보존 + 기록·고정 수업 보존) */
function rebuildLessonsFor(plan: Plan, settings: PlanSettings, ctx: ScheduleContext): Lesson[] {
  const prot = protectedLessons(plan);
  return buildLessons({
    settings,
    holidayDates: ctx.holidayDates,
    existing: plan.lessons,
    idGen: ctx.idGen,
    horizonEnd: settings.mode === 'pace' ? addDays(settings.startDate, settings.maxDays) : undefined,
    preserve: prot.lessons,
    preserveUsedMinutes: prot.usedMinutes,
  });
}

// ──────────────────────────────────────────────
// 대기열 구성
// ──────────────────────────────────────────────

/** 과정 스냅샷의 차시 항목을 순서대로 대기열로 만든다 (숙제 활동은 별도 분량이므로 제외) */
export function queueFromSnapshot(snapshot: PlanSnapshot): { queue: QueueEntry[]; homework: QueueEntry[] } {
  const queue: QueueEntry[] = [];
  const homework: QueueEntry[] = [];
  const sessions = [...snapshot.sessions].sort((a, b) => a.order - b.order);
  for (const s of sessions) {
    for (const e of s.entries) {
      const q: QueueEntry = {
        sessionId: s.id,
        sessionOrder: s.order,
        entryId: e.id,
        textbookId: e.textbookId,
        itemId: e.itemId,
        track: e.track,
        activity: e.activity,
        minutes: e.minutes,
        portion: e.portion ? { ...e.portion } : undefined,
        fraction: e.fraction,
        repeatPurpose: e.repeatPurpose,
      };
      if (e.activity === 'homework') homework.push(q);
      else queue.push(q);
    }
  }
  return { queue, homework };
}

export function queueEntryFromAssignment(a: Assignment, preserve = true): QueueEntry {
  return {
    sessionId: a.sessionId,
    sessionOrder: a.sessionOrder,
    entryId: a.entryId,
    textbookId: a.textbookId,
    itemId: a.itemId,
    track: a.track,
    activity: a.activity,
    minutes: a.minutes,
    portion: a.portion ? { ...a.portion } : undefined,
    fraction: a.fraction,
    continuedFrom: a.continuedFrom,
    repeatPurpose: a.repeatPurpose,
    preserveId: preserve ? a.id : undefined,
  };
}

export function queueEntryFromUnassigned(u: UnassignedEntry): QueueEntry {
  return {
    sessionId: u.sessionId,
    sessionOrder: u.sessionOrder,
    entryId: u.entryId,
    textbookId: u.textbookId,
    itemId: u.itemId,
    track: u.track,
    activity: u.activity,
    minutes: u.minutes,
    portion: u.portion ? { ...u.portion } : undefined,
    fraction: u.fraction,
    continuedFrom: u.continuedFrom,
  };
}

// ──────────────────────────────────────────────
// 채우기
// ──────────────────────────────────────────────

interface FillOptions {
  lessons: Lesson[];
  /** 채우기를 시작할 수업 index */
  startIndex: number;
  queue: QueueEntry[];
  /** 유지되는 배정 (고정·완료 기록 있음·시작 index 이전) */
  keep: Assignment[];
  settings: PlanSettings;
  snapshot: PlanSnapshot;
  idGen: () => string;
  /** 숙제 활동 항목 (수업시간 없이 차시에 붙임) */
  homework?: QueueEntry[];
}

interface FillResult {
  assignments: Assignment[];
  unassigned: UnassignedEntry[];
  warnings: string[];
  lastAssignedIndex: number;
}

/**
 * 선수 학습 충족 여부: 선수 항목이 (어느 수업에서든 더 이른 순서로) 전부 배정되어 있어야 한다.
 */
function makePrereqChecker(items: Map<string, { item: LearningItem; textbookId: string }>) {
  // itemId → 배정된 범위 (범위형) 또는 배정된 비율 합계
  const assignedRanges = new Map<string, { from: number; to: number }[]>();
  const assignedFraction = new Map<string, number>();

  function markAssigned(q: QueueEntry) {
    const info = items.get(q.itemId);
    if (!info) return;
    if (q.activity !== 'new' && q.activity !== 'practice') return; // 복습·평가는 선수 충족에 쓰지 않음
    if (isRangedUnit(info.item.progressUnit) && (q.portion ?? info.item.range)) {
      const r = q.portion ?? info.item.range!;
      const arr = assignedRanges.get(q.itemId) ?? [];
      arr.push({ ...r });
      assignedRanges.set(q.itemId, arr);
    } else {
      assignedFraction.set(q.itemId, (assignedFraction.get(q.itemId) ?? 0) + (q.fraction ?? 1));
    }
  }

  function fullyAssigned(itemId: string): boolean {
    const info = items.get(itemId);
    if (!info) return true; // 스냅샷에 없는 선수 항목은 무시
    if (isRangedUnit(info.item.progressUnit) && info.item.range) {
      const remaining = subtractRanges(info.item.range, assignedRanges.get(itemId) ?? []);
      return remaining.length === 0;
    }
    return (assignedFraction.get(itemId) ?? 0) >= 0.999;
  }

  function unmet(q: QueueEntry): string[] {
    const info = items.get(q.itemId);
    if (!info) return [];
    return info.item.prerequisiteItemIds.filter((p) => items.has(p) && !fullyAssigned(p));
  }

  return { markAssigned, unmet, fullyAssigned };
}

function fill(opts: FillOptions): FillResult {
  const { lessons, startIndex, settings, snapshot, idGen } = opts;
  const items = snapshotItemIndex(snapshot);
  const prereq = makePrereqChecker(items);
  const assignments: Assignment[] = [...opts.keep];
  const unassigned: UnassignedEntry[] = [];
  const warnings: string[] = [];

  // 유지 배정 반영
  const keepSorted = [...opts.keep].sort((a, b) => {
    const la = lessons.findIndex((l) => l.id === a.lessonId);
    const lb = lessons.findIndex((l) => l.id === b.lessonId);
    return la - lb || a.order - b.order;
  });
  for (const a of keepSorted) prereq.markAssigned(queueEntryFromAssignment(a));

  // 트랙별 대기열 (원래 순서 유지)
  const queues: Record<Track, QueueEntry[]> = { current: [], review: [], advance: [] };
  for (const q of opts.queue) queues[q.track].push(q);

  const keepMinutesByLesson = new Map<string, number>();
  const keepOrderByLesson = new Map<string, number>();
  for (const a of opts.keep) {
    if (a.activity !== 'homework') keepMinutesByLesson.set(a.lessonId, (keepMinutesByLesson.get(a.lessonId) ?? 0) + a.minutes);
    keepOrderByLesson.set(a.lessonId, Math.max(keepOrderByLesson.get(a.lessonId) ?? 0, a.order));
  }

  // 앞으로 남은 수업 중 최대 가능시간 (분할 불가 판정용)
  const maxBudgetAhead: number[] = new Array(lessons.length).fill(0);
  let running = 0;
  for (let i = lessons.length - 1; i >= 0; i--) {
    const l = lessons[i];
    const b = i >= startIndex ? Math.max(0, l.availableMinutes - (keepMinutesByLesson.get(l.id) ?? 0)) : 0;
    running = Math.max(running, b);
    maxBudgetAhead[i] = running;
  }

  let lastAssignedIndex = -1;
  let anyBudgetAhead = false;

  const takeFromQueue = (
    track: Track,
    lesson: Lesson,
    lessonIndex: number,
    budget: number,
    orderRef: { n: number },
  ): number => {
    const q = queues[track];
    let remaining = budget;
    const blockedTextbooks = new Set<string>();
    let i = 0;
    while (i < q.length && remaining > 0) {
      const entry = q[i];
      const info = items.get(entry.itemId);
      if (blockedTextbooks.has(entry.textbookId)) {
        i++;
        continue;
      }
      // 선수 학습 확인
      if (prereq.unmet(entry).length > 0) {
        blockedTextbooks.add(entry.textbookId);
        i++;
        continue;
      }
      const splittable = entryIsSplittable(entry, info?.item);

      if (entry.minutes <= remaining) {
        assignments.push(toAssignment(entry, lesson, orderRef.n++, idGen));
        prereq.markAssigned(entry);
        remaining -= entry.minutes;
        q.splice(i, 1);
        lastAssignedIndex = Math.max(lastAssignedIndex, lessonIndex);
        continue;
      }

      // 분할 불가 & 앞으로 어떤 수업에도 들어갈 수 없음
      if (!splittable && entry.minutes > maxBudgetAhead[lessonIndex]) {
        unassigned.push(toUnassigned(entry, 'unsplittable', `분할 불가 항목 ${entry.minutes}분 > 회당 최대 가능 ${maxBudgetAhead[lessonIndex]}분`, idGen));
        q.splice(i, 1);
        continue;
      }
      // 나눌 수 있어도 한 단위(쪽·문항) 분량이 앞으로 어떤 수업에도 들어가지 않으면 영영 배정되지 않는다
      if (splittable && info && isRangedUnit(info.item.progressUnit)) {
        const r = entry.portion ?? info.item.range;
        const perUnit = r ? Math.ceil(entry.minutes / Math.max(1, rangeCount(r))) : entry.minutes;
        if (perUnit > maxBudgetAhead[lessonIndex]) {
          unassigned.push(toUnassigned(entry, 'unsplittable', `한 단위 분량 ${perUnit}분 > 회당 최대 가능 ${maxBudgetAhead[lessonIndex]}분`, idGen));
          q.splice(i, 1);
          continue;
        }
      }

      if (splittable && remaining >= 5) {
        const split = splitEntry(entry, info!.item, remaining);
        if (split) {
          assignments.push(toAssignment(split.first, lesson, orderRef.n++, idGen));
          prereq.markAssigned(split.first);
          remaining -= split.first.minutes;
          q[i] = split.rest;
          lastAssignedIndex = Math.max(lastAssignedIndex, lessonIndex);
          // 나머지는 같은 교재이므로 이 수업에서는 더 진행하지 않음
          blockedTextbooks.add(entry.textbookId);
          i++;
          continue;
        }
      }
      // 이 수업에 넣지 못함 → 같은 교재의 뒤 항목도 이 수업에서는 건너뜀
      blockedTextbooks.add(entry.textbookId);
      i++;
    }
    return remaining;
  };

  for (let li = startIndex; li < lessons.length; li++) {
    const lesson = lessons[li];
    if (lesson.status !== 'scheduled' && lesson.status !== 'makeup') continue;
    if (queues.current.length + queues.review.length + queues.advance.length === 0) break;

    const budgetAll = Math.max(0, lesson.availableMinutes - (keepMinutesByLesson.get(lesson.id) ?? 0));
    if (budgetAll > 0) anyBudgetAhead = true;
    const orderRef = { n: (keepOrderByLesson.get(lesson.id) ?? 0) + 1 };

    const tr = settings.tracks;
    const advanceAllowedToday = tr.advanceWeekdays === null || tr.advanceWeekdays.includes(weekday(lesson.date));
    const hasCurrent = queues.current.length > 0;
    const currentMin = hasCurrent ? Math.min(tr.currentMinMinutes, budgetAll) : 0;

    let advanceBudget = queues.advance.length > 0 && advanceAllowedToday ? Math.min(tr.advance, Math.max(0, budgetAll - currentMin)) : 0;
    let reviewBudget = queues.review.length > 0 ? Math.min(tr.review, Math.max(0, budgetAll - currentMin - advanceBudget)) : 0;
    let currentBudget = budgetAll - advanceBudget - reviewBudget;

    // 현행 → 복습·보충 → 선행 순으로 채우고 남은 시간은 다음 트랙으로 넘긴다.
    let leftover = takeFromQueue('current', lesson, li, currentBudget, orderRef);
    reviewBudget += leftover;
    leftover = takeFromQueue('review', lesson, li, reviewBudget, orderRef);
    advanceBudget += leftover;
    if (advanceAllowedToday || queues.current.length === 0) {
      leftover = takeFromQueue('advance', lesson, li, advanceBudget, orderRef);
    }
    // 선행이 남긴 시간을 현행이 더 쓸 수 있게 한 번 더
    if (leftover > 0 && queues.current.length > 0) {
      takeFromQueue('current', lesson, li, leftover, orderRef);
    }
  }

  // 숙제: 수업시간을 쓰지 않고, 같은 과정 차시가 배정된 수업(또는 마지막 배정 수업)에 붙인다
  for (const hw of opts.homework ?? []) {
    const host = assignments
      .filter((a) => a.sessionId === hw.sessionId && a.activity !== 'homework')
      .sort((a, b) => lessonIndexOf(lessons, a.lessonId) - lessonIndexOf(lessons, b.lessonId))
      .pop();
    if (host) {
      const lesson = lessons.find((l) => l.id === host.lessonId)!;
      assignments.push(toAssignment(hw, lesson, (keepOrderByLesson.get(lesson.id) ?? 0) + 1000 + hw.sessionOrder, idGen));
    } else {
      unassigned.push(toUnassigned(hw, 'time_short', '해당 차시의 수업 항목이 배정되지 않아 숙제도 배정하지 못함 (수업 시간 부족 합계에는 넣지 않음)', idGen));
    }
  }

  // 남은 대기열 → 미배정 (사유 구분)
  // 선수 항목이 대기열 안에 남아 있으면(=시간 부족으로 함께 밀린 것) 근본 원인은 시간 부족이다.
  const pendingItemIds = new Set<string>();
  const allPending: QueueEntry[] = [];
  for (const track of ['current', 'review', 'advance'] as Track[]) for (const e of queues[track]) { pendingItemIds.add(e.itemId); allPending.push(e); }
  // 선수 항목이 계획 밖에 있거나(미배정 확정) 그 선수 항목 자체가 순서 제약으로 막힌 경우 → 연쇄적으로 순서 제약
  const blockedItems = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of allPending) {
      if (blockedItems.has(e.itemId)) continue;
      const un = prereq.unmet(e);
      if (un.some((p) => !pendingItemIds.has(p) || blockedItems.has(p))) {
        blockedItems.add(e.itemId);
        changed = true;
      }
    }
  }
  for (const track of ['current', 'review', 'advance'] as Track[]) {
    for (const entry of queues[track]) {
      const unmet = blockedItems.has(entry.itemId) ? prereq.unmet(entry) : [];
      let reason: UnassignedReason;
      let detail: string;
      if (unmet.length > 0) {
        reason = 'prerequisite';
        const names = unmet.map((id) => items.get(id)?.item.title ?? id).join(', ');
        detail = `선수 학습 미배정: ${names}`;
      } else if (!anyBudgetAhead && lessons.slice(startIndex).some((l) => (l.status === 'scheduled' || l.status === 'makeup') && l.fixedMinutes > 0)) {
        reason = 'fixed_conflict';
        detail = '남은 수업의 가능시간이 고정 일정으로 모두 소진됨';
      } else if (settings.mode === 'period' && !settings.endDate && settings.targetDate) {
        reason = 'target_exceeded';
        detail = `목표 완료일 ${settings.targetDate}까지 배정하지 못함 (${entry.minutes}분)`;
      } else {
        reason = 'time_short';
        detail = `총시간 부족 (${entry.minutes}분)`;
      }
      unassigned.push(toUnassigned(entry, reason, detail, idGen));
    }
  }

  return { assignments, unassigned, warnings, lastAssignedIndex };
}

function lessonIndexOf(lessons: Lesson[], lessonId: string): number {
  return lessons.findIndex((l) => l.id === lessonId);
}

function splitEntry(entry: QueueEntry, item: LearningItem, firstMinutes: number): { first: QueueEntry; rest: QueueEntry } | null {
  if (isRangedUnit(item.progressUnit)) {
    const range = entry.portion ?? item.range;
    if (!range) return null;
    const s = splitRangeByMinutes(range, entry.minutes, firstMinutes);
    if (!s) return null;
    return {
      first: { ...entry, portion: s.first, minutes: s.firstMinutes },
      rest: { ...entry, portion: s.rest, minutes: s.restMinutes, preserveId: undefined },
    };
  }
  // 수량형: 비율 분할 (5분 단위 반올림)
  const fm = Math.floor(firstMinutes / 5) * 5;
  if (fm < 5 || fm >= entry.minutes) return null;
  const totalFraction = entry.fraction ?? 1;
  const fr = (fm / entry.minutes) * totalFraction;
  return {
    first: { ...entry, minutes: fm, fraction: Number(fr.toFixed(4)) },
    rest: { ...entry, minutes: entry.minutes - fm, fraction: Number((totalFraction - fr).toFixed(4)), preserveId: undefined },
  };
}

function toAssignment(q: QueueEntry, lesson: Lesson, order: number, idGen: () => string): Assignment {
  return {
    id: q.preserveId ?? idGen(),
    lessonId: lesson.id,
    sessionId: q.sessionId,
    sessionOrder: q.sessionOrder,
    entryId: q.entryId,
    textbookId: q.textbookId,
    itemId: q.itemId,
    track: q.track,
    activity: q.activity,
    minutes: q.minutes,
    portion: q.portion ? { ...q.portion } : undefined,
    fraction: q.fraction,
    order,
    locked: false,
    continuedFrom: q.continuedFrom,
    repeatPurpose: q.repeatPurpose,
  };
}

function toUnassigned(q: QueueEntry, reason: UnassignedReason, detail: string, idGen: () => string): UnassignedEntry {
  return {
    id: idGen(),
    sessionId: q.sessionId,
    sessionOrder: q.sessionOrder,
    entryId: q.entryId,
    textbookId: q.textbookId,
    itemId: q.itemId,
    track: q.track,
    activity: q.activity,
    minutes: q.minutes,
    portion: q.portion ? { ...q.portion } : undefined,
    fraction: q.fraction,
    reason,
    detail,
    continuedFrom: q.continuedFrom,
  };
}

// ──────────────────────────────────────────────
// 전체 편성
// ──────────────────────────────────────────────

export function generateSchedule(settings: PlanSettings, ctx: ScheduleContext, existingLessons?: Lesson[]): ScheduleResult {
  const idGen = ctx.idGen ?? defaultIdGen;
  const { queue, homework } = queueFromSnapshot(ctx.snapshot);
  let lessons = buildLessons({ settings, holidayDates: ctx.holidayDates, existing: existingLessons, idGen });
  const result = fill({ lessons, startIndex: 0, queue, keep: [], settings, snapshot: ctx.snapshot, idGen, homework });
  const warnings = [...result.warnings];

  let endDateComputed: ISODate | '' = '';
  if (settings.mode === 'pace') {
    // 마지막 배정 수업까지만 남긴다 (최소 1수업)
    const lastIdx = Math.max(result.lastAssignedIndex, 0);
    lessons = lessons.slice(0, lastIdx + 1);
    endDateComputed = lessons.length ? lessons[lessons.length - 1].date : settings.startDate;
    if (settings.targetDate && endDateComputed > settings.targetDate) {
      warnings.push(`완료 예정일 ${endDateComputed}이(가) 목표 완료일 ${settings.targetDate}을(를) 넘습니다.`);
    }
    if (result.unassigned.some((u) => u.reason === 'time_short' && u.activity !== 'homework')) {
      warnings.push(`최대 탐색 기간(${settings.maxDays}일) 안에 전체 분량을 배정하지 못했습니다.`);
    }
  } else {
    endDateComputed = lastAssignedDate(lessons, result.assignments) || '';
    if (settings.targetDate && endDateComputed && endDateComputed > settings.targetDate) {
      warnings.push(`마지막 배정일 ${endDateComputed}이(가) 목표 완료일 ${settings.targetDate}을(를) 넘습니다.`);
    }
  }

  const shortageMinutes = classShortage(result.unassigned);
  if (shortageMinutes > 0) warnings.push(`새 진도 시간이 ${shortageMinutes}분 부족합니다.`);

  // 트랙 시간 합계 검증
  const tr = settings.tracks;
  if (tr.review + tr.advance + tr.currentMinMinutes > settings.minutesPerLesson - settings.reviewMinutes - settings.bufferMinutes) {
    warnings.push('트랙별 회당 배분 합계가 새 진도 가능시간을 넘습니다. 현행 최소시간을 우선 확보했습니다.');
  }

  return {
    lessons,
    assignments: result.assignments,
    unassigned: result.unassigned,
    settings,
    endDateComputed,
    warnings,
    shortageMinutes,
  };
}

export function lastAssignedDate(lessons: Lesson[], assignments: Assignment[]): ISODate | '' {
  const byId = new Map(lessons.map((l) => [l.id, l.date]));
  let last: ISODate | '' = '';
  for (const a of assignments) {
    const d = byId.get(a.lessonId);
    if (d && (!last || d > last)) last = d;
  }
  return last;
}

// ──────────────────────────────────────────────
// 계획 상태 보조
// ──────────────────────────────────────────────

export function scheduleStateOf(plan: Plan): ScheduleState {
  return {
    lessons: structuredClone(plan.lessons),
    assignments: structuredClone(plan.assignments),
    unassigned: structuredClone(plan.unassigned),
    settings: structuredClone(plan.settings),
    endDateComputed: plan.endDateComputed,
  };
}

export function applyState(plan: Plan, s: ScheduleState): Plan {
  return { ...plan, lessons: s.lessons, assignments: s.assignments, unassigned: s.unassigned, settings: s.settings, endDateComputed: s.endDateComputed };
}

export function recordedAssignmentIds(plan: Plan): Set<string> {
  return new Set(plan.records.map((r) => r.assignmentId));
}

/** 재편성으로 움직일 수 없는 배정: 완료 기록 있음 또는 고정 */
export function isImmovable(plan: Plan, a: Assignment, recorded: Set<string>): boolean {
  return a.locked || recorded.has(a.id);
}

/**
 * 선수 학습 순서 위반 목록: 어떤 배정의 선수 항목(새 학습·연습)이 그 배정보다 늦은 수업에 있으면 위반.
 * 같은 수업 안에서는 order 로 비교한다.
 */
export function prerequisiteViolations(lessons: Lesson[], assignments: Assignment[], snapshot: PlanSnapshot): string[] {
  const items = snapshotItemIndex(snapshot);
  const dateOf = new Map(lessons.map((l) => [l.id, l.date]));
  const pos = (a: Assignment) => `${dateOf.get(a.lessonId) ?? '9999-99-99'}#${String(a.order).padStart(4, '0')}`;
  const byItem = new Map<string, Assignment[]>();
  for (const a of assignments) {
    if (a.activity === 'homework') continue;
    byItem.set(a.itemId, [...(byItem.get(a.itemId) ?? []), a]);
  }
  const out: string[] = [];
  for (const a of assignments) {
    if (a.activity !== 'new' && a.activity !== 'practice') continue;
    const info = items.get(a.itemId);
    if (!info) continue;
    for (const p of info.item.prerequisiteItemIds) {
      const pre = (byItem.get(p) ?? []).filter((x) => x.activity === 'new' || x.activity === 'practice');
      if (pre.length === 0) continue;
      // 선수 항목의 마지막 조각이 이 배정의 첫 조각보다 뒤면 위반
      const lastPre = pre.map(pos).sort().pop()!;
      const mine = (byItem.get(a.itemId) ?? []).filter((x) => x.activity === 'new' || x.activity === 'practice').map(pos).sort()[0];
      if (lastPre > mine) {
        const msg = `'${info.item.title}'(${mine.slice(0, 10)})이(가) 선수 항목 '${items.get(p)?.item.title ?? p}'(${lastPre.slice(0, 10)})보다 앞섬`;
        if (!out.includes(msg)) out.push(msg);
      }
    }
  }
  return out;
}

export function unassignedMinutes(list: UnassignedEntry[]): number {
  return list.filter((u) => u.reason !== 'excluded').reduce((s, u) => s + u.minutes, 0);
}

export function diffSchedule(before: ScheduleState, after: ScheduleState, warnings: string[] = []): ScheduleDiff {
  const keyOf = (s: ScheduleState) => {
    const byDate = new Map(s.lessons.map((l) => [l.id, l.date]));
    const map = new Map<string, string>();
    for (const l of s.lessons) map.set(l.date, `${l.status}|`);
    for (const a of [...s.assignments].sort((x, y) => x.order - y.order)) {
      const d = byDate.get(a.lessonId);
      if (!d) continue;
      map.set(d, (map.get(d) ?? '') + `${a.itemId}:${a.portion?.from ?? ''}-${a.portion?.to ?? ''}:${a.minutes};`);
    }
    return map;
  };
  const kb = keyOf(before);
  const ka = keyOf(after);
  const dates = new Set([...kb.keys(), ...ka.keys()]);
  const affected = [...dates].filter((d) => kb.get(d) !== ka.get(d)).sort();
  return {
    affectedLessonDates: affected,
    unassignedMinutesBefore: unassignedMinutes(before.unassigned),
    unassignedMinutesAfter: unassignedMinutes(after.unassigned),
    unassignedCountBefore: before.unassigned.filter((u) => u.reason !== 'excluded').length,
    unassignedCountAfter: after.unassigned.filter((u) => u.reason !== 'excluded').length,
    endDateBefore: lastAssignedDate(before.lessons, before.assignments),
    endDateAfter: lastAssignedDate(after.lessons, after.assignments),
    warnings,
  };
}

// ──────────────────────────────────────────────
// 안전한 일정 수정 연산 (모두 새 Plan 을 반환하고 기록은 건드리지 않는다)
// ──────────────────────────────────────────────

export interface OpResult {
  plan: Plan;
  diff: ScheduleDiff;
  description: string;
  warnings: string[];
}

interface RefillArgs {
  plan: Plan;
  ctx: ScheduleContext;
  /** 이 index 부터 다시 채운다 */
  fromIndex: number;
  /** 추가로 맨 앞에 넣을 항목 */
  prepend?: QueueEntry[];
  /** 추가로 다시 붙일 숙제 (수업 시간을 쓰지 않음) */
  homeworkPrepend?: QueueEntry[];
  /** 이 수업(id)의 움직일 수 있는 배정은 제외하고 대기열에 넣는다 */
  excludeLessonIds?: Set<string>;
  lessonsOverride?: Lesson[];
}

/**
 * fromIndex 이후의 움직일 수 있는 배정과 미배정 항목을 원래 순서대로 대기열에 넣고 다시 채운다.
 * 완료 기록이 있는 배정과 고정 배정, fromIndex 이전 배정은 그대로 둔다.
 */
function refill(args: RefillArgs): { state: ScheduleState; warnings: string[] } {
  const { plan, ctx } = args;
  const idGen = ctx.idGen ?? defaultIdGen;
  const lessons = args.lessonsOverride ?? structuredClone(plan.lessons);
  const recorded = recordedAssignmentIds(plan);
  const lessonIdx = new Map(lessons.map((l, i) => [l.id, i]));

  const keep: Assignment[] = [];
  const movable: Assignment[] = [];
  for (const a of plan.assignments) {
    const idx = lessonIdx.get(a.lessonId);
    if (idx === undefined) {
      // 수업이 사라진 배정 (취소된 날짜 등) → 다시 배정 대상
      if (isImmovable(plan, a, recorded)) keep.push(a);
      else movable.push(a);
      continue;
    }
    if (idx < args.fromIndex || isImmovable(plan, a, recorded)) {
      keep.push(a);
    } else {
      movable.push(a);
    }
  }
  movable.sort((x, y) => {
    const ix = lessonIdx.get(x.lessonId) ?? Number.MAX_SAFE_INTEGER;
    const iy = lessonIdx.get(y.lessonId) ?? Number.MAX_SAFE_INTEGER;
    return ix - iy || x.order - y.order || x.sessionOrder - y.sessionOrder;
  });

  const queue: QueueEntry[] = [...(args.prepend ?? [])];
  const homework: QueueEntry[] = [...(args.homeworkPrepend ?? [])];
  for (const a of movable) {
    const q = queueEntryFromAssignment(a, true);
    if (a.activity === 'homework') homework.push(q);
    else queue.push(q);
  }
  // 기존 미배정 항목도 다시 시도 (제외 처리된 것은 제외)
  for (const u of plan.unassigned) {
    if (u.reason === 'excluded') continue;
    const q = queueEntryFromUnassigned(u);
    if (u.activity === 'homework') homework.push(q);
    else queue.push(q);
  }
  // 차시 순서로 안정 정렬 (prepend 는 맨 앞 유지)
  const pre = queue.slice(0, args.prepend?.length ?? 0);
  const rest = queue.slice(args.prepend?.length ?? 0);
  rest.sort((a, b) => a.sessionOrder - b.sessionOrder);

  const res = fill({
    lessons,
    startIndex: args.fromIndex,
    queue: [...pre, ...rest],
    keep,
    settings: plan.settings,
    snapshot: ctx.snapshot,
    idGen,
    homework,
  });
  const excluded = plan.unassigned.filter((u) => u.reason === 'excluded');
  const state: ScheduleState = {
    lessons,
    assignments: res.assignments,
    unassigned: [...res.unassigned, ...excluded],
    settings: structuredClone(plan.settings),
    endDateComputed: plan.settings.mode === 'pace' ? lastAssignedDate(lessons, res.assignments) || plan.endDateComputed : lastAssignedDate(lessons, res.assignments),
  };
  const warnings = [...res.warnings];
  const shortage = classShortage(res.unassigned);
  if (shortage > 0) warnings.push(`새 진도 시간이 ${shortage}분 부족합니다.`);
  // 유지한 배정(고정·기록)이 선수 항목으로 처리되므로, 재편성 뒤 선수 순서가 새로 어긋났는지 확인해 알린다
  const beforeViolations = new Set(prerequisiteViolations(plan.lessons, plan.assignments, ctx.snapshot));
  for (const v of prerequisiteViolations(lessons, res.assignments, ctx.snapshot)) if (!beforeViolations.has(v)) warnings.push(`선수 순서 확인 필요: ${v}`);
  const end = state.endDateComputed;
  if (plan.settings.targetDate && end && end > plan.settings.targetDate) warnings.push(`마지막 배정일 ${end}이(가) 목표 완료일을 넘습니다.`);
  if (plan.settings.endDate && end && end > plan.settings.endDate) warnings.push(`마지막 배정일 ${end}이(가) 종료일을 넘습니다.`);
  return { state, warnings };
}

/** 수업 시간 부족 합계 (숙제는 수업 시간을 쓰지 않으므로 뺀다) */
function classShortage(list: UnassignedEntry[]): number {
  return list.filter((u) => (u.reason === 'time_short' || u.reason === 'target_exceeded') && u.activity !== 'homework').reduce((s, u) => s + u.minutes, 0);
}

function finish(plan: Plan, before: ScheduleState, state: ScheduleState, warnings: string[], description: string, action: Plan['history'][number]['action'], by: string, at: string): OpResult {
  // 기록·고정 때문에 새 설정과 다르게 남긴 수업을 알린다
  const prevNote = new Map(plan.lessons.map((l) => [l.id, l.note]));
  for (const l of state.lessons) {
    if (l.note.includes('기록·고정 때문에 유지') && !(prevNote.get(l.id) ?? '').includes('기록·고정 때문에 유지')) {
      warnings = [...warnings, `${l.date} 수업은 새 설정과 맞지 않지만 완료 기록·고정 배정이 있어 그대로 두었습니다. 필요하면 기록·고정을 정리하세요.`];
    }
  }
  const next = applyState(plan, state);
  next.history = [
    ...plan.history,
    { id: defaultIdGen(), at, by, action, description, before },
  ];
  next.planVersion = plan.planVersion + 1;
  return { plan: next, diff: diffSchedule(before, state, warnings), description, warnings };
}

export interface OpMeta {
  by: string;
  at: string;
}

/** 남은 일정 전체 재편성 (fromDate 이후) */
export function rescheduleRemaining(plan: Plan, ctx: ScheduleContext, fromDate: ISODate, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  // 설정 변경을 반영해 수업일을 다시 만들되 기존 수업 id 는 보존
  const lessons = rebuildLessonsFor(plan, plan.settings, ctx);
  // fromDate 이후 수업이 없으면 다시 채울 수업이 없다 (처음부터 다시 채우지 않는다)
  const fromIndex = lessons.findIndex((l) => l.date >= fromDate);
  const idx = fromIndex === -1 ? lessons.length : fromIndex;
  const { state, warnings } = refill({ plan, ctx, fromIndex: idx, lessonsOverride: lessons });
  if (plan.settings.mode === 'pace') {
    const lastIdx = Math.max(state.lessons.findIndex((l) => l.date === state.endDateComputed), state.lessons.findIndex((l) => l.date >= fromDate), 0);
    state.lessons = state.lessons.slice(0, lastIdx + 1);
  }
  return finish(plan, before, state, warnings, `${fromDate} 이후 남은 일정을 재편성했습니다.`, 'reschedule', meta.by, meta.at);
}

/** 수업 취소(휴강) 후 남은 일정 재편성 */
export function cancelLesson(plan: Plan, ctx: ScheduleContext, lessonId: string, reason: string, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const recorded = recordedAssignmentIds(plan);
  const target = plan.lessons.find((l) => l.id === lessonId);
  if (!target) throw new Error('수업을 찾을 수 없습니다.');
  if (plan.assignments.some((a) => a.lessonId === lessonId && recorded.has(a.id))) {
    throw new Error('완료 기록이 있는 수업은 취소할 수 없습니다. 기록을 먼저 확인하세요.');
  }
  if (plan.assignments.some((a) => a.lessonId === lessonId && a.locked)) {
    throw new Error('이 날짜에 고정된 배정이 있어 휴강 처리할 수 없습니다. 고정을 해제하거나 다른 날짜로 고정한 뒤 다시 시도하세요.');
  }
  const settings = structuredClone(plan.settings);
  if (!settings.offDays.some((o) => o.date === target.date)) {
    settings.offDays.push({ id: defaultIdGen(), date: target.date, reason: reason || '휴강', source: 'manual' });
  }
  const planWithSettings: Plan = { ...plan, settings };
  const lessons = rebuildLessonsFor(plan, settings, ctx);
  const idx = lessons.findIndex((l) => l.id === lessonId);
  const { state, warnings } = refill({ plan: planWithSettings, ctx, fromIndex: idx, lessonsOverride: lessons });
  if (settings.mode === 'pace') {
    const lastIdx = Math.max(state.lessons.findIndex((l) => l.date === state.endDateComputed), idx, 0);
    state.lessons = state.lessons.slice(0, lastIdx + 1);
  }
  return finish(plan, before, state, warnings, `${target.date} 수업을 휴강 처리하고 이후 일정을 재편성했습니다. (${reason || '사유 없음'})`, 'cancel_lesson', meta.by, meta.at);
}

/** 보강일 추가 후 그 날부터 재편성 */
export function addMakeupDay(plan: Plan, ctx: ScheduleContext, date: ISODate, minutes: number | undefined, note: string, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const settings = structuredClone(plan.settings);
  if (settings.makeupDays.some((m) => m.date === date)) throw new Error('이미 보강일로 등록된 날짜입니다.');
  if (date < settings.startDate) throw new Error('보강일은 시작일 이후여야 합니다.');
  settings.makeupDays.push({ id: defaultIdGen(), date, minutes, note });
  settings.offDays = settings.offDays.filter((o) => o.date !== date);
  const planWithSettings: Plan = { ...plan, settings };
  const lessons = rebuildLessonsFor(plan, settings, ctx);
  const idx = lessons.findIndex((l) => l.date === date);
  if (idx < 0) throw new Error('보강일을 수업일로 만들지 못했습니다.');
  const { state, warnings } = refill({ plan: planWithSettings, ctx, fromIndex: idx, lessonsOverride: lessons });
  if (settings.mode === 'pace') {
    const lastIdx = Math.max(state.lessons.findIndex((l) => l.date === state.endDateComputed), idx, 0);
    state.lessons = state.lessons.slice(0, lastIdx + 1);
  }
  return finish(plan, before, state, warnings, `${date} 보강 수업을 추가하고 이후 일정을 재편성했습니다.`, 'add_makeup', meta.by, meta.at);
}

/** 이 수업의 새 진도를 다음 수업 가능일로 미루기 (이 수업은 비워두고, 이후를 밀어낸다) */
export function postponeLesson(plan: Plan, ctx: ScheduleContext, lessonId: string, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const idx = plan.lessons.findIndex((l) => l.id === lessonId);
  if (idx < 0) throw new Error('수업을 찾을 수 없습니다.');
  const recorded = recordedAssignmentIds(plan);
  const target = plan.lessons[idx];
  if (plan.assignments.some((a) => a.lessonId === lessonId && recorded.has(a.id))) {
    throw new Error('완료 기록이 있는 수업은 미룰 수 없습니다.');
  }
  // 이 수업의 움직일 수 있는 배정을 대기열 맨 앞에 두고 다음 수업부터 채운다
  const mine = plan.assignments.filter((a) => a.lessonId === lessonId && !isImmovable(plan, a, recorded)).sort((a, b) => a.order - b.order);
  const planWithout: Plan = { ...plan, assignments: plan.assignments.filter((a) => !mine.includes(a)) };
  // 숙제는 수업 시간을 쓰지 않으므로 대기열 맨 앞이 아니라 숙제 목록으로 보내, 옮겨 간 차시 수업에 다시 붙게 한다
  const prepend = mine.filter((a) => a.activity !== 'homework').map((a) => queueEntryFromAssignment(a, true));
  const homeworkPrepend = mine.filter((a) => a.activity === 'homework').map((a) => queueEntryFromAssignment(a, true));
  const { state, warnings } = refill({ plan: planWithout, ctx, fromIndex: idx + 1, prepend, homeworkPrepend });
  if (plan.settings.mode === 'pace' && state.unassigned.some((u) => u.reason === 'time_short' && u.activity !== 'homework')) {
    // 속도 우선: 수업일을 늘려서 다시 시도
    const lessons = rebuildLessonsFor(plan, plan.settings, ctx);
    const r2 = refill({ plan: planWithout, ctx, fromIndex: idx + 1, prepend, homeworkPrepend, lessonsOverride: lessons });
    const lastIdx = Math.max(r2.state.lessons.findIndex((l) => l.date === r2.state.endDateComputed), idx, 0);
    r2.state.lessons = r2.state.lessons.slice(0, lastIdx + 1);
    return finish(plan, before, r2.state, r2.warnings, `${target.date} 수업의 진도를 다음 수업으로 미뤘습니다.`, 'postpone', meta.by, meta.at);
  }
  return finish(plan, before, state, warnings, `${target.date} 수업의 진도를 다음 수업으로 미뤘습니다.`, 'postpone', meta.by, meta.at);
}

/**
 * 남은 범위를 한 차시 더 이어서 진행.
 * 부분 완료 기록을 바탕으로 남은 범위를 다음 수업 맨 앞에 넣고 이후를 밀어낸다.
 * 이어서 진행 항목은 continuedFrom 으로 원래 배정과 연결된다.
 */
export function continueAssignment(
  plan: Plan,
  ctx: ScheduleContext,
  assignmentId: string,
  remaining: { portion?: { from: number; to: number }; portions?: Array<{ from: number; to: number }>; fraction?: number; minutes: number },
  meta: OpMeta,
): OpResult {
  const before = scheduleStateOf(plan);
  const a = plan.assignments.find((x) => x.id === assignmentId);
  if (!a) throw new Error('배정을 찾을 수 없습니다.');
  // 같은 배정을 두 번 이어서 진행하면 남은 범위가 중복 배정된다
  const existingCont = plan.assignments.find((x) => x.continuedFrom === a.id);
  if (existingCont) {
    const d = plan.lessons.find((l) => l.id === existingCont.lessonId)?.date ?? '';
    throw new Error(`이미 남은 범위를 ${d} 수업에 이어서 진행하도록 배정했습니다. 그 수업의 기록을 입력하세요.`);
  }
  // 이어서 진행한 남은 범위가 수업 시간이 모자라 미배정이 된 경우도 같은 범위다
  if (plan.unassigned.some((u) => u.continuedFrom === a.id && u.reason !== 'excluded')) {
    throw new Error('이미 이어서 진행하도록 한 남은 범위가 미배정 목록에 있습니다. 보강일을 추가하거나 미배정 항목을 처리하세요.');
  }
  const idx = plan.lessons.findIndex((l) => l.id === a.lessonId);
  if (remaining.minutes <= 0) throw new Error('남은 분량이 없습니다.');
  const base: QueueEntry = {
    sessionId: a.sessionId,
    sessionOrder: a.sessionOrder,
    entryId: a.entryId,
    textbookId: a.textbookId,
    itemId: a.itemId,
    track: a.track,
    activity: a.activity,
    minutes: remaining.minutes,
    portion: remaining.portion ? { ...remaining.portion } : undefined,
    fraction: remaining.fraction,
    continuedFrom: a.id,
    repeatPurpose: a.repeatPurpose,
  };
  // 남은 범위가 여러 조각이면 조각마다 이어서 진행 항목을 만든다 (분은 쪽 수에 비례해 나눈다)
  const pieces = remaining.portions && remaining.portions.length > 1 ? remaining.portions : null;
  let conts: QueueEntry[] = [base];
  if (pieces) {
    const totalUnits = pieces.reduce((s, r) => s + (r.to - r.from + 1), 0);
    let left = remaining.minutes;
    conts = pieces.map((r, i) => {
      const m = i === pieces.length - 1 ? left : Math.max(5, Math.round((remaining.minutes * (r.to - r.from + 1)) / totalUnits));
      left -= m;
      return { ...base, portion: { ...r }, minutes: Math.max(5, m) };
    });
  }
  const cont = conts[0];
  let { state, warnings } = refill({ plan, ctx, fromIndex: idx + 1, prepend: conts });
  if (plan.settings.mode === 'pace' && state.unassigned.some((u) => u.reason === 'time_short' && u.activity !== 'homework')) {
    const lessons = rebuildLessonsFor(plan, plan.settings, ctx);
    const r2 = refill({ plan, ctx, fromIndex: idx + 1, prepend: conts, lessonsOverride: lessons });
    const lastIdx = Math.max(r2.state.lessons.findIndex((l) => l.date === r2.state.endDateComputed), idx, 0);
    r2.state.lessons = r2.state.lessons.slice(0, lastIdx + 1);
    state = r2.state;
    warnings = r2.warnings;
  }
  const label = pieces ? pieces.map((r) => `${r.from}~${r.to}`).join(', ') : cont.portion ? `${cont.portion.from}~${cont.portion.to}` : `${Math.round((remaining.fraction ?? 1) * 100)}%`;
  return finish(plan, before, state, warnings, `남은 범위(${label})를 다음 수업에 이어서 진행하도록 배정했습니다.`, 'continue', meta.by, meta.at);
}

/** 두 수업의 배정 맞바꾸기 */
export function swapLessons(plan: Plan, ctx: ScheduleContext, lessonIdA: string, lessonIdB: string, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const recorded = recordedAssignmentIds(plan);
  const la = plan.lessons.find((l) => l.id === lessonIdA);
  const lb = plan.lessons.find((l) => l.id === lessonIdB);
  if (!la || !lb) throw new Error('수업을 찾을 수 없습니다.');
  if (la.id === lb.id) throw new Error('같은 수업끼리는 맞바꿀 수 없습니다.');
  for (const l of [la, lb]) {
    if (l.status !== 'scheduled' && l.status !== 'makeup') throw new Error(`${l.date}은(는) ${l.status === 'holiday' ? '공휴일' : '휴강'}이라 맞바꿀 수 없습니다.`);
  }
  const inA = plan.assignments.filter((a) => a.lessonId === lessonIdA);
  const inB = plan.assignments.filter((a) => a.lessonId === lessonIdB);
  if ([...inA, ...inB].some((a) => isImmovable(plan, a, recorded))) {
    throw new Error('완료 기록이 있거나 고정된 배정이 포함된 수업은 맞바꿀 수 없습니다.');
  }
  const warnings: string[] = [];
  const minutesA = inA.filter((a) => a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0);
  const minutesB = inB.filter((a) => a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0);
  if (minutesA > lb.availableMinutes) warnings.push(`${lb.date} 수업의 가능시간(${lb.availableMinutes}분)보다 옮겨오는 분량(${minutesA}분)이 많습니다.`);
  if (minutesB > la.availableMinutes) warnings.push(`${la.date} 수업의 가능시간(${la.availableMinutes}분)보다 옮겨오는 분량(${minutesB}분)이 많습니다.`);
  const assignments = plan.assignments.map((a) => {
    if (a.lessonId === lessonIdA) return { ...a, lessonId: lessonIdB };
    if (a.lessonId === lessonIdB) return { ...a, lessonId: lessonIdA };
    return a;
  });
  // 선수 학습 순서 검사: 맞바꾼 뒤 계획 전체에서 선수 항목이 뒤로 가는 경우가 있으면 차단
  const violations = prerequisiteViolations(plan.lessons, assignments, ctx.snapshot);
  if (violations.length) {
    throw new Error(`선수 학습 순서에 어긋나 맞바꿀 수 없습니다: ${violations.slice(0, 3).join('; ')}`);
  }
  const state: ScheduleState = { ...scheduleStateOf(plan), assignments };
  return finish(plan, before, state, warnings, `${la.date} 수업과 ${lb.date} 수업을 맞바꿨습니다.`, 'swap', meta.by, meta.at);
}

/**
 * 특정 날짜에 고정. 기존 수업의 배정을 삭제하거나 덮어쓰지 않고 추가한다.
 * 이전 날짜로 당길 때도 마찬가지이며, 가능시간 초과는 경고로 알린다.
 */
export function pinAssignment(plan: Plan, ctx: ScheduleContext, assignmentId: string, date: ISODate, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const recorded = recordedAssignmentIds(plan);
  const a = plan.assignments.find((x) => x.id === assignmentId);
  if (!a) throw new Error('배정을 찾을 수 없습니다.');
  if (recorded.has(a.id)) throw new Error('완료 기록이 있는 배정은 옮길 수 없습니다.');
  const target = plan.lessons.find((l) => l.date === date);
  if (!target) throw new Error('해당 날짜에 수업이 없습니다. 보강일로 먼저 추가하세요.');
  if (target.status !== 'scheduled' && target.status !== 'makeup') throw new Error('휴강·공휴일 수업에는 고정할 수 없습니다.');
  const warnings: string[] = [];
  const used = plan.assignments.filter((x) => x.lessonId === target.id && x.id !== a.id && x.activity !== 'homework').reduce((s, x) => s + x.minutes, 0);
  if (used + a.minutes > target.availableMinutes) {
    warnings.push(`${date} 수업의 가능시간(${target.availableMinutes}분)을 ${used + a.minutes - target.availableMinutes}분 초과합니다. 기존 배정은 삭제하지 않았습니다.`);
  }
  const maxOrder = plan.assignments.filter((x) => x.lessonId === target.id).reduce((m, x) => Math.max(m, x.order), 0);
  const assignments = plan.assignments.map((x) => (x.id === a.id ? { ...x, lessonId: target.id, locked: true, order: maxOrder + 1 } : x));
  // 선수 학습 순서 경고 (고정은 사용자의 명시적 선택이므로 차단하지 않고 경고)
  for (const v of prerequisiteViolations(plan.lessons, assignments, ctx.snapshot)) warnings.push(`선수 학습 순서 주의: ${v}`);
  const state: ScheduleState = { ...scheduleStateOf(plan), assignments };
  if (plan.settings.endDate && date > plan.settings.endDate) warnings.push('종료일 이후 날짜입니다.');
  return finish(plan, before, state, warnings, `배정을 ${date} 수업에 고정했습니다.`, 'pin', meta.by, meta.at);
}

export function unpinAssignment(plan: Plan, assignmentId: string, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const assignments = plan.assignments.map((x) => (x.id === assignmentId ? { ...x, locked: false } : x));
  const state: ScheduleState = { ...scheduleStateOf(plan), assignments };
  return finish(plan, before, state, [], '배정 고정을 해제했습니다.', 'manual_edit', meta.by, meta.at);
}

/** 미배정 항목을 제외 처리 (교재 원본은 변경하지 않음) */
export function excludeUnassigned(plan: Plan, unassignedId: string, reason: string, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const unassigned = plan.unassigned.map((u) => (u.id === unassignedId ? { ...u, reason: 'excluded' as const, detail: reason || '사용자 제외' } : u));
  const state: ScheduleState = { ...scheduleStateOf(plan), unassigned };
  return finish(plan, before, state, [], '미배정 항목을 이 계획에서 제외했습니다.', 'manual_edit', meta.by, meta.at);
}

/**
 * 되돌리기. 해당 이력 시점 이후에 생성된 실제 기록이 있으면 거부한다
 * (실제 완료 기록을 지우는 방식의 되돌리기는 금지).
 */
/**
 * 되돌릴 수 있는 이력: 아직 되돌리지 않은 일정 변경 중 가장 최근 것 하나.
 * 오래된 변경을 바로 되돌리면 그 뒤의 변경(고정 등)이 말없이 사라지므로, 최근 것부터 차례로 되돌린다.
 * ('되돌리기' 자체는 다시 되돌리지 않는다.)
 */
export function latestUndoableId(plan: Plan): string | null {
  for (let i = plan.history.length - 1; i >= 0; i--) {
    const h = plan.history[i];
    if (h.action === 'undo' || !h.before) continue;
    if (h.undone) continue;
    return h.id;
  }
  return null;
}

export function undoHistory(plan: Plan, historyId: string, meta: OpMeta): OpResult {
  const entry = plan.history.find((h) => h.id === historyId);
  if (!entry || !entry.before || entry.action === 'undo') throw new Error('되돌릴 수 있는 이력이 아닙니다.');
  if (entry.undone) throw new Error('이미 되돌린 이력입니다.');
  const laterRecords = plan.records.filter((r) => r.recordedAt > entry.at);
  if (laterRecords.length > 0) {
    throw new Error(`이 변경 이후 입력된 실제 기록 ${laterRecords.length}건이 있어 되돌릴 수 없습니다. 기록은 삭제하지 않습니다.`);
  }
  if (latestUndoableId(plan) !== entry.id) {
    throw new Error('가장 최근 변경부터 차례로 되돌릴 수 있습니다. 이 변경 뒤의 변경을 먼저 되돌리세요.');
  }
  // 복원 상태에 없는 배정을 참조하는 기록이 있으면 거부
  const restoredIds = new Set(entry.before.assignments.map((a) => a.id));
  const orphan = plan.records.filter((r) => !restoredIds.has(r.assignmentId));
  if (orphan.length > 0) throw new Error('복원하면 연결이 끊기는 실제 기록이 있어 되돌릴 수 없습니다.');

  const before = scheduleStateOf(plan);
  const next = applyState(plan, structuredClone(entry.before));
  next.history = [
    ...plan.history.map((h) => (h.id === historyId ? { ...h, undone: true } : h)),
    { id: defaultIdGen(), at: meta.at, by: meta.by, action: 'undo', description: `'${entry.description}' 변경을 되돌렸습니다.`, before },
  ];
  next.planVersion = plan.planVersion + 1;
  return { plan: next, diff: diffSchedule(before, entry.before), description: `변경을 되돌렸습니다.`, warnings: [] };
}

/** 설정 변경 후 전체(기록·고정 제외) 재편성 */
export function applySettingsAndReschedule(plan: Plan, ctx: ScheduleContext, settings: PlanSettings, meta: OpMeta): OpResult {
  const before = scheduleStateOf(plan);
  const planWithSettings: Plan = { ...plan, settings: structuredClone(settings) };
  const lessons = rebuildLessonsFor(plan, settings, ctx);
  const { state, warnings } = refill({ plan: planWithSettings, ctx, fromIndex: 0, lessonsOverride: lessons });
  if (settings.mode === 'pace') {
    const lastIdx = Math.max(state.lessons.findIndex((l) => l.date === state.endDateComputed), 0);
    state.lessons = state.lessons.slice(0, lastIdx + 1);
  }
  return finish(plan, before, state, warnings, '편성 설정을 변경하고 일정을 다시 편성했습니다.', 'edit_settings', meta.by, meta.at);
}

/** 확정 가능 여부: 필수 범위(제외 처리되지 않은 미배정)가 있으면 확정 불가 */
export function confirmBlockers(plan: Plan): string[] {
  const blockers: string[] = [];
  const pending = plan.unassigned.filter((u) => u.reason !== 'excluded');
  if (pending.length > 0) blockers.push(`미배정 범위 ${pending.length}건(${unassignedMinutes(pending)}분)이 있습니다. 재편성하거나 제외 처리한 뒤 확정하세요.`);
  const adv = plan.snapshot.advance;
  if (adv && adv.requiredObjectiveIds.length > 0 && !adv.prerequisitesConfirmed) {
    blockers.push('선행 과정의 기초 확인 항목이 담당자 확인을 받지 않았습니다.');
  }
  return blockers;
}

/** 수업일별 트랙 시간 합계 검증 (실제 수업 가능시간 초과 여부) */
export function overbookedLessons(plan: Plan): Array<{ lessonId: string; date: ISODate; used: number; available: number }> {
  const used = new Map<string, number>();
  for (const a of plan.assignments) {
    if (a.activity === 'homework') continue;
    used.set(a.lessonId, (used.get(a.lessonId) ?? 0) + a.minutes);
  }
  const out: Array<{ lessonId: string; date: ISODate; used: number; available: number }> = [];
  for (const l of plan.lessons) {
    const u = used.get(l.id) ?? 0;
    if (u > l.availableMinutes) out.push({ lessonId: l.id, date: l.date, used: u, available: l.availableMinutes });
  }
  return out;
}

export { normalizeRanges, compareDates, itemQuantity };
