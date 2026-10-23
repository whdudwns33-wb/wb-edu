/**
 * 과정 조립판: 날짜 없이 학습항목을 차시에 배치한다.
 *  - 순차형: A교재 완료 후 B교재
 *  - 병행형: 한 차시에 여러 교재
 *  - 보충형: 주교재 항목 뒤에 자체 활동지(attachToItemId)를 붙인다
 * 분할 불가 항목은 임의로 나누지 않고, 미배정 항목은 별도 목록에 남긴다.
 */
import type { Curriculum, CurriculumSession, CurriculumTextbookRef, LearningItem, SessionEntry, Textbook, Track } from './types.ts';
import { isRangedUnit, rangeCount, splitRangeByMinutes } from './units.ts';

export interface AssembleOptions {
  minutesPerSession: number;
  reviewMinutes: number;
  bufferMinutes: number;
  assessmentEvery: number;
  track?: Track;
  idGen?: () => string;
}

function gen(idGen?: () => string): string {
  return idGen?.() ?? globalThis.crypto?.randomUUID?.() ?? `as-${Math.random().toString(36).slice(2)}`;
}

/** 과정 참조에 따른 교재 항목 목록 (포함·제외 범위 적용, 제외 항목 제외, 순서대로) */
export function scopedItems(ref: CurriculumTextbookRef, textbook: Textbook): LearningItem[] {
  const inc = ref.includedItemIds ? new Set(ref.includedItemIds) : null;
  const exc = new Set(ref.excludedItemIds);
  return [...textbook.items]
    .filter((it) => !it.excluded && !exc.has(it.id) && (inc ? inc.has(it.id) : true))
    .sort((a, b) => a.order - b.order);
}

export function entryFromItem(textbookId: string, item: LearningItem, track: Track, idGen?: () => string, activity: SessionEntry['activity'] = 'new'): SessionEntry {
  return {
    id: gen(idGen),
    textbookId,
    itemId: item.id,
    track,
    activity: item.usage === 'homework' ? 'homework' : activity,
    minutes: item.minutes,
    portion: item.range && isRangedUnit(item.progressUnit) ? { ...item.range } : undefined,
  };
}

/**
 * 교재 참조와 구성 방식으로 차시를 자동 구성한다.
 * 결과는 '권장안'이 아니라 자동 초안이며, 검토 상태는 draft 로 둔다.
 */
export function autoAssemble(
  refs: CurriculumTextbookRef[],
  textbooks: Map<string, Textbook>,
  mode: Curriculum['compositionMode'],
  opts: AssembleOptions,
): { sessions: CurriculumSession[]; unassigned: SessionEntry[] } {
  const budget = Math.max(0, opts.minutesPerSession - opts.reviewMinutes - opts.bufferMinutes);
  const track = opts.track ?? 'current';
  const lists: Array<{ ref: CurriculumTextbookRef; items: LearningItem[] }> = refs
    .map((ref) => ({ ref, items: textbooks.has(ref.textbookId) ? scopedItems(ref, textbooks.get(ref.textbookId)!) : [] }));

  // 대기열 구성
  let queue: SessionEntry[] = [];
  const unassigned: SessionEntry[] = [];
  if (mode === 'sequential') {
    for (const l of lists) for (const it of l.items) queue.push(entryFromItem(l.ref.textbookId, it, track, opts.idGen));
  } else if (mode === 'parallel') {
    const maxLen = Math.max(0, ...lists.map((l) => l.items.length));
    for (let i = 0; i < maxLen; i++) {
      for (const l of lists) {
        const it = l.items[i];
        if (it) queue.push(entryFromItem(l.ref.textbookId, it, track, opts.idGen));
      }
    }
  } else {
    // 보충형: 주교재 순서대로, 보충 교재 항목은 attachToItemId 뒤에 붙인다 (연결 없는 보충 항목은 미배정)
    const main = lists.filter((l) => l.ref.role === 'main');
    const supp = lists.filter((l) => l.ref.role !== 'main');
    const attached = new Map<string, SessionEntry[]>();
    for (const s of supp) {
      for (const it of s.items) {
        const e = entryFromItem(s.ref.textbookId, it, track, opts.idGen, 'practice');
        if (it.attachToItemId) {
          const arr = attached.get(it.attachToItemId) ?? [];
          arr.push(e);
          attached.set(it.attachToItemId, arr);
        } else {
          unassigned.push(e);
        }
      }
    }
    for (const l of main) {
      for (const it of l.items) {
        queue.push(entryFromItem(l.ref.textbookId, it, track, opts.idGen));
        for (const e of attached.get(it.id) ?? []) queue.push(e);
        attached.delete(it.id);
      }
    }
    for (const rest of attached.values()) unassigned.push(...rest);
  }

  // 숙제 활동은 수업시간 없이 해당 차시에 붙는다
  const homework = queue.filter((e) => e.activity === 'homework');
  queue = queue.filter((e) => e.activity !== 'homework');

  const sessions: CurriculumSession[] = [];
  const itemIndex = new Map<string, LearningItem>();
  for (const l of lists) for (const it of l.items) itemIndex.set(it.id, it);
  let order = 1;
  let i = 0;
  let guard = 0;
  while (i < queue.length && guard++ < 10000) {
    const s: CurriculumSession = { id: gen(opts.idGen), order, title: `${order}차시`, entries: [] };
    let remaining = budget;
    const blocked = new Set<string>();
    let j = i;
    while (j < queue.length && remaining > 0) {
      const e = queue[j];
      if (blocked.has(e.textbookId)) { j++; continue; }
      const it = itemIndex.get(e.itemId);
      // 범위형(쪽·문항) 항목은 범위가 2 이상일 때만 나눈다. 한 쪽짜리를 분량 비율로 나누면
      // 같은 쪽이 두 차시에 들어가고, 첫 조각만 마쳐도 그 쪽 전체가 완료로 계산된다 (편성 엔진과 같은 기준)
      const span = e.portion ?? it?.range;
      const canSplit = !!it && it.splittable && (isRangedUnit(it.progressUnit) ? !!span && rangeCount(span) >= 2 : e.minutes >= 10);
      if (e.minutes <= remaining) {
        s.entries.push(e);
        remaining -= e.minutes;
        queue.splice(j, 1);
        continue;
      }
      // 나눌 수 있어도 한 단위(쪽·강) 분량이 회당 시간보다 크면 어느 차시에도 들어가지 않는다.
      // 이 항목만 미배정으로 두고 뒤 항목은 계속 배치한다 (편성 엔진과 같은 기준)
      if (it && canSplit && isRangedUnit(it.progressUnit) && span && Math.ceil(e.minutes / rangeCount(span)) > budget) {
        unassigned.push(e);
        queue.splice(j, 1);
        continue;
      }
      if (it && canSplit && remaining >= 5) {
        const ranged = isRangedUnit(it.progressUnit);
        if (ranged) {
          const sp = splitRangeByMinutes(span!, e.minutes, remaining);
          if (sp) {
            s.entries.push({ ...e, portion: sp.first, minutes: sp.firstMinutes });
            queue[j] = { ...e, id: gen(opts.idGen), portion: sp.rest, minutes: sp.restMinutes };
            remaining -= sp.firstMinutes;
          }
        } else {
          const fm = Math.floor(remaining / 5) * 5;
          if (fm >= 5 && fm < e.minutes) {
            const totalF = e.fraction ?? 1;
            const fr = Number(((fm / e.minutes) * totalF).toFixed(4));
            s.entries.push({ ...e, minutes: fm, fraction: fr });
            queue[j] = { ...e, id: gen(opts.idGen), minutes: e.minutes - fm, fraction: Number((totalF - fr).toFixed(4)) };
            remaining -= fm;
          }
        }
      }
      if (!it || !canSplit || e.minutes > budget) {
        if (e.minutes > budget && !canSplit) {
          // 어떤 차시에도 들어갈 수 없는 분할 불가 항목
          unassigned.push(e);
          queue.splice(j, 1);
          continue;
        }
      }
      blocked.add(e.textbookId);
      j++;
    }
    if (s.entries.length === 0) {
      // 남은 항목을 하나도 넣지 못함 → 전부 미배정
      unassigned.push(...queue.splice(i));
      break;
    }
    // 숙제 붙이기: 같은 항목의 숙제는 그 항목이 배치된 차시에
    for (const h of [...homework]) {
      if (s.entries.some((e) => e.itemId === h.itemId || itemIndex.get(h.itemId)?.attachToItemId === e.itemId)) {
        s.entries.push(h);
        homework.splice(homework.indexOf(h), 1);
      }
    }
    if (opts.assessmentEvery > 0 && order % opts.assessmentEvery === 0) s.marker = 'assessment';
    sessions.push(s);
    order++;
  }
  // 남은 숙제는 마지막 차시에
  if (homework.length && sessions.length) sessions[sessions.length - 1].entries.push(...homework);
  else unassigned.push(...homework);

  return { sessions, unassigned };
}

export function sessionMinutes(s: CurriculumSession): number {
  return s.entries.filter((e) => e.activity !== 'homework').reduce((a, e) => a + e.minutes, 0);
}

export function curriculumTotals(c: Curriculum): { sessions: number; minutes: number; homeworkMinutes: number; unassignedMinutes: number } {
  return {
    sessions: c.sessions.length,
    minutes: c.sessions.reduce((a, s) => a + sessionMinutes(s), 0),
    homeworkMinutes: c.sessions.reduce((a, s) => a + s.entries.filter((e) => e.activity === 'homework').reduce((x, e) => x + e.minutes, 0), 0),
    unassignedMinutes: c.unassignedEntries.reduce((a, e) => a + e.minutes, 0),
  };
}

/** 과정 원천의 미배정은 실행계획으로 넘기기 전에 명시적으로 정리한다. */
export function curriculumUnassignedMessage(c: Pick<Curriculum, 'unassignedEntries'>, textbooks: Map<string, Textbook>): string | null {
  if (c.unassignedEntries.length === 0) return null;
  const titles = c.unassignedEntries.map((e) => {
    const tb = textbooks.get(e.textbookId);
    return `${tb?.title ?? e.textbookId} · ${tb?.items.find((it) => it.id === e.itemId)?.title ?? e.itemId}`;
  });
  return `과정에 미배정 항목 ${c.unassignedEntries.length}건이 남아 있어 발행하거나 실행계획을 만들 수 없습니다: ${titles.join(', ')}. 과정 조립판에서 실제 차시에 배치하거나 포함·제외 범위를 명시적으로 정리하고 해당 배치를 빼세요. 초안 저장은 가능합니다.`;
}

/** 선택 교재의 트랙만 바꾸고 배치와 분량은 보존한다. */
export function setTextbookTrack(c: Curriculum, textbookId: string, track: Track): Curriculum {
  const update = (e: SessionEntry) => e.textbookId === textbookId ? { ...e, track } : e;
  return { ...c, sessions: c.sessions.map((s) => ({ ...s, entries: s.entries.map(update) })), unassignedEntries: c.unassignedEntries.map(update) };
}

/** 차시 번호·제목 재정렬 */
export function renumber(sessions: CurriculumSession[]): CurriculumSession[] {
  return sessions.map((s, i) => ({ ...s, order: i + 1, title: /^\d+차시$/.test(s.title) || !s.title ? `${i + 1}차시` : s.title }));
}

/** 항목 이동: 차시 간 또는 미배정 ↔ 차시 */
export function moveEntry(c: Curriculum, entryId: string, toSessionId: string | null, toIndex?: number): Curriculum {
  let found: SessionEntry | undefined;
  const sessions = c.sessions.map((s) => {
    const idx = s.entries.findIndex((e) => e.id === entryId);
    if (idx >= 0) {
      found = s.entries[idx];
      return { ...s, entries: s.entries.filter((e) => e.id !== entryId) };
    }
    return s;
  });
  let unassigned = c.unassignedEntries.filter((e) => e.id !== entryId);
  if (!found) found = c.unassignedEntries.find((e) => e.id === entryId);
  if (!found) return c;
  if (toSessionId === null) {
    unassigned = [...unassigned, found];
  } else {
    if (!sessions.some((s) => s.id === toSessionId)) return c;
    // 대상 차시는 새 객체로 만든다 (입력 과정의 차시를 바꾸지 않게)
    const moved = found;
    return {
      ...c,
      sessions: sessions.map((s) => {
        if (s.id !== toSessionId) return s;
        const entries = [...s.entries];
        entries.splice(toIndex ?? entries.length, 0, moved);
        return { ...s, entries };
      }),
      unassignedEntries: unassigned,
    };
  }
  return { ...c, sessions, unassignedEntries: unassigned };
}

/** 항목 분할 (분할 가능 항목만). 범위형은 at 위치(포함)까지 앞부분, 수량형은 분 단위 */
export function splitEntry(c: Curriculum, entryId: string, item: LearningItem, firstMinutes: number, idGen?: () => string): Curriculum {
  if (!item.splittable) throw new Error('분할할 수 없는 항목입니다.');
  const splitOne = (e: SessionEntry): [SessionEntry, SessionEntry] => {
    const span = e.portion ?? item.range;
    if (isRangedUnit(item.progressUnit) && span) {
      const sp = splitRangeByMinutes(span, e.minutes, firstMinutes);
      if (!sp) throw new Error('더 이상 나눌 수 없습니다.');
      return [
        { ...e, portion: sp.first, minutes: sp.firstMinutes },
        { ...e, id: gen(idGen), portion: sp.rest, minutes: sp.restMinutes },
      ];
    }
    if (firstMinutes <= 0 || firstMinutes >= e.minutes) throw new Error('분할 시간이 범위를 벗어났습니다.');
    const totalF = e.fraction ?? 1;
    const fr = Number(((firstMinutes / e.minutes) * totalF).toFixed(4));
    return [
      { ...e, minutes: firstMinutes, fraction: fr },
      { ...e, id: gen(idGen), minutes: e.minutes - firstMinutes, fraction: Number((totalF - fr).toFixed(4)) },
    ];
  };
  const replaceIn = (list: SessionEntry[]): SessionEntry[] => {
    const idx = list.findIndex((e) => e.id === entryId);
    if (idx < 0) return list;
    const entries = [...list];
    entries.splice(idx, 1, ...splitOne(list[idx]));
    return entries;
  };
  const found = c.sessions.some((s) => s.entries.some((e) => e.id === entryId)) || c.unassignedEntries.some((e) => e.id === entryId);
  if (!found) throw new Error('나눌 항목을 찾을 수 없습니다.');
  return { ...c, sessions: c.sessions.map((s) => ({ ...s, entries: replaceIn(s.entries) })), unassignedEntries: replaceIn(c.unassignedEntries) };
}

/** 같은 항목의 연속 조각 묶기 */
export function mergeEntries(c: Curriculum, entryIdA: string, entryIdB: string): Curriculum {
  // 두 조각이 같은 차시에 있어야 한다 (다른 차시면 아무 일도 하지 않은 채 끝나지 않고 알린다)
  if (!c.sessions.some((s) => s.entries.some((e) => e.id === entryIdA) && s.entries.some((e) => e.id === entryIdB))) {
    throw new Error('같은 차시 안의 두 조각만 묶을 수 있습니다. 먼저 한 차시로 옮기세요.');
  }
  const sessions = c.sessions.map((s) => {
    const ia = s.entries.findIndex((e) => e.id === entryIdA);
    const ib = s.entries.findIndex((e) => e.id === entryIdB);
    if (ia < 0 || ib < 0) return s;
    const a = s.entries[ia];
    const b = s.entries[ib];
    if (a.itemId !== b.itemId) throw new Error('같은 학습항목의 조각만 묶을 수 있습니다.');
    // 새 학습과 그 복습처럼 활동·트랙이 다르면 묶지 않는다 (한쪽이 사라진다)
    if (a.activity !== b.activity || a.track !== b.track) throw new Error('활동·트랙이 같은 조각만 묶을 수 있습니다.');
    // 범위는 바로 이어져야 한다 (12~15와 20~23을 묶으면 사이의 16~19까지 들어가 두 번 배치된다)
    if (a.portion && b.portion) {
      const [lo, hi] = a.portion.from <= b.portion.from ? [a.portion, b.portion] : [b.portion, a.portion];
      if (hi.from !== lo.to + 1) throw new Error(`이어진 범위만 묶을 수 있습니다 (${lo.from}~${lo.to}, ${hi.from}~${hi.to}).`);
    }
    const merged: SessionEntry = {
      ...a,
      minutes: a.minutes + b.minutes,
      portion: a.portion && b.portion ? { from: Math.min(a.portion.from, b.portion.from), to: Math.max(a.portion.to, b.portion.to) } : a.portion ?? b.portion,
      fraction: a.fraction !== undefined || b.fraction !== undefined ? Number(((a.fraction ?? 0) + (b.fraction ?? 0)).toFixed(4)) : undefined,
    };
    const entries = s.entries.filter((e) => e.id !== entryIdB).map((e) => (e.id === entryIdA ? merged : e));
    return { ...s, entries };
  });
  return { ...c, sessions };
}

/** 과정 복제: 학생 정보·검토 의견은 복제하지 않는다 */
export function cloneCurriculum(c: Curriculum, by: string, at: string, idGen?: () => string): Curriculum {
  const mapId = new Map<string, string>();
  const remapEntry = (e: SessionEntry): SessionEntry => {
    const id = gen(idGen);
    mapId.set(e.id, id);
    return { ...e, id };
  };
  return {
    ...structuredClone(c),
    id: gen(idGen),
    title: `${c.title} (복제)`,
    sessions: c.sessions.map((s) => ({ ...s, id: gen(idGen), entries: s.entries.map(remapEntry) })),
    unassignedEntries: c.unassignedEntries.map(remapEntry),
    curriculumVersion: 1,
    status: 'draft',
    origin: 'custom',
    reviewComments: [],
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    updatedBy: by,
    version: 1,
    archived: false,
  };
}
