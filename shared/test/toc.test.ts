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

describe('2단 목차 PDF', () => {
  const it2 = (str: string, x: number, y: number, width: number) => ({ str, transform: [1, 0, 0, 1, x, y], width });

  it('왼쪽 단을 모두 읽은 뒤 오른쪽 단을 읽는다', () => {
    const items = [
      // 왼쪽 단 (x 50~260), 오른쪽 단 (x 320~540)
      it2('1단원 중심 생각', 50, 700, 90),
      it2('3단원 주장하는 글', 320, 700, 100),
      it2('1. 중심 문장 찾기', 60, 680, 90), it2('......', 160, 680, 60), it2('12', 245, 680, 12),
      it2('1. 주장과 근거', 330, 680, 80), it2('......', 420, 680, 60), it2('60', 525, 680, 12),
      it2('2. 문단 요약하기', 60, 660, 90), it2('......', 160, 660, 60), it2('24', 245, 660, 12),
      it2('2. 근거의 타당성', 330, 660, 85), it2('......', 420, 660, 60), it2('72', 525, 660, 12),
      it2('2단원 설명하는 글', 50, 640, 95), it2('36', 245, 640, 12),
      it2('4단원 추론하며 읽기', 320, 640, 105), it2('84', 525, 640, 12),
    ];
    const lines = textItemsToLines(items);
    expect(lines).toEqual([
      '1단원 중심 생각',
      '1. 중심 문장 찾기 ...... 12',
      '2. 문단 요약하기 ...... 24',
      '2단원 설명하는 글 36',
      '3단원 주장하는 글',
      '1. 주장과 근거 ...... 60',
      '2. 근거의 타당성 ...... 72',
      '4단원 추론하며 읽기 84',
    ]);
    const p = parseToc(lines.join('\n'), { lastPage: 95 });
    expect(p.items.map((i) => `${i.title}:${i.range!.from}-${i.range!.to}`)).toEqual([
      '1. 중심 문장 찾기:12-23',
      '2. 문단 요약하기:24-35',
      '2단원 설명하는 글:36-59',
      '1. 주장과 근거:60-71',
      '2. 근거의 타당성:72-83',
      '4단원 추론하며 읽기:84-95',
    ]);
  });

  it('1단 목차에서 제목과 점선 사이의 빈칸으로는 나누지 않는다', () => {
    const items = [
      it2('Chapter 3', 72, 700, 60), it2('........', 300, 700, 120), it2('36', 500, 700, 12),
      it2('1. 중심 문장 찾기', 72, 680, 90), it2('12', 500, 680, 12),
    ];
    expect(textItemsToLines(items)).toEqual(['Chapter 3 ........ 36', '1. 중심 문장 찾기 12']);
  });
});

describe('2차 리뷰에서 찾은 목차 인식 오류', () => {
  const it2 = (str: string, x: number, y: number, width: number) => ({ str, transform: [1, 0, 0, 1, x, y], width });

  it('제목 안의 띄어 쓴 숫자를 쪽번호로 붙이지 않는다 (점선 뒤에서만 붙임)', async () => {
    const { normalizeOcrLine } = await import('../src/toc.ts');
    expect(normalizeOcrLine('2. 분수의 덧셈 2 3')).toBe('2. 분수의 덧셈 2 3');
    expect(normalizeOcrLine('2. 분수의 덧셈 ...... 2 3')).toBe('2. 분수의 덧셈 ........ 23');
  });

  it('대문자 한 글자 단어와 연도는 점선 찌꺼기로 지우지 않는다', async () => {
    const { normalizeOcrLine } = await import('../src/toc.ts');
    expect(normalizeOcrLine('1. 독해 Part A 12')).toBe('1. 독해 Part A 12');
    expect(normalizeOcrLine('3단원 모의고사 2023 60')).toBe('3단원 모의고사 2023 60');
    // 점선 찌꺼기는 여전히 고친다
    expect(normalizeOcrLine('1. 중심 문장 찾기 Ce 12')).toBe('1. 중심 문장 찾기 ........ 12');
    expect(normalizeOcrLine('1. 설명 방법 파악하기 20200 36')).toBe('1. 설명 방법 파악하기 ........ 36');
    expect(normalizeOcrLine('1. 설명 방법 파악하기 2o0e 36')).toBe('1. 설명 방법 파악하기 ........ 36');
  });

  it("'PART 1', 'Chapter 3' 의 숫자를 쪽번호로 읽지 않는다", () => {
    const { lines } = classifyTocLines('PART 1\n1. 중심 문장 찾기 12\nChapter 3\n2. 요약하기 24\nUnit 2 36');
    expect(lines.map((l) => [l.kind, l.title, l.page])).toEqual([
      ['heading', 'PART 1', undefined],
      ['item', '1. 중심 문장 찾기', 12],
      ['heading', 'Chapter 3', undefined],
      ['item', '2. 요약하기', 24],
      ['heading', 'Unit 2', 36],
    ]);
  });

  it('같은 쪽에서 시작하는 두 항목은 범위가 겹치지 않게 앞 항목을 한 쪽으로 두고 경고한다', () => {
    const p = parseToc('1. 개념 정리 12\n2. 확인 문제 12\n3. 응용 24', { lastPage: 30 });
    expect(p.items.map((i) => i.range)).toEqual([{ from: 12, to: 12 }, { from: 12, to: 23 }, { from: 24, to: 30 }]);
    expect(p.issues.some((x) => x.message.includes('같은 12쪽'))).toBe(true);
  });

  it("왼쪽 조각이 '1' 이나 'PART 1' 뿐이면 2단으로 나누지 않는다", () => {
    const items = [
      it2('PART 1', 72, 700, 40), it2('중심 생각 익히기', 300, 700, 90),
      it2('1', 72, 680, 6), it2('중심 문장 찾기 ...... 12', 300, 680, 150),
      it2('2', 72, 660, 6), it2('문단 요약하기 ...... 24', 300, 660, 150),
    ];
    expect(textItemsToLines(items)).toEqual(['PART 1 중심 생각 익히기', '1 중심 문장 찾기 ...... 12', '2 문단 요약하기 ...... 24']);
  });

  it('넓은 빈칸이 한 줄에만 있으면 2단으로 보지 않는다', () => {
    const items = [
      it2('1. 중심 문장 찾기 12', 72, 700, 110), it2('부록 해설', 400, 700, 60),
      it2('2. 문단 요약하기 24', 72, 680, 110),
      it2('3. 글의 구조 36', 72, 660, 100),
    ];
    expect(textItemsToLines(items)).toEqual(['1. 중심 문장 찾기 12 부록 해설', '2. 문단 요약하기 24', '3. 글의 구조 36']);
  });
});

describe('사진·스캔 2단 목차의 읽는 순서 (글자 인식 단어 위치 사용)', () => {
  // 글자 높이 20px, 단어 사이 10px 로 단어 위치를 흉내 낸다
  const line = (y: number, x: number, words: string[]) => {
    let cx = x;
    const ws = words.map((t) => {
      const w = { text: t, bbox: { x0: cx, y0: y, x1: cx + t.length * 12, y1: y + 20 } };
      cx = w.bbox.x1 + 10;
      return w;
    });
    return { bbox: { x0: x, y0: y, x1: cx - 10, y1: y + 20 }, words: ws };
  };

  it('엔진이 두 단을 따로 읽어도, 한 줄로 이어 붙여도 왼쪽 단 → 오른쪽 단 순서로 만든다', async () => {
    const { ocrLinesToTocLines } = await import('../src/toc.ts');
    const leftCol = [
      line(100, 40, ['1단원', '중심', '생각']),
      line(140, 50, ['1.', '중심', '문장', '찾기', 'Ce', '12']),
      line(180, 50, ['2.', '문단', '요약하기', '......', '24']),
    ];
    const rightCol = [
      line(101, 600, ['2단원', '설명하는', '글']),
      line(141, 610, ['1.', '설명', '방법', '20200', '36']),
      line(181, 610, ['2.', '글의', '구조', '......', '48']),
    ];
    const expected = ['1단원 중심 생각', '1. 중심 문장 찾기 ........ 12', '2. 문단 요약하기 ........ 24', '2단원 설명하는 글', '1. 설명 방법 ........ 36', '2. 글의 구조 ........ 48'];
    // 엔진이 오른쪽 단을 먼저 내놓은 경우
    expect(ocrLinesToTocLines([...rightCol, ...leftCol])).toEqual(expected);
    // 엔진이 같은 높이의 두 단을 한 줄로 합친 경우
    const merged = leftCol.map((l, i) => ({ bbox: { ...l.bbox, x1: rightCol[i].bbox.x1 }, words: [...l.words, ...rightCol[i].words] }));
    expect(ocrLinesToTocLines(merged)).toEqual(expected);
    const p = parseToc(expected.join('\n'), { lastPage: 59 });
    expect(p.items.map((i) => `${i.range!.from}-${i.range!.to}`)).toEqual(['12-23', '24-35', '36-47', '48-59']);
  });

  it('1단 목차는 그대로 위에서 아래로 읽는다', async () => {
    const { ocrLinesToTocLines } = await import('../src/toc.ts');
    const lines = [line(140, 50, ['1.', '중심', '문장', '찾기', '......', '12']), line(100, 40, ['1단원', '중심', '생각']), line(180, 50, ['2.', '문단', '요약하기', '24'])];
    expect(ocrLinesToTocLines(lines)).toEqual(['1단원 중심 생각', '1. 중심 문장 찾기 ........ 12', '2. 문단 요약하기 24']);
  });
});

describe('실제 글자 인식 엔진 결과로 2단 목차 읽기', () => {
  it('엔진이 두 단을 한 줄로 합친 실제 결과를 단 순서·한글 띄어쓰기대로 만든다', async () => {
    const { readFileSync } = await import('node:fs');
    const { ocrLinesToTocLines } = await import('../src/toc.ts');
    const f = JSON.parse(readFileSync(new URL('./fixtures/ocr-2col-toc.json', import.meta.url), 'utf8'));
    const lines = ocrLinesToTocLines(f.lines);
    expect(lines).toEqual([
      '1단원 중심 생각',
      '1. 중심 문장 찾기 ........ 12',
      '2. 문단 요약하기 ........ 24',
      '3단원 주장하는 글',
      '1. 주장과 근거 ........ 60',
      '2단원 설명하는 글',
      '1. 설명 방법 파악하기 ........ 36',
      '2. 글의 구조 파악하기 ........ 48',
      '3. 단원 정리 ........ 56',
    ]);
  });
});
