import { describe, expect, it } from 'vitest';
import { curriculumUnassignedMessage, setTextbookTrack } from '../src/assembler.ts';
import { sampleWorld } from './helpers.ts';

describe('과정 미배정과 교재별 트랙 지정', () => {
  it('미배정 차단 안내에 교재와 항목 제목을 표시하고 정상 과정은 통과한다', () => {
    const { curricula, tbs, market } = sampleWorld();
    const c = structuredClone(curricula[0]);
    expect(curriculumUnassignedMessage(c, tbs)).toBeNull();
    c.unassignedEntries = [c.sessions[0].entries[0]];
    const message = curriculumUnassignedMessage(c, tbs);
    expect(message).toContain(market.title);
    expect(message).toContain(market.items[0].title);
    expect(message).toContain('초안 저장은 가능합니다');
  });

  it('선택 교재의 차시·미배정 트랙만 바꾸고 다른 교재와 원본을 보존한다', () => {
    const { curricula } = sampleWorld();
    const c = structuredClone(curricula.find((x) => x.compositionMode === 'parallel')!);
    const target = c.sessions[0].entries[0].textbookId;
    c.sessions[0].entries[0] = { ...c.sessions[0].entries[0], fraction: 0.5, note: '분량·활동·순서 보존', repeatPurpose: 'deepen' };
    c.unassignedEntries = c.sessions[0].entries.map((e) => ({ ...e, id: `미배정-${e.id}` }));
    const before = structuredClone(c);
    const result = setTextbookTrack(c, target, 'advance');
    const oldEntries = [...before.sessions.flatMap((s) => s.entries), ...before.unassignedEntries];
    const newEntries = [...result.sessions.flatMap((s) => s.entries), ...result.unassignedEntries];
    expect(newEntries).toEqual(oldEntries.map((e) => e.textbookId === target ? { ...e, track: 'advance' } : e));
    expect(result.sessions.map(({ entries: _entries, ...s }) => s)).toEqual(before.sessions.map(({ entries: _entries, ...s }) => s));
    expect(result.textbooks).toEqual(before.textbooks);
    expect(c).toEqual(before);
  });
});
