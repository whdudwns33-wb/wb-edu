import type { Curriculum, Plan, PlanSettings, PlanSnapshot, Textbook } from '../src/types.ts';
import { sampleCurricula, sampleInhouseTextbook, sampleMarketTextbook } from '../src/sample.ts';
import { generateSchedule, type ScheduleContext } from '../src/scheduler.ts';

export const BY = 'test-user';
export const AT = '2026-01-01T00:00:00.000Z';

export function sampleWorld() {
  const market = sampleMarketTextbook(BY, AT);
  const inhouse = sampleInhouseTextbook(BY, AT);
  const tbs = new Map<string, Textbook>([
    [market.id, market],
    [inhouse.id, inhouse],
  ]);
  const curricula = sampleCurricula(BY, AT, tbs);
  return { market, inhouse, tbs, curricula };
}

export function snapshotOf(c: Curriculum, tbs: Map<string, Textbook>): PlanSnapshot {
  return {
    curriculumId: c.id,
    curriculumTitle: c.title,
    curriculumVersion: c.curriculumVersion,
    compositionMode: c.compositionMode,
    takenAt: AT,
    sessions: structuredClone(c.sessions),
    textbooks: c.textbooks.map((ref) => {
      const tb = tbs.get(ref.textbookId)!;
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
    advance: c.advance ? structuredClone(c.advance) : undefined,
  };
}

/** 8회 수업(월·목), 회당 60분, 복습 10, 여유 5 → 새 진도 45분 × 8 = 360분 */
export function baseSettings(over: Partial<PlanSettings> = {}): PlanSettings {
  return {
    startDate: '2026-04-06', // 월요일
    endDate: '2026-04-30',
    targetDate: '',
    weekdays: [1, 4], // 월, 목 → 4/6,9,13,16,20,23,27,30 = 8회
    minutesPerLesson: 60,
    reviewMinutes: 10,
    bufferMinutes: 5,
    mode: 'period',
    academicYearStartMonth: 3,
    holidaySetIds: [],
    offDays: [],
    makeupDays: [],
    fixedEvents: [],
    tracks: { review: 0, advance: 0, advanceWeekdays: null, currentMinMinutes: 0 },
    maxDays: 400,
    ...over,
  };
}

let seq = 0;
export function seqIdGen(prefix = 'id'): () => string {
  return () => `${prefix}-${++seq}`;
}

export function makePlan(c: Curriculum, tbs: Map<string, Textbook>, settings: PlanSettings, holidays: string[] = []): { plan: Plan; ctx: ScheduleContext } {
  const snapshot = snapshotOf(c, tbs);
  const ctx: ScheduleContext = { snapshot, holidayDates: holidays, idGen: seqIdGen('p') };
  const res = generateSchedule(settings, ctx);
  const plan: Plan = {
    id: 'plan-1',
    title: `${c.title} 계획`,
    subject: c.subject,
    target: c.target,
    classOrStudentRef: '',
    curriculumId: c.id,
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
    history: [],
    author: BY,
    reviewer: '',
    requiredObjectiveIds: [],
    allowedUserIds: [],
    createdAt: AT,
    createdBy: BY,
    updatedAt: AT,
    updatedBy: BY,
    version: 1,
    archived: false,
    isSample: true,
  };
  return { plan, ctx };
}

export function lessonDates(plan: Plan, status?: string): string[] {
  return plan.lessons.filter((l) => !status || l.status === status).map((l) => l.date);
}

export function assignedMinutes(plan: Plan): number {
  return plan.assignments.filter((a) => a.activity !== 'homework').reduce((s, a) => s + a.minutes, 0);
}
