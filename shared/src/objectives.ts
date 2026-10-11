/**
 * 학습목표 지도.
 * 기간별로 목표가 '계획에 배치됨 / 실제 진행함 / 이해 확인 기록 있음 / 아직 배정되지 않음'
 * 중 어디에 있는지 구분한다. 계획에 들어 있다는 이유로 습득으로 표시하지 않는다.
 */
import type { ISODate, LearningObjective, Plan } from './types.ts';
import { snapshotItemIndex } from './scheduler.ts';
import { latestRecordFor } from './progress.ts';

export type ObjectiveState = 'planned' | 'progressed' | 'confirmed' | 'unassigned';
export const OBJECTIVE_STATE_LABEL: Record<ObjectiveState, string> = {
  planned: '계획에 배치됨',
  progressed: '실제 진행함',
  confirmed: '이해 확인 기록 있음',
  unassigned: '아직 배정되지 않음',
};

export interface ObjectiveStatus {
  objectiveId: string;
  code: string;
  title: string;
  required: boolean;
  state: ObjectiveState;
  plannedDates: ISODate[];
  progressedDates: ISODate[];
  confirmedDates: ISODate[];
  /** 같은 목표가 여러 번 나올 때 목적 (복습·심화·평가) */
  occurrences: Array<{ date: ISODate; itemTitle: string; activity: string; purpose: string }>;
  itemIds: string[];
}

export function objectiveMap(plan: Plan, objectives: LearningObjective[], range?: { from: ISODate; to: ISODate }): ObjectiveStatus[] {
  const items = snapshotItemIndex(plan.snapshot);
  const dateOf = new Map(plan.lessons.map((l) => [l.id, l.date]));
  const inRange = (d: ISODate | undefined) => !!d && (!range || (d >= range.from && d <= range.to));
  const required = new Set(plan.requiredObjectiveIds);

  // 목표 id → 항목 id 목록 (스냅샷 기준)
  const itemsByObjective = new Map<string, string[]>();
  for (const [id, info] of items) {
    for (const oid of info.item.objectiveIds) itemsByObjective.set(oid, [...(itemsByObjective.get(oid) ?? []), id]);
  }
  // 과정에 등장하는 목표 + 필수 지정 목표
  const objIds = new Set<string>([...itemsByObjective.keys(), ...required]);
  const objById = new Map(objectives.map((o) => [o.id, o]));

  const out: ObjectiveStatus[] = [];
  for (const oid of objIds) {
    const o = objById.get(oid);
    const itemIds = itemsByObjective.get(oid) ?? [];
    const planned: ISODate[] = [];
    const progressed: ISODate[] = [];
    const occurrences: ObjectiveStatus['occurrences'] = [];
    for (const a of plan.assignments) {
      if (!itemIds.includes(a.itemId)) continue;
      const d = dateOf.get(a.lessonId);
      if (!inRange(d)) continue;
      planned.push(d!);
      const info = items.get(a.itemId);
      occurrences.push({
        date: d!,
        itemTitle: info?.item.title ?? a.itemId,
        activity: a.activity,
        purpose: a.repeatPurpose ?? (a.activity === 'review' ? 'review' : a.activity === 'assessment' ? 'assessment' : ''),
      });
      const rec = latestRecordFor(plan, a.id);
      if (rec && (rec.status === 'done' || rec.status === 'partial')) progressed.push(d!);
    }
    const confirmedDates = plan.understandingChecks
      .filter((c) => c.result === 'confirmed' && (c.objectiveIds.includes(oid) || itemIds.includes(c.itemId)))
      .map((c) => dateOf.get(c.lessonId) ?? c.checkedAt.slice(0, 10))
      .filter((d) => inRange(d));
    let state: ObjectiveState = 'unassigned';
    if (confirmedDates.length) state = 'confirmed';
    else if (progressed.length) state = 'progressed';
    else if (planned.length) state = 'planned';
    out.push({
      objectiveId: oid,
      code: o?.code ?? '',
      title: o?.title ?? `(미등록 목표 ${oid})`,
      required: required.has(oid),
      state,
      plannedDates: [...new Set(planned)].sort(),
      progressedDates: [...new Set(progressed)].sort(),
      confirmedDates: [...new Set(confirmedDates)].sort(),
      occurrences: occurrences.sort((a, b) => (a.date < b.date ? -1 : 1)),
      itemIds,
    });
  }
  return out.sort((a, b) => (a.required === b.required ? a.code.localeCompare(b.code) : a.required ? -1 : 1));
}

/** 필수 목표 중 누락(미배정) 목록 */
export function missingRequiredObjectives(statuses: ObjectiveStatus[]): ObjectiveStatus[] {
  return statuses.filter((s) => s.required && s.state === 'unassigned');
}

/** 선행 과정의 기초 확인: 필요한 목표 중 이해 확인이 없는 것 */
export function advancePrerequisiteGaps(plan: Plan, objectives: LearningObjective[]): Array<{ objective: LearningObjective; reason: string }> {
  const adv = plan.snapshot.advance;
  if (!adv) return [];
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const statuses = objectiveMap(plan, objectives);
  const byObj = new Map(statuses.map((s) => [s.objectiveId, s]));
  const gaps: Array<{ objective: LearningObjective; reason: string }> = [];
  for (const oid of adv.requiredObjectiveIds) {
    const o = byId.get(oid);
    if (!o) continue;
    const st = byObj.get(oid);
    if (!st || st.state !== 'confirmed') {
      gaps.push({ objective: o, reason: st ? `상태: ${OBJECTIVE_STATE_LABEL[st.state]} (이해 확인 기록 없음)` : '이 계획에 배정되지 않았고 이해 확인 기록도 없음' });
    }
  }
  return gaps;
}
