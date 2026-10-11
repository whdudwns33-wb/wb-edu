import { describe, expect, it } from 'vitest';
import { classifyTocLines, parseToc, textItemsToLines } from '../src/toc.ts';

const TOC = `목차
1단원 중심 생각
  1. 중심 문장 찾기 ............ 12
  2. 문단 요약하기 ·············· 24
2단원 설명하는 글 36
  1. 설명 방법 파악하기 36
  2. 글의 구조 파악하기 p.48
단원 정리 활동
3단원 종합 평가 ........ 60
정답과 해설 ........ 72`;

describe('목차 텍스트 인식', () => {
  it('대단원·항목·쪽번호를 구분한다', () => {
    const { lines, skipped } = classifyTocLines(TOC);
    expect(lines.map((l) => `${l.kind}:${l.title}:${l.page ?? ''}`)).toEqual([
      'heading:1단원 중심 생각:',
      'item:1. 중심 문장 찾기:12',
      'item:2. 문단 요약하기:24',
      'heading:2단원 설명하는 글:36',
      'item:1. 설명 방법 파악하기:36',
      'item:2. 글의 구조 파악하기:48',
      'heading:3단원 종합 평가:60',
      'item:정답과 해설:72',
    ]);
    expect(skipped.map((s) => s.text)).toEqual(['단원 정리 활동']);
  });

  it('다음 시작 쪽 − 1 로 범위를 만들고 마지막은 본문 마지막 쪽까지', () => {
    const p = parseToc(TOC, { lastPage: 80, minutesPerPage: 3, idGen: (() => { let n = 0; return () => `t${++n}`; })() });
    expect(p.items.map((i) => `${i.unit}|${i.title}|${i.range!.from}-${i.range!.to}|${i.minutes}`)).toEqual([
      '1단원 중심 생각|1. 중심 문장 찾기|12-23|35',
      '1단원 중심 생각|2. 문단 요약하기|24-35|35',
      '2단원 설명하는 글|1. 설명 방법 파악하기|36-47|35',
      '2단원 설명하는 글|2. 글의 구조 파악하기|48-59|35',
      // 대단원(60쪽)이 첫 하위 항목(72쪽)보다 앞서면 사이 쪽을 대단원 이름의 항목으로 보존
      '3단원 종합 평가|3단원 종합 평가|60-71|35',
      '3단원 종합 평가|정답과 해설|72-80|25',
    ]);
    // 모든 쪽(12~80)이 빠짐없이 한 번씩 덮인다
    const covered = p.items.flatMap((i) => Array.from({ length: i.range!.to - i.range!.from + 1 }, (_, k) => i.range!.from + k));
    expect(covered).toEqual(Array.from({ length: 69 }, (_, k) => 12 + k));
    expect(p.items.every((i) => i.minutesSource === 'estimated' && i.progressUnit === 'page')).toBe(true);
    expect(p.issues.some((i) => i.message.includes('건너뜀'))).toBe(true);
  });

  it('12~23쪽처럼 범위는 양 끝 포함이며 한 쪽짜리는 분할 불가', () => {
    const p = parseToc('가 10\n나 11\n다 13', { lastPage: 13 });
    expect(p.items.map((i) => [i.range, i.splittable])).toEqual([
      [{ from: 10, to: 10 }, false],
      [{ from: 11, to: 12 }, true],
      [{ from: 13, to: 13 }, false],
    ]);
  });

  it('마지막 쪽을 모르면 경고하고, 쪽이 줄어들면 경고한다', () => {
    const p = parseToc('가 ..... 30\n나 ..... 20');
    expect(p.issues.some((i) => i.message.includes('앞 줄(30)'))).toBe(true);
    expect(p.issues.some((i) => i.message.includes('본문 마지막 쪽'))).toBe(true);
  });

  it('쪽번호 줄이 없으면 오류', () => {
    const p = parseToc('그냥 글\n쪽 없음');
    expect(p.items).toHaveLength(0);
    expect(p.issues[0].level).toBe('error');
  });

  it('PDF 텍스트 조각을 y 좌표로 줄 묶음', () => {
    const lines = textItemsToLines([
      { str: '12', transform: [1, 0, 0, 1, 400, 700], width: 10 },
      { str: '중심 문장 찾기', transform: [1, 0, 0, 1, 72, 700.5], width: 80 },
      { str: '.......', transform: [1, 0, 0, 1, 160, 700], width: 200 },
      { str: '문단 요약하기', transform: [1, 0, 0, 1, 72, 680], width: 80 },
      { str: '24', transform: [1, 0, 0, 1, 400, 680], width: 10 },
    ]);
    expect(lines).toEqual(['중심 문장 찾기 ....... 12', '문단 요약하기 24']);
    expect(parseToc(lines.join('\n'), { lastPage: 30 }).items.map((i) => i.range)).toEqual([
      { from: 12, to: 23 },
      { from: 24, to: 30 },
    ]);
  });
});

describe('하위 항목 없는 대단원', () => {
  it('자기 이름을 대단원으로 갖는 항목이 된다', () => {
    const p = parseToc('Unit 1 Main Idea\n1. A ..... 12\nUnit 2 Review Test ..... 20', { lastPage: 25 });
    expect(p.items.map((i) => `${i.unit}|${i.title}|${i.range!.from}-${i.range!.to}`)).toEqual(['Unit 1 Main Idea|1. A|12-19', 'Unit 2 Review Test|Unit 2 Review Test|20-25']);
  });
});

describe('글자 인식(OCR) 결과 정리', () => {
  it('점선·가운뎃점을 통일하고 줄 끝 숫자 사이 공백을 붙여 목차로 읽히게 한다', async () => {
    const { normalizeOcrLine } = await import('../src/toc.ts');
    expect(normalizeOcrLine('1. 중심 문장 찾기 · · · · · · 1 2')).toBe('1. 중심 문장 찾기 ........ 12');
    expect(normalizeOcrLine('2. 문단 요약하기 …… 24')).toBe('2. 문단 요약하기 ........ 24');
    expect(normalizeOcrLine('|  3단원  종합 평가 ....  60 ')).toBe('3단원 종합 평가 ........ 60');
    // 실제 브라우저 OCR에서 점선이 'Ce' 로 읽힌 결과 (2026-10-11 확인)
    expect(normalizeOcrLine('1. 중심 문장 찾기 Ce 12')).toBe('1. 중심 문장 찾기 ........ 12');
    expect(normalizeOcrLine('2단원 설명하는 글 Ce ee 36')).toBe('2단원 설명하는 글 ........ 36');
    // 스캔 PDF OCR에서 점선이 숫자 덩어리로 읽힌 결과 (2026-10-11 확인)
    expect(normalizeOcrLine('1. 설명 방법 파악하기 20200 36')).toBe('1. 설명 방법 파악하기 ........ 36');
    // 제목 안의 실제 숫자(연도 등)는 건드리지 않는다
    expect(normalizeOcrLine('2025 수능 대비 12')).toBe('2025 수능 대비 12');
    expect(normalizeOcrLine('1. 분수 2 12')).toBe('1. 분수 2 12');
    // 영어 제목의 실제 단어는 지우지 않는다
    expect(normalizeOcrLine('Unit 3 Review Test 60')).toBe('Unit 3 Review Test 60');
    expect(normalizeOcrLine('3단원 Test 60')).toBe('3단원 Test 60');
    const p = parseToc(['1. 중심 문장 찾기 · · · · · · 1 2', '2. 문단 요약하기 …… 24'].map(normalizeOcrLine).join('\n'), { lastPage: 30 });
    expect(p.items.map((i) => i.range)).toEqual([{ from: 12, to: 23 }, { from: 24, to: 30 }]);
  });
});
