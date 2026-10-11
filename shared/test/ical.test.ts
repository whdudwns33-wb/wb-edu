import { describe, expect, it } from 'vitest';
import { baseSettings, makePlan, sampleWorld } from './helpers.ts';
import { SAMPLE_IDS } from '../src/sample.ts';
import { foldLine, planToIcal } from '../src/ical.ts';
import { cancelLesson } from '../src/scheduler.ts';

function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
}

describe('달력 파일(.ics) 내보내기', () => {
  const w = sampleWorld();
  const basic = w.curricula.find((c) => c.id === SAMPLE_IDS.curriculumBasic)!;
  const tb = new Map(w.tbs);
  const market = structuredClone(w.market);
  market.items[0].teachingNote = '첫 시간: 중심 문장 개념 설명; 예시 2개';
  tb.set(market.id, market);

  it('수업마다 종일 일정 하나, RFC 5545 형식(CRLF·줄 접기·이스케이프)을 지킨다', () => {
    const { plan } = makePlan(basic, tb, baseSettings());
    const ics = planToIcal(plan, { now: new Date('2026-10-11T00:00:00Z') });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const raw of ics.split('\r\n')) expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(75);
    const lines = unfold(ics);
    const events = lines.filter((l) => l === 'BEGIN:VEVENT').length;
    expect(events).toBe(plan.lessons.filter((l) => l.status === 'scheduled' || l.status === 'makeup').length);
    expect(lines).toContain('DTSTART;VALUE=DATE:20260406');
    expect(lines).toContain('DTEND;VALUE=DATE:20260407');
    expect(lines).toContain(`UID:${plan.lessons[0].id}@wb-curriculum-planner`);
    const first = lines.find((l) => l.startsWith('SUMMARY:'))!;
    expect(first).toContain('독해 마스터 5-1 12~23쪽');
    // 세미콜론·쉼표 이스케이프, 지도 메모는 강사용에만
    const desc = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(desc).toContain('지도 메모: 첫 시간: 중심 문장 개념 설명\\; 예시 2개');
    const student = unfold(planToIcal(plan, { audience: 'student' })).find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(student).not.toContain('지도 메모');
    expect(student).not.toContain('시간 배분');
  });

  it('휴강은 기본으로 빼고, 요청하면 CANCELLED 로 넣는다', () => {
    const { plan, ctx } = makePlan(basic, tb, baseSettings());
    const p = cancelLesson(plan, ctx, plan.lessons[2].id, '원장 출장', { by: 'x', at: '2026-04-01T00:00:00Z' }).plan;
    const base = unfold(planToIcal(p));
    expect(base.some((l) => l.includes('DTSTART;VALUE=DATE:20260413'))).toBe(false);
    const withCancelled = unfold(planToIcal(p, { includeCancelled: true }));
    const idx = withCancelled.indexOf('DTSTART;VALUE=DATE:20260413');
    expect(idx).toBeGreaterThan(0);
    expect(withCancelled.slice(idx, idx + 6).some((l) => l === 'STATUS:CANCELLED')).toBe(true);
  });

  it('줄 접기는 한글 글자를 자르지 않는다', () => {
    const long = 'SUMMARY:' + '가'.repeat(60);
    const folded = foldLine(long);
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });
});
