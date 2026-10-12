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
  occurrences: Array<{ date: ISODate; itemId: string; itemTitle: string; activity: string; purpose: string }>;
  itemIds: string[];
  /**
   * 목적 확인 필요: 서로 다른 학습항목이 '새 학습'으로 같은 목표를 다시 다루는데 반복 목적(복습·심화·평가)이 없는 경우.
   * 같은 항목을 나눈 조각(분할·이어서 진행)은 반복으로 보지 않는다. 의도적인 반복은 자동 삭제하지 않고 확인만 요청한다.
   */
  repeatWithoutPurpose: string[];
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
        itemId: a.itemId,
        itemTitle: info?.item.title ?? a.itemId,
        activity: a.activity,
        purpose: a.repeatPurpose ?? (a.activity === 'review' ? 'review' : a.activity === 'assessment' ? 'assessment' : ''),
      });
      const rec = latestRecordFor(plan, a.id);
      if (rec && (rec.status === 'done' || rec.status === 'partial')) progressed.push(d!);
    }
    const confirmedDates = plan.understandingChecks
      // 이해 확인이 목표를 골라 기록했으면 그 목표만 확인된 것으로 본다 (목표를 고르지 않은 옛 기록은 항목의 모든 목표)
      .filter((c) => c.result === 'confirmed' && (c.objectiveIds.length ? c.objectiveIds.includes(oid) : itemIds.includes(c.itemId)))
      .map((c) => dateOf.get(c.lessonId) ?? c.checkedAt.slice(0, 10))
      .filter((d) => inRange(d));
    let state: ObjectiveState = 'unassigned';
    if (confirmedDates.length) state = 'confirmed';
    else if (progressed.length) state = 'progressed';
    else if (planned.length) state = 'planned';
    // 반복 목적 확인: '새 학습'으로 같은 목표를 다루는 서로 다른 항목 중 두 번째부터 목적이 없으면 확인 요청
    occurrences.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const newItemsInOrder: string[] = [];
    const repeatWithoutPurpose: string[] = [];
    for (const oc of occurrences) {
      if (oc.activity !== 'new') continue;
      if (!newItemsInOrder.includes(oc.itemId)) {
        newItemsInOrder.push(oc.itemId);
        if (newItemsInOrder.length > 1 && !oc.purpose && !repeatWithoutPurpose.includes(oc.itemTitle)) repeatWithoutPurpose.push(oc.itemTitle);
      }
    }
    out.push({
      objectiveId: oid,
      code: o?.code ?? '',
      title: o?.title ?? `(미등록 목표 ${oid})`,
      required: required.has(oid),
      state,
      plannedDates: [...new Set(planned)].sort(),
      progressedDates: [...new Set(progressed)].sort(),
      confirmedDates: [...new Set(confirmedDates)].sort(),
      occurrences,
      itemIds,
      repeatWithoutPurpose,
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

export interface SupplementSuggestion {
  /** 보충이 필요한 목표 (선행 기초 확인 항목 중 이해 확인이 없는 것 + 검증된 선수 목표) */
  objectives: Array<{ objective: LearningObjective; reason: string; viaPrerequisiteOf?: string }>;
  /** 그 목표에 연결된 교재 학습항목 (보관되지 않은 교재 원본 기준) */
  items: Array<{ objectiveId: string; textbookId: string; textbookTitle: string; edition: string; itemId: string; itemTitle: string; range?: { from: number; to: number }; minutes: number }>;
  /** 연결된 교재 항목이 없는 목표 → 자료를 따로 준비해야 함 */
  objectivesWithoutMaterial: string[];
}

/**
 * 선수 학습이 부족할 때의 보충 제안.
 *  - 출발점: 선행 과정의 기초 확인 항목(requiredObjectiveIds) 중 이해 확인 기록이 없는 목표
 *  - 그 목표의 선수 목표는 담당자가 확인한 관계(prerequisiteVerified)만 따라가 함께 제안한다
 *  - 제안일 뿐이며, 보충 과정을 만들지·선행을 그대로 진행할지는 담당자가 확정한다
 */
export function supplementSuggestion(
  plan: Plan,
  objectives: LearningObjective[],
  textbooks: Array<{ id: string; title: string; edition: string; archived?: boolean; items: Array<{ id: string; title: string; objectiveIds: string[]; excluded: boolean; range?: { from: number; to: number }; minutes: number; order: number }> }>,
): SupplementSuggestion {
  const byId = new Map(objectives.map((o) => [o.id, o]));
  const gaps = advancePrerequisiteGaps(plan, objectives);
  const statuses = new Map(objectiveMap(plan, objectives).map((s) => [s.objectiveId, s]));
  const picked = new Map<string, { objective: LearningObjective; reason: string; viaPrerequisiteOf?: string }>();
  for (const g of gaps) picked.set(g.objective.id, g);
  // 검증된 선수 관계만 따라가기 (이해 확인된 목표는 제외)
  const queue = [...picked.keys()];
  while (queue.length) {
    const oid = queue.shift()!;
    const o = byId.get(oid);
    if (!o || !o.prerequisiteVerified) continue;
    for (const pre of o.prerequisiteObjectiveIds) {
      if (picked.has(pre)) continue;
      const po = byId.get(pre);
      if (!po) continue;
      if (statuses.get(pre)?.state === 'confirmed') continue;
      picked.set(pre, { objective: po, reason: `'${o.code} ${o.title}'의 선수 목표 (담당자 확인된 관계)`, viaPrerequisiteOf: oid });
      queue.push(pre);
    }
  }
  const items: SupplementSuggestion['items'] = [];
  const withMaterial = new Set<string>();
  for (const tb of textbooks) {
    if (tb.archived) continue;
    for (const it of [...tb.items].sort((a, b) => a.order - b.order)) {
      if (it.excluded) continue;
      for (const oid of it.objectiveIds) {
        if (!picked.has(oid)) continue;
        withMaterial.add(oid);
        items.push({ objectiveId: oid, textbookId: tb.id, textbookTitle: tb.title, edition: tb.edition, itemId: it.id, itemTitle: it.title, range: it.range, minutes: it.minutes });
      }
    }
  }
  return {
    objectives: [...picked.values()],
    items,
    objectivesWithoutMaterial: [...picked.keys()].filter((k) => !withMaterial.has(k)),
  };
}
