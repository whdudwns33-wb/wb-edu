import { describe, expect, it } from 'vitest';
import { sampleWorld, BY, AT } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import { autoAssemble, cloneCurriculum, curriculumTotals, mergeEntries, moveEntry, renumber, splitEntry } from '../src/assembler.ts';
import { previewImport } from '../src/importer.ts';

describe('과정 조립판 (시나리오 1·2·12)', () => {
  const base = { minutesPerSession: 60, reviewMinutes: 10, bufferMinutes: 5, assessmentEvery: 0 };

  it('학생·반 없이 교재만으로 표준과정을 만든다 (순차형)', () => {
    const { curricula } = sampleWorld();
    const basic = curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
    expect(basic.target).toBeTruthy();
    expect(basic.sessions.length).toBeGreaterThan(0);
    const totals = curriculumTotals(basic);
    expect(totals.minutes).toBe(240);
    expect(totals.unassignedMinutes).toBe(0);
    // 순차형: 모든 차시에 한 교재만
    expect(basic.sessions.every((s) => new Set(s.entries.map((e) => e.textbookId)).size === 1)).toBe(true);
  });

  it('병행형: 한 차시에 두 교재', () => {
    const { curricula } = sampleWorld();
    const p = curricula.find((c) => c.id === SAMPLE_IDS.curriculumParallel)!;
    expect(p.sessions).toHaveLength(8);
    for (const s of p.sessions) {
      expect(new Set(s.entries.map((e) => e.textbookId)).size).toBe(2);
      expect(s.entries.reduce((x, e) => x + e.minutes, 0)).toBe(45);
    }
  });

  it('보충형: 주교재 항목 뒤에 연결된 활동지가 붙는다', () => {
    const { curricula } = sampleWorld();
    const s = curricula.find((c) => c.id === SAMPLE_IDS.curriculumSupplement)!;
    const flat = s.sessions.flatMap((x) => x.entries);
    for (let i = 0; i < 8; i++) {
      const mainIdx = flat.findIndex((e) => e.itemId === `${SAMPLE_IDS.marketTextbook}-i${i + 1}`);
      const suppIdx = flat.findIndex((e) => e.itemId === `${SAMPLE_IDS.inhouseTextbook}-a${i + 1}`);
      expect(suppIdx).toBeGreaterThan(mainIdx);
    }
    expect(s.unassignedEntries).toHaveLength(0);
  });

  it('보충형에서 연결 없는 보충 항목은 미배정 목록에 남는다', () => {
    const { tbs, inhouse, market } = sampleWorld();
    const tb = structuredClone(inhouse);
    tb.items[0].attachToItemId = undefined;
    const map = new Map(tbs);
    map.set(tb.id, tb);
    const refs = [
      { textbookId: market.id, edition: market.edition, textbookVersion: 1, role: 'main' as const, includedItemIds: null, excludedItemIds: [] },
      { textbookId: tb.id, edition: tb.edition, textbookVersion: 1, role: 'supplement' as const, includedItemIds: null, excludedItemIds: [] },
    ];
    const r = autoAssemble(refs, map, 'supplement', base);
    expect(r.unassigned.map((e) => e.itemId)).toEqual([tb.items[0].id]);
  });

  it('분할 불가 항목은 임의로 나누지 않는다', () => {
    const { tbs, market } = sampleWorld();
    const tb = structuredClone(market);
    tb.items.forEach((it) => { it.splittable = false; it.minutes = 50; });
    const map = new Map(tbs);
    map.set(tb.id, tb);
    const refs = [{ textbookId: tb.id, edition: tb.edition, textbookVersion: 1, role: 'main' as const, includedItemIds: null, excludedItemIds: [] }];
    const r = autoAssemble(refs, map, 'sequential', base); // 45분 차시에 50분 항목 → 전부 미배정
    expect(r.sessions).toHaveLength(0);
    expect(r.unassigned).toHaveLength(8);
  });

  it('포함·제외 범위와 특정 단원만 적용', () => {
    const { tbs, market } = sampleWorld();
    const refs = [{ textbookId: market.id, edition: market.edition, textbookVersion: 1, role: 'main' as const, includedItemIds: [market.items[2].id, market.items[3].id], excludedItemIds: [market.items[3].id] }];
    const r = autoAssemble(refs, tbs, 'sequential', base);
    expect(r.sessions.flatMap((s) => s.entries).map((e) => e.itemId)).toEqual([market.items[2].id]);
  });

  it('이동·분할·묶기·재정렬', () => {
    const { curricula, market } = sampleWorld();
    let c = structuredClone(curricula.find((x) => x.id === SAMPLE_IDS.curriculumBasic)!);
    const e0 = c.sessions[0].entries[0];
    c = moveEntry(c, e0.id, null);
    expect(c.unassignedEntries.map((e) => e.id)).toContain(e0.id);
    c = moveEntry(c, e0.id, c.sessions[0].id, 0);
    expect(c.sessions[0].entries[0].id).toBe(e0.id);
    const item = market.items.find((i) => i.id === e0.itemId)!;
    c = splitEntry(c, e0.id, item, 15);
    expect(c.sessions[0].entries[0].minutes).toBe(15);
    expect(c.sessions[0].entries[1].itemId).toBe(e0.itemId);
    const a = c.sessions[0].entries[0];
    const b = c.sessions[0].entries[1];
    c = mergeEntries(c, a.id, b.id);
    expect(c.sessions[0].entries[0].minutes).toBe(a.minutes + b.minutes);
    expect(c.sessions[0].entries[0].portion).toEqual({ from: Math.min(a.portion!.from, b.portion!.from), to: Math.max(a.portion!.to, b.portion!.to) });
    const re = renumber([c.sessions[1], c.sessions[0]]);
    expect(re.map((s) => s.order)).toEqual([1, 2]);
  });

  it('과정 복제 시 검토 의견과 버전은 초기화되고 대상 정보만 유지된다', () => {
    const { curricula } = sampleWorld();
    const c = structuredClone(curricula.find((x) => x.id === SAMPLE_IDS.curriculumBasic)!);
    c.reviewComments.push({ id: 'rc', at: AT, by: BY, text: '검토' });
    c.curriculumVersion = 3;
    c.status = 'verified';
    const d = cloneCurriculum(c, BY, AT);
    expect(d.id).not.toBe(c.id);
    expect(d.reviewComments).toHaveLength(0);
    expect(d.curriculumVersion).toBe(1);
    expect(d.status).toBe('draft');
    expect(d.sessions.map((s) => s.id)).not.toContain(c.sessions[0].id);
    expect(d.sessions.flatMap((s) => s.entries).length).toBe(c.sessions.flatMap((s) => s.entries).length);
  });
});

describe('표 붙여넣기 가져오기', () => {
  it('머리글을 인식하고 범위·시간 오류를 보고한다', () => {
    const text = ['대단원\t소단원\t제목\t단위\t시작\t끝\t시간', '1단원\t1\t중심 문장\t쪽\t12\t23\t30', '1단원\t2\t요약\t쪽\t24\t35\t', '2단원\t1\t잘못\t쪽\t50\t40\t20', '2단원\t2\t누락 뒤\t쪽\t60\t70\t10'].join('\n');
    const p = previewImport(text);
    expect(p.items).toHaveLength(4); // 오류 행도 미리보기에 포함 (저장은 오류가 없을 때만)
    expect(p.items[0].range).toEqual({ from: 12, to: 23 });
    expect(p.items[2].range).toBeUndefined();
    expect(p.items[1].minutesSource).toBe('estimated');
    expect(p.issues.some((i) => i.level === 'error' && i.message.includes('범위 오류'))).toBe(true);
    expect(p.issues.some((i) => i.message.includes('누락'))).toBe(true);
  });

  it('머리글 없이도 기본 순서로 해석한다', () => {
    const p = previewImport('1단원,개념,소수의 곱셈,쪽,10,15,25');
    expect(p.items[0].title).toBe('소수의 곱셈');
    expect(p.items[0].minutes).toBe(25);
    expect(p.issues.some((i) => i.message.includes('기본 순서'))).toBe(true);
  });

  it('중복 행을 경고한다', () => {
    const p = previewImport('대단원\t제목\t단위\t시작\t끝\t시간\nA\t같음\t쪽\t1\t5\t10\nA\t같음\t쪽\t1\t5\t10');
    expect(p.issues.some((i) => i.message.includes('중복'))).toBe(true);
  });
});
