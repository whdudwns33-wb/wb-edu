/**
 * 목차 텍스트 → 학습항목 변환.
 *
 * 입력은 사용자가 제공한 목차 텍스트(교재 PDF에서 추출했거나 직접 복사한 것)다.
 * 교재명만으로 목차를 만들지 않으며, 결과는 미리보기에서 확인한 뒤에만 적용한다.
 *
 * 규칙
 *  - 줄 끝의 쪽번호를 읽는다: "중심 문장 찾기 ........ 12", "중심 문장 찾기 12", "중심 문장 찾기 p.12"
 *  - 대단원 머리 줄: "1단원 …", "제1장 …", "Ⅰ. …", "PART 1", "Unit 1", "Chapter 1" (쪽번호가 있어도 됨)
 *  - 항목의 범위: 시작 = 자기 쪽, 끝 = 다음 항목(또는 다음 대단원)의 시작 − 1. 마지막 항목은 lastPage 까지.
 *  - 쪽번호가 없는 일반 줄은 건너뛰고 경고로 알린다. 쪽이 줄어들면 경고한다.
 *  - 소요시간은 쪽당 분(minutesPerPage)으로 추정하고 '추정'으로 표시한다.
 */
import type { LearningItem } from './types.ts';
import type { ImportIssue, ImportPreview } from './importer.ts';

export interface TocOptions {
  /** 마지막 항목의 끝 쪽 (본문 마지막 쪽). 없으면 마지막 항목은 한 쪽으로 두고 경고 */
  lastPage?: number;
  /** 쪽당 예상 분 (기본 3) */
  minutesPerPage?: number;
  idGen?: () => string;
}

const HEADING_RE = /^\s*((제\s*\d+\s*(단원|장|부|편|과))|(\d+\s*(단원|장|부|과))|([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+\s*[.)]?)|((PART|Part|UNIT|Unit|CHAPTER|Chapter|LESSON|Lesson)\s*\d+))(\s|[.:)]|$)/;
// 줄 끝 쪽번호: 점선·공백·가운뎃점 뒤의 숫자, 또는 p.12 / 12p / 12쪽
const PAGE_RE = /^(.*?)(?:[\s.·…‥_\-–—]+)(?:p\.?\s*)?(\d{1,4})\s*(?:p|쪽|페이지)?\s*$/i;

export interface TocLine {
  kind: 'heading' | 'item';
  title: string;
  page?: number;
  lineNo: number;
}

function cleanTitle(s: string): string {
  return s.replace(/[\s.·…‥_\-–—]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** 목차 텍스트를 줄 단위로 분류 */
export function classifyTocLines(text: string): { lines: TocLine[]; skipped: Array<{ lineNo: number; text: string }> } {
  const lines: TocLine[] = [];
  const skipped: Array<{ lineNo: number; text: string }> = [];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, i) => {
      const lineNo = i + 1;
      const line = raw.replace(/\t/g, ' ').trim();
      if (!line) return;
      // 목차 제목 줄·쪽번호만 있는 줄은 무시
      if (/^(목\s*차|차\s*례|contents)$/i.test(line) || /^\d{1,4}$/.test(line)) return;
      const m = PAGE_RE.exec(line);
      const isHeading = HEADING_RE.test(line);
      if (m && cleanTitle(m[1])) {
        lines.push({ kind: isHeading ? 'heading' : 'item', title: cleanTitle(m[1]), page: Number(m[2]), lineNo });
      } else if (isHeading) {
        lines.push({ kind: 'heading', title: cleanTitle(line), lineNo });
      } else {
        skipped.push({ lineNo, text: line });
      }
    });
  return { lines, skipped };
}

export function parseToc(text: string, opts: TocOptions = {}): ImportPreview {
  const idGen = opts.idGen ?? (() => globalThis.crypto?.randomUUID?.() ?? `toc-${Math.random().toString(36).slice(2)}`);
  const perPage = opts.minutesPerPage && opts.minutesPerPage > 0 ? opts.minutesPerPage : 3;
  const issues: ImportIssue[] = [];
  const { lines, skipped } = classifyTocLines(text);
  if (lines.length === 0) {
    return { items: [], issues: [{ row: 0, level: 'error', message: '쪽번호가 있는 목차 줄을 찾지 못했습니다. 각 줄 끝에 쪽번호가 있는지 확인하세요.' }], headers: [], rowCount: 0 };
  }
  for (const s of skipped.slice(0, 20)) issues.push({ row: s.lineNo, level: 'warning', message: `쪽번호가 없어 건너뜀: "${s.text.slice(0, 40)}"` });
  if (skipped.length > 20) issues.push({ row: 0, level: 'warning', message: `그 밖에 ${skipped.length - 20}줄을 건너뛰었습니다.` });

  // 쪽이 있는 대단원:
  //  - 하위 항목이 없으면 대단원 자체를 항목으로 쓴다
  //  - 첫 하위 항목이 대단원보다 뒤 쪽에서 시작하면, 그 사이 쪽이 사라지지 않도록 대단원 이름의 항목을 하나 더 만든다
  // (대단원 줄을 그대로 두어 이후 항목의 대단원 이름이 바뀌게 하고, 바로 뒤에 같은 이름의 항목을 붙인다)
  const effective: TocLine[] = lines.flatMap((l, i) => {
    if (l.kind !== 'heading' || l.page === undefined) return [l];
    const next = lines[i + 1];
    const needsOwnItem = !next || next.kind !== 'item' || (next.page !== undefined && next.page > l.page);
    return needsOwnItem ? [l, { ...l, kind: 'item' as const }] : [l];
  });

  // 시작 쪽이 있는 줄(항목·쪽 있는 대단원)의 순서 → 다음 시작 쪽으로 끝 쪽 계산
  const starts = effective.filter((l) => l.page !== undefined);
  for (let i = 1; i < starts.length; i++) {
    if (starts[i].page! < starts[i - 1].page!) issues.push({ row: starts[i].lineNo, level: 'warning', message: `쪽번호가 앞 줄(${starts[i - 1].page})보다 작습니다: ${starts[i].title} ${starts[i].page}` });
  }
  const nextStartAfter = (idx: number): number | undefined => {
    const cur = effective[idx];
    for (let j = idx + 1; j < effective.length; j++) {
      const p = effective[j].page;
      if (p !== undefined && p > cur.page!) return p;
    }
    return undefined;
  };

  const items: LearningItem[] = [];
  let unit = '';
  let order = 0;
  effective.forEach((l, idx) => {
    if (l.kind === 'heading') {
      unit = l.title;
      return;
    }
    if (l.page === undefined) return;
    const next = nextStartAfter(idx);
    let to: number;
    if (next !== undefined) to = next - 1;
    else if (opts.lastPage && opts.lastPage >= l.page) to = opts.lastPage;
    else {
      to = l.page;
      issues.push({ row: l.lineNo, level: 'warning', message: `마지막 항목 '${l.title}'의 끝 쪽을 알 수 없어 ${l.page}쪽 한 쪽으로 두었습니다. '본문 마지막 쪽'을 입력하세요.` });
    }
    if (to < l.page) to = l.page;
    const pages = to - l.page + 1;
    order += 1;
    items.push({
      id: idGen(),
      unit: unit || l.title,
      subunit: '',
      order,
      title: l.title,
      objective: '',
      objectiveIds: [],
      progressUnit: 'page',
      range: { from: l.page, to },
      quantity: 1,
      minutes: Math.max(5, Math.round((pages * perPage) / 5) * 5),
      minutesSource: 'estimated',
      splittable: pages >= 2,
      prerequisiteItemIds: [],
      usage: 'both',
      excluded: false,
      extra: {},
    });
  });
  if (items.length) issues.unshift({ row: 0, level: 'warning', message: `${items.length}개 항목을 만들었습니다. 소요시간은 쪽당 ${perPage}분으로 추정했으니 실제에 맞게 고치세요. 정답·해설·부록은 교재의 제외 범위에 넣으세요.` });
  return { items, issues, headers: ['대단원', '제목', '시작', '끝'], rowCount: lines.length };
}

/**
 * PDF 텍스트 조각(pdf.js getTextContent 의 items)을 줄로 묶는다.
 * 같은 y 좌표(허용 오차 2)의 조각을 x 순서로 이어 붙이고, 위에서 아래 순서로 정렬한다.
 */
export function textItemsToLines(items: Array<{ str: string; transform: number[]; width?: number }>): string[] {
  const rows: Array<{ y: number; parts: Array<{ x: number; str: string; w: number }> }> = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, str: it.str, w: it.width ?? 0 });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      let out = '';
      let lastEnd = -Infinity;
      for (const p of parts) {
        // 조각 사이가 떨어져 있으면 공백을 넣는다
        if (out && p.x - lastEnd > 1) out += ' ';
        out += p.str;
        lastEnd = p.x + p.w;
      }
      return out.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}
