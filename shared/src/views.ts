/**
 * 연간·분기·월간·주간·일간 보기 집계.
 * 다섯 보기는 모두 같은 원본(plan.lessons / assignments / records)과
 * 같은 집계 함수(summarizeLessons)를 사용한다. 월을 걸치는 주는 실제 수업일 기준으로 센다.
 */
import type { Activity, Assignment, ISODate, Lesson, Plan, ProgressRecord, Track } from './types.ts';
import { ACTIVITY_LABEL, PROGRESS_UNIT_LABEL, RECORD_STATUS_LABEL, TRACK_LABEL } from './types.ts';
import {
  academicQuarter,
  academicQuarterRange,
  academicYear,
  academicYearRange,
  calendarQuarter,
  endOfWeek,
  monthKey,
  parts,
  startOfWeek,
  weekday,
  WEEKDAY_LABEL,
} from './dates.ts';
import { snapshotItemIndex } from './scheduler.ts';
import { itemCompletion, latestRecordFor, assignmentPortion, recordCompleted } from './progress.ts';
import { rangeLabel, subtractRanges, isRangedUnit } from './units.ts';

export type ViewLevel = 'year' | 'quarter' | 'month' | 'week' | 'day';

export interface TextbookRangeSummary {
  textbookId: string;
  title: string;
  unit: string;
  /** 예: 12~23쪽, 5~8강 */
  rangeText: string;
  minutes: number;
  itemTitles: string[];
}

export interface LessonSummary {
  lessonCount: number; // 실제 수업(예정+보강)
  cancelledCount: number;
  holidayCount: number;
  makeupCount: number;
  totalMinutes: number;
  availableMinutes: number;
  assignedMinutes: number;
  reviewMinutes: number;
  bufferMinutes: number;
  fixedMinutes: number;
  homeworkMinutes: number;
  byTrack: Record<Track, number>;
  byActivity: Record<Activity, number>;
  textbooks: TextbookRangeSummary[];
  /** 기록 현황 */
  recorded: { done: number; partial: number; not_done: number; excluded: number; unrecorded: number };
  assessmentDates: ISODate[];
  reviewDates: ISODate[];
}

export interface AssignmentView {
  assignment: Assignment;
  lessonDate: ISODate;
  textbookTitle: string;
  itemTitle: string;
  unit: string;
  subunit: string;
  objective: string;
  objectiveIds: string[];
  rangeText: string;
  /** 인쇄 쪽 → PDF 페이지 */
  pdfRangeText: string;
  trackLabel: string;
  activityLabel: string;
  materials: string;
  teachingNote: string;
  extra: Record<string, string>;
  record?: ProgressRecord;
  recordLabel: string;
  /** 남은 범위 (부분 완료 시) */
  remainingText: string;
  continuedFrom?: string;
}

export interface DayView {
  lesson: Lesson;
  dateLabel: string;
  assignments: AssignmentView[];
  summary: LessonSummary;
  objectives: string[];
  timeAllocation: Array<{ label: string; minutes: number }>;
}

export interface WeekView {
  key: string;
  from: ISODate;
  to: ISODate;
  label: string;
  days: DayView[];
  summary: LessonSummary;
  /** 월을 걸치는 주 */
  spansMonths: boolean;
}

export interface MonthView {
  key: string; // YYYY-MM
  label: string;
  from: ISODate;
  to: ISODate;
  weeks: WeekView[];
  summary: LessonSummary;
}

export interface QuarterView {
  key: string;
  label: string;
  from: ISODate;
  to: ISODate;
  basis: 'academic' | 'calendar';
  months: MonthView[];
  summary: LessonSummary;
  /** 분기 내 단계 전환·교재 전환 지점 */
  transitions: string[];
}

export interface YearView {
  academicYear: number;
  label: string;
  from: ISODate;
  to: ISODate;
  quarters: QuarterView[];
  summary: LessonSummary;
  textbookFlow: Array<{ textbookId: string; title: string; edition: string; firstDate: ISODate; lastDate: ISODate; minutes: number }>;
  trackTargets: Array<{ track: Track; label: string; minutes: number; itemCount: number }>;
}

export interface PlanViews {
  header: PlanHeader;
  years: YearView[];
  summary: LessonSummary;
  completionBasis: string;
}

export interface PlanHeader {
  title: string;
  target: string;
  subject: string;
  period: string;
  textbooks: string[];
  planVersion: number;
  curriculumTitle: string;
  curriculumVersion: number;
  status: string;
  author: string;
  reviewer: string;
  totalMinutes: number;
  unassignedCount: number;
  unassignedMinutes: number;
  lastChange: string;
  mode: string;
  academicYearStartMonth: number;
}

const emptyTrack = (): Record<Track, number> => ({ current: 0, review: 0, advance: 0 });
const emptyActivity = (): Record<Activity, number> => ({ new: 0, practice: 0, review: 0, assessment: 0, homework: 0 });

export function summarizeLessons(plan: Plan, lessons: Lesson[]): LessonSummary {
  const items = snapshotItemIndex(plan.snapshot);
  const tbTitle = new Map(plan.snapshot.textbooks.map((t) => [t.id, t.title]));
  const lessonIds = new Set(lessons.map((l) => l.id));
  const s: LessonSummary = {
    lessonCount: 0,
    cancelledCount: 0,
    holidayCount: 0,
    makeupCount: 0,
    totalMinutes: 0,
    availableMinutes: 0,
    assignedMinutes: 0,
    reviewMinutes: 0,
    bufferMinutes: 0,
    fixedMinutes: 0,
    homeworkMinutes: 0,
    byTrack: emptyTrack(),
    byActivity: emptyActivity(),
    textbooks: [],
    recorded: { done: 0, partial: 0, not_done: 0, excluded: 0, unrecorded: 0 },
    assessmentDates: [],
    reviewDates: [],
  };
  for (const l of lessons) {
    if (l.status === 'scheduled') s.lessonCount++;
    else if (l.status === 'makeup') {
      s.lessonCount++;
      s.makeupCount++;
    } else if (l.status === 'cancelled') s.cancelledCount++;
    else if (l.status === 'holiday') s.holidayCount++;
    s.totalMinutes += l.totalMinutes;
    s.availableMinutes += l.availableMinutes;
    s.reviewMinutes += l.reviewMinutes;
    s.bufferMinutes += l.bufferMinutes;
    s.fixedMinutes += l.fixedMinutes;
  }
  const tbAgg = new Map<string, { minutes: number; ranges: Array<{ from: number; to: number }>; unit: string; titles: string[]; nonRanged: number }>();
  const dateOf = new Map(plan.lessons.map((l) => [l.id, l.date]));
  for (const a of plan.assignments) {
    if (!lessonIds.has(a.lessonId)) continue;
    if (a.activity === 'homework') s.homeworkMinutes += a.minutes;
    else {
      s.assignedMinutes += a.minutes;
      s.byTrack[a.track] += a.minutes;
    }
    s.byActivity[a.activity] += a.minutes;
    if (a.activity === 'assessment') s.assessmentDates.push(dateOf.get(a.lessonId)!);
    if (a.activity === 'review') s.reviewDates.push(dateOf.get(a.lessonId)!);
    const info = items.get(a.itemId);
    const key = a.textbookId;
    const agg = tbAgg.get(key) ?? { minutes: 0, ranges: [], unit: '', titles: [], nonRanged: 0 };
    agg.minutes += a.activity === 'homework' ? 0 : a.minutes;
    if (info) {
      const p = assignmentPortion(a, info.item);
      if (p.range) {
        agg.ranges.push(p.range);
        agg.unit = PROGRESS_UNIT_LABEL[info.item.progressUnit];
      } else {
        agg.nonRanged += 1;
        if (!agg.unit) agg.unit = PROGRESS_UNIT_LABEL[info.item.progressUnit];
      }
      if (!agg.titles.includes(info.item.title)) agg.titles.push(info.item.title);
    }
    tbAgg.set(key, agg);
    const rec = latestRecordFor(plan, a.id);
    if (!rec) s.recorded.unrecorded++;
    else s.recorded[rec.status]++;
  }
  s.textbooks = [...tbAgg.entries()].map(([id, agg]) => {
    const sorted = [...agg.ranges].sort((x, y) => x.from - y.from);
    let rangeText = '';
    if (sorted.length) {
      const first = sorted[0].from;
      const last = Math.max(...sorted.map((r) => r.to));
      rangeText = first === last ? `${first}${agg.unit}` : `${first}~${last}${agg.unit}`;
    } else if (agg.nonRanged) {
      rangeText = `${agg.nonRanged}${agg.unit || '항목'}`;
    }
    return { textbookId: id, title: tbTitle.get(id) ?? id, unit: agg.unit, rangeText, minutes: agg.minutes, itemTitles: agg.titles };
  });
  s.assessmentDates = [...new Set(s.assessmentDates)].sort();
  s.reviewDates = [...new Set(s.reviewDates)].sort();
  return s;
}

export function assignmentViews(plan: Plan, lesson: Lesson): AssignmentView[] {
  const items = snapshotItemIndex(plan.snapshot);
  const tbs = new Map(plan.snapshot.textbooks.map((t) => [t.id, t]));
  return plan.assignments
    .filter((a) => a.lessonId === lesson.id)
    .sort((a, b) => a.order - b.order)
    .map((a) => {
      const info = items.get(a.itemId);
      const tb = tbs.get(a.textbookId);
      const item = info?.item;
      const p = item ? assignmentPortion(a, item) : { fraction: 1 };
      let rangeText = '';
      let pdfRangeText = '';
      if (item && p.range) {
        rangeText = rangeLabel(p.range, item.progressUnit);
        if (item.progressUnit === 'page' && tb && tb.pdfPageOffset) {
          pdfRangeText = `PDF ${p.range.from + tb.pdfPageOffset}~${p.range.to + tb.pdfPageOffset}p`;
        }
      } else if (item) {
        rangeText = a.fraction !== undefined && a.fraction < 1 ? `${Math.round(a.fraction * 100)}% (${PROGRESS_UNIT_LABEL[item.progressUnit]})` : `${item.quantity}${PROGRESS_UNIT_LABEL[item.progressUnit]}`;
      }
      const record = latestRecordFor(plan, a.id);
      let remainingText = '';
      if (record && record.status === 'partial' && item) {
        const c = recordCompleted(record, a, item);
        if (p.range) {
          const rem = subtractRanges(p.range, c.ranges);
          remainingText = rem.map((r) => rangeLabel(r, item.progressUnit)).join(', ');
        } else {
          remainingText = `${Math.round((p.fraction - c.fraction) * 100)}% 남음`;
        }
      }
      return {
        assignment: a,
        lessonDate: lesson.date,
        textbookTitle: tb?.title ?? a.textbookId,
        itemTitle: item?.title ?? a.itemId,
        unit: item?.unit ?? '',
        subunit: item?.subunit ?? '',
        objective: item?.objective ?? '',
        objectiveIds: item?.objectiveIds ?? [],
        rangeText,
        pdfRangeText,
        trackLabel: TRACK_LABEL[a.track],
        activityLabel: ACTIVITY_LABEL[a.activity] + (a.repeatPurpose ? `(${a.repeatPurpose === 'review' ? '복습' : a.repeatPurpose === 'deepen' ? '심화' : '평가'})` : ''),
        materials: item?.materials ?? '',
        teachingNote: item?.teachingNote ?? '',
        extra: item?.extra ?? {},
        record,
        recordLabel: record ? RECORD_STATUS_LABEL[record.status] : '미기록',
        remainingText,
        continuedFrom: a.continuedFrom,
      };
    });
}

export function dayView(plan: Plan, lesson: Lesson): DayView {
  const views = assignmentViews(plan, lesson);
  const { y, m, d } = parts(lesson.date);
  const objectives = [...new Set(views.map((v) => v.objective).filter(Boolean))];
  const newMinutes = views.filter((v) => v.assignment.activity !== 'homework').reduce((s, v) => s + v.assignment.minutes, 0);
  return {
    lesson,
    dateLabel: `${y}년 ${m}월 ${d}일 (${WEEKDAY_LABEL[weekday(lesson.date)]})`,
    assignments: views,
    summary: summarizeLessons(plan, [lesson]),
    objectives,
    timeAllocation: [
      { label: '복습', minutes: lesson.reviewMinutes },
      { label: '새 진도(배정)', minutes: newMinutes },
      { label: '여유', minutes: lesson.bufferMinutes },
      { label: '고정 일정', minutes: lesson.fixedMinutes },
      { label: '미사용', minutes: Math.max(0, lesson.availableMinutes - newMinutes) },
    ],
  };
}

function weekLabel(from: ISODate, to: ISODate): string {
  const a = parts(from);
  const b = parts(to);
  return a.m === b.m ? `${a.m}월 ${a.d}일~${b.d}일` : `${a.m}월 ${a.d}일~${b.m}월 ${b.d}일`;
}

/** 주 묶음: 월요일 시작. 주의 범위를 [clampFrom, clampTo] 로 자르면 월을 걸치는 주는 실제 수업일로만 집계된다 */
export function weekViews(plan: Plan, lessons: Lesson[], clamp?: { from: ISODate; to: ISODate }): WeekView[] {
  const groups = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const k = startOfWeek(l.date);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, ls]) => {
      const wf = k;
      const wt = endOfWeek(k);
      const from = clamp && clamp.from > wf ? clamp.from : wf;
      const to = clamp && clamp.to < wt ? clamp.to : wt;
      const sorted = [...ls].sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        key: k,
        from,
        to,
        label: weekLabel(from, to),
        days: sorted.map((l) => dayView(plan, l)),
        summary: summarizeLessons(plan, sorted),
        spansMonths: monthKey(wf) !== monthKey(wt),
      };
    });
}

export function monthViews(plan: Plan, lessons: Lesson[]): MonthView[] {
  const groups = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const k = monthKey(l.date);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, ls]) => {
      const [y, m] = k.split('-').map(Number);
      const from = `${k}-01`;
      const to = `${k}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
      return { key: k, label: `${y}년 ${m}월`, from, to, weeks: weekViews(plan, ls, { from, to }), summary: summarizeLessons(plan, ls) };
    });
}

export function quarterViews(plan: Plan, lessons: Lesson[], basis: 'academic' | 'calendar' = 'academic'): QuarterView[] {
  const startMonth = plan.settings.academicYearStartMonth || 3;
  const groups = new Map<string, { label: string; from: ISODate; to: ISODate; lessons: Lesson[] }>();
  for (const l of lessons) {
    let key: string;
    let label: string;
    let range: { from: ISODate; to: ISODate };
    if (basis === 'academic') {
      const q = academicQuarter(l.date, startMonth);
      key = q.key;
      label = q.label;
      range = academicQuarterRange(q.academicYear, q.quarter, startMonth);
    } else {
      const q = calendarQuarter(l.date);
      key = q.key;
      label = `${q.year}년 ${q.quarter}분기(달력)`;
      const mStart = (q.quarter - 1) * 3 + 1;
      range = { from: `${q.year}-${String(mStart).padStart(2, '0')}-01`, to: `${q.year}-${String(mStart + 2).padStart(2, '0')}-${String(new Date(Date.UTC(q.year, mStart + 2, 0)).getUTCDate()).padStart(2, '0')}` };
    }
    const g = groups.get(key) ?? { label, from: range.from, to: range.to, lessons: [] };
    g.lessons.push(l);
    groups.set(key, g);
  }
  const tbTitle = new Map(plan.snapshot.textbooks.map((t) => [t.id, t.title]));
  const dateOf = new Map(plan.lessons.map((l) => [l.id, l.date]));
  return [...groups.entries()]
    .sort(([, a], [, b]) => (a.from < b.from ? -1 : 1))
    .map(([key, g]) => {
      const ls = [...g.lessons].sort((a, b) => (a.date < b.date ? -1 : 1));
      // 교재 전환 지점
      const transitions: string[] = [];
      const idSet = new Set(ls.map((l) => l.id));
      const ordered = plan.assignments.filter((a) => idSet.has(a.lessonId) && a.activity === 'new').sort((a, b) => (dateOf.get(a.lessonId)! < dateOf.get(b.lessonId)! ? -1 : dateOf.get(a.lessonId)! > dateOf.get(b.lessonId)! ? 1 : a.order - b.order));
      const firstSeen = new Set<string>();
      for (const a of ordered) {
        if (!firstSeen.has(a.textbookId)) {
          firstSeen.add(a.textbookId);
          transitions.push(`${dateOf.get(a.lessonId)} ${tbTitle.get(a.textbookId) ?? ''} 시작`);
        }
      }
      return { key, label: g.label, from: g.from, to: g.to, basis, months: monthViews(plan, ls), summary: summarizeLessons(plan, ls), transitions };
    });
}

export function yearViews(plan: Plan, lessons: Lesson[]): YearView[] {
  const startMonth = plan.settings.academicYearStartMonth || 3;
  const groups = new Map<number, Lesson[]>();
  for (const l of lessons) {
    const ay = academicYear(l.date, startMonth);
    groups.set(ay, [...(groups.get(ay) ?? []), l]);
  }
  const tbMeta = new Map(plan.snapshot.textbooks.map((t) => [t.id, t]));
  const dateOf = new Map(plan.lessons.map((l) => [l.id, l.date]));
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ay, ls]) => {
      const range = academicYearRange(ay, startMonth);
      const idSet = new Set(ls.map((l) => l.id));
      const flow = new Map<string, { firstDate: ISODate; lastDate: ISODate; minutes: number }>();
      const trackAgg = new Map<Track, { minutes: number; items: Set<string> }>();
      for (const a of plan.assignments) {
        if (!idSet.has(a.lessonId) || a.activity === 'homework') continue;
        const d = dateOf.get(a.lessonId)!;
        const f = flow.get(a.textbookId) ?? { firstDate: d, lastDate: d, minutes: 0 };
        if (d < f.firstDate) f.firstDate = d;
        if (d > f.lastDate) f.lastDate = d;
        f.minutes += a.minutes;
        flow.set(a.textbookId, f);
        const t = trackAgg.get(a.track) ?? { minutes: 0, items: new Set() };
        t.minutes += a.minutes;
        t.items.add(a.itemId);
        trackAgg.set(a.track, t);
      }
      return {
        academicYear: ay,
        label: `${ay}학년도 (${range.from} ~ ${range.to})`,
        from: range.from,
        to: range.to,
        quarters: quarterViews(plan, ls, 'academic'),
        summary: summarizeLessons(plan, ls),
        textbookFlow: [...flow.entries()]
          .map(([id, f]) => ({ textbookId: id, title: tbMeta.get(id)?.title ?? id, edition: tbMeta.get(id)?.edition ?? '', ...f }))
          .sort((a, b) => (a.firstDate < b.firstDate ? -1 : 1)),
        trackTargets: (['current', 'review', 'advance'] as Track[]).map((t) => ({ track: t, label: TRACK_LABEL[t], minutes: trackAgg.get(t)?.minutes ?? 0, itemCount: trackAgg.get(t)?.items.size ?? 0 })),
      };
    });
}

export function planHeader(plan: Plan): PlanHeader {
  const unassigned = plan.unassigned.filter((u) => u.reason !== 'excluded');
  const dates = plan.lessons.map((l) => l.date);
  const first = dates.length ? dates[0] : plan.settings.startDate;
  const last = plan.endDateComputed || plan.settings.endDate || (dates.length ? dates[dates.length - 1] : '');
  const lastChange = plan.history.length ? `${plan.history[plan.history.length - 1].at.slice(0, 10)} ${plan.history[plan.history.length - 1].description}` : '';
  return {
    title: plan.title,
    target: plan.target,
    subject: plan.subject,
    period: `${first} ~ ${last}`,
    textbooks: plan.snapshot.textbooks.map((t) => `${t.title} (${t.edition})`),
    planVersion: plan.planVersion,
    curriculumTitle: plan.snapshot.curriculumTitle,
    curriculumVersion: plan.snapshot.curriculumVersion,
    status: plan.status === 'confirmed' ? '확정' : plan.status === 'draft' ? '초안' : '보관',
    author: plan.author,
    reviewer: plan.reviewer,
    totalMinutes: plan.assignments.filter((a) => a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0),
    unassignedCount: unassigned.length,
    unassignedMinutes: unassigned.reduce((s, u) => s + u.minutes, 0),
    lastChange,
    mode: plan.settings.mode === 'period' ? '기간 우선' : '속도 우선',
    academicYearStartMonth: plan.settings.academicYearStartMonth,
  };
}

export function buildPlanViews(plan: Plan, range?: { from: ISODate; to: ISODate }): PlanViews {
  const lessons = [...plan.lessons]
    .filter((l) => !range || (l.date >= range.from && l.date <= range.to))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    header: planHeader(plan),
    years: yearViews(plan, lessons),
    summary: summarizeLessons(plan, lessons),
    completionBasis: '완료율 = 새 학습 활동의 완료 기록(합집합) ÷ 전체 분량. 교재별·단위별로 따로 계산하며 복습·연습·숙제는 완료량에 포함하지 않는다.',
  };
}

export function itemCompletionSummary(plan: Plan) {
  const items = snapshotItemIndex(plan.snapshot);
  const out: Array<{ itemId: string; title: string; unit: string; total: number; completed: number; remaining: string; rangedUnit: boolean }> = [];
  for (const [id, info] of items) {
    const c = itemCompletion(plan, id);
    if (!c) continue;
    out.push({
      itemId: id,
      title: info.item.title,
      unit: PROGRESS_UNIT_LABEL[c.unit],
      total: c.total,
      completed: c.completed,
      remaining: c.remainingRanges.map((r) => rangeLabel(r, c.unit)).join(', '),
      rangedUnit: isRangedUnit(c.unit),
    });
  }
  return out;
}
