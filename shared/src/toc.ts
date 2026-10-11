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
      let m = PAGE_RE.exec(line);
      const head = HEADING_RE.exec(line);
      const isHeading = !!head;
      // 'PART 1', 'Chapter 3', '제2장' 처럼 대단원 표시 안의 숫자를 쪽번호로 읽지 않는다
      if (m && head) {
        const pageStart = line.search(/\d{1,4}\s*(?:p|쪽|페이지)?\s*$/i);
        if (pageStart < head[0].trimEnd().length) m = null;
      }
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
    // 바로 다음 항목이 같은 쪽에서 시작하면 두 항목이 같은 범위를 겹쳐 시간이 두 번 잡히므로, 앞 항목은 그 한 쪽으로 둔다
    const nextLine = effective.slice(idx + 1).find((x) => x.page !== undefined && x.lineNo !== l.lineNo);
    const sharesStart = nextLine !== undefined && nextLine.page === l.page;
    const next = nextStartAfter(idx);
    let to: number;
    if (sharesStart) {
      to = l.page;
      issues.push({ row: l.lineNo, level: 'warning', message: `'${l.title}'과(와) 다음 항목이 같은 ${l.page}쪽에서 시작해 '${l.title}'을(를) ${l.page}쪽 한 쪽으로 두었습니다. 실제 범위를 확인하세요.` });
    } else if (next !== undefined) to = next - 1;
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

/** space: 앞 조각과 띄어 쓰는지 (글자 인식처럼 위치로 띄어쓰기를 알 수 없을 때만 지정) */
type Part = { x: number; str: string; w: number; space?: boolean };

function joinParts(parts: Part[]): string {
  let out = '';
  let lastEnd = -Infinity;
  for (const p of parts) {
    // 조각 사이가 떨어져 있으면 공백을 넣는다 (띄어쓰기를 따로 알려 준 조각은 그대로 따른다)
    if (out && (p.space ?? p.x - lastEnd > 1)) out += ' ';
    out += p.str;
    lastEnd = p.x + p.w;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * PDF 텍스트 조각(pdf.js getTextContent 의 items)을 줄로 묶는다.
 * 같은 y 좌표(허용 오차 2)의 조각을 x 순서로 이어 붙이고, 위에서 아래 순서로 정렬한다.
 *
 * 2단 목차: 한 줄 안에서 '쪽번호로 끝나는 조각' 뒤에 큰 빈칸(minColumnGap 이상)이 있고 그 뒤가
 * 점선·숫자만이 아닌 글자로 시작하면 단이 나뉜 것으로 본다. 이때 왼쪽 단을 위에서 아래로 모두 읽은 뒤
 * 오른쪽 단을 읽는다 (목차를 읽는 순서).
 */
export function textItemsToLines(items: Array<{ str: string; transform: number[]; width?: number }>, minColumnGap = 30): string[] {
  const rows: Array<{ y: number; parts: Part[] }> = [];
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
  rows.sort((a, b) => b.y - a.y);
  return splitColumns(rows.map((r) => r.parts), minColumnGap);
}

/**
 * 위에서 아래 순서의 줄(각 줄은 x 위치가 있는 조각들)을 목차 읽는 순서의 텍스트 줄로 만든다.
 * 2단이면 왼쪽 단을 모두 읽은 뒤 오른쪽 단을 읽는다. clean 은 판정 전에 조각 텍스트를 정리하는 함수(글자 인식용).
 */
function splitColumns(rows: Part[][], minColumnGap: number, clean: (s: string) => string = (s) => s): string[] {
  // 각 줄을 단 조각(segment)으로 나눈다
  const segRows = rows.map((r) => {
    const parts = [...r].sort((a, b) => a.x - b.x);
    const segs: Part[][] = [[]];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const cur = segs[segs.length - 1];
      if (cur.length) {
        const prev = cur[cur.length - 1];
        const gap = p.x - (prev.x + prev.w);
        const leftText = clean(joinParts(cur));
        // 오른쪽 조각은 그 줄의 나머지 전체로 본다 (글자 인식은 '1.' 과 제목을 따로 주므로)
        const rightText = clean(joinParts(parts.slice(i)));
        // 왼쪽 조각이 '제목 + 쪽번호' 꼴이어야 한다 ('1'이나 'PART 1' 처럼 숫자로 끝나는 머리말만으로는 단을 나누지 않음)
        const leftLine = /[A-Za-z가-힣]/.test(leftText) ? classifyTocLines(leftText).lines[0] : undefined;
        const leftIsEntry = leftLine?.page !== undefined;
        const looksLikeColumnBreak = gap >= minColumnGap && leftIsEntry && /[A-Za-z가-힣]/.test(rightText) && !/^[.·…‥_\-–—]/.test(rightText);
        if (looksLikeColumnBreak) {
          segs.push([p]);
          continue;
        }
      }
      cur.push(p);
    }
    return segs.filter((s) => s.length);
  });

  const splitStarts = segRows.flatMap((segs) => segs.slice(1).map((s) => s[0].x));
  // 한 줄만 나뉘어 보이는 것은 우연(넓은 빈칸이 있는 제목)일 수 있으므로, 두 줄 이상에서 나뉠 때만 2단으로 본다
  const splitRowCount = segRows.filter((segs) => segs.length > 1).length;
  if (splitStarts.length === 0 || splitRowCount < 2) return rows.map((r) => joinParts([...r].sort((a, b) => a.x - b.x))).filter(Boolean);

  // 오른쪽 단의 시작 x: 확실히 나뉜 조각들의 가장 왼쪽 시작점.
  // 이 경계를 모든 줄에 적용한다 (쪽번호 없는 대단원 줄도 두 단에 걸쳐 있을 수 있으므로).
  const colStart = Math.min(...splitStarts);
  const splitX = colStart - 5;
  const left: string[] = [];
  const right: string[] = [];
  rows.forEach((r, ri) => {
    const parts = [...r].sort((a, b) => a.x - b.x);
    let cut: number;
    if (segRows[ri].length > 1) {
      // 단 경계가 확실한 줄
      cut = segRows[ri][1][0].x;
    } else {
      // 대단원 줄처럼 쪽번호가 없어 확실하지 않은 줄: 오른쪽 단 시작 근처(내어쓰기 허용)의 넓은 빈칸에서 나눈다
      const i = parts.findIndex((p, k) => k > 0 && p.x - (parts[k - 1].x + parts[k - 1].w) >= minColumnGap && p.x >= colStart - 2 * minColumnGap);
      cut = i > 0 ? parts[i].x : splitX;
    }
    const l = joinParts(parts.filter((p) => p.x < cut));
    const rt = joinParts(parts.filter((p) => p.x >= cut));
    if (l) left.push(l);
    if (rt) right.push(rt);
  });
  return [...left, ...right];
}

/** 글자 인식 엔진(tesseract)이 준 줄·단어 위치. bbox 는 이미지 좌표(위가 0) */
export interface OcrLineInput {
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 엔진이 띄어쓰기를 넣은 줄 텍스트. 한글은 단어 위치가 글자 단위로 쪼개지고 겹치기도 해 위치로 띄어쓰기를 알 수 없다 */
  text?: string;
  words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
}

/**
 * 글자 인식 결과의 줄·단어 위치로 목차 줄을 만든다.
 * 엔진은 2단 목차의 두 단을 다른 덩어리로 읽거나 한 줄로 이어 붙이기도 하므로, 같은 높이의 줄을 다시 한 줄로 모은 뒤
 * PDF 2단 목차와 같은 규칙(제목+쪽번호 뒤 넓은 빈칸)으로 단을 나눈다. 빈칸 기준은 글자 높이에 비례한다.
 */
export function ocrLinesToTocLines(lines: OcrLineInput[]): string[] {
  const valid = lines.filter((l) => l.words.some((w) => w.text.trim()));
  if (valid.length === 0) return [];
  const heights = valid.map((l) => Math.max(1, l.bbox.y1 - l.bbox.y0)).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const sorted = [...valid].sort((a, b) => a.bbox.y0 + a.bbox.y1 - (b.bbox.y0 + b.bbox.y1));
  const rows: Array<{ top: number; bottom: number; parts: Part[] }> = [];
  for (const l of sorted) {
    const center = (l.bbox.y0 + l.bbox.y1) / 2;
    const row = rows.find((r) => center >= r.top && center <= r.bottom);
    const parts = wordParts(l);
    if (row) {
      row.parts.push(...parts);
      row.top = Math.min(row.top, l.bbox.y0);
      row.bottom = Math.max(row.bottom, l.bbox.y1);
    } else rows.push({ top: l.bbox.y0, bottom: l.bbox.y1, parts });
  }
  return splitColumns(
    rows.map((r) => r.parts),
    Math.max(20, medianHeight * 2.5),
    normalizeOcrLine,
  )
    .map(normalizeOcrLine)
    .filter(Boolean);
}

/** 줄의 단어를 조각으로: 띄어쓰기는 줄 텍스트에서 단어 사이에 빈칸이 있었는지로 정한다 */
function wordParts(l: OcrLineInput): Part[] {
  const words = l.words.filter((w) => w.text.trim());
  let pos = 0;
  return words.map((w, i) => {
    const part: Part = { x: w.bbox.x0, w: w.bbox.x1 - w.bbox.x0, str: w.text.trim() };
    if (l.text === undefined) return part;
    const idx = l.text.indexOf(part.str, pos);
    // 줄 텍스트에서 찾지 못한 단어는 띄어 쓴다 (글자를 붙여 잘못된 단어를 만들지 않도록)
    if (idx < 0) return { ...part, space: true };
    const between = l.text.slice(pos, idx);
    pos = idx + part.str.length;
    // 줄의 첫 단어는 같은 높이의 다른 줄과 이어질 때 띄어 쓴다
    return { ...part, space: i === 0 || /\s/.test(between) };
  });
}

/** OCR 결과를 목차 줄로 정리: 공백 정리, 점선 통일, 숫자 사이 잘못 들어간 공백 제거 */
export function normalizeOcrLine(s: string): string {
  let out = s
    .replace(/[|¦]/g, ' ')
    .replace(/[·•∙⋯…]+/g, '...')
    .replace(/(\.\s*){3,}/g, ' ........ ')
    // 점선 뒤 쪽번호가 '1 2'로 갈라져 읽힌 경우만 '12'로 붙인다 (제목 안의 '2 3' 같은 숫자는 건드리지 않음)
    .replace(/(\.{3,}\s*)(\d)\s+(\d{1,3})\s*$/, '$1$2$3')
    // 점선 끝이 밑줄·물결로 읽힌 찌꺼기 (예: '........ _36', '........ _ 12')
    .replace(/(\.{3,})\s*[_~=\-–—]+\s*(\d{1,4})\s*$/, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  // 점선을 글자로 잘못 읽은 짧은 조각(예: 'Ce', 'ee', '--')이 한글 제목과 쪽번호 사이에 남으면 점선으로 바꾼다.
  // 실제 단어('Part A', '1 B')를 지우지 않도록, 한글이 있는 줄에서 소문자나 문장부호가 섞인 2~3글자 조각만 다룬다.
  if (/[가-힣]/.test(out)) {
    out = out.replace(/(?:\s+(?=[A-Za-z.,:;'"`~\-_=]*[a-z.,:;'"`~\-_=])[A-Za-z.,:;'"`~\-_=]{2,3})+\s+(\d{1,4})$/, ' ........ $1');
    // 점선이 숫자·o·e·c 덩어리로 읽힌 경우 (예: '파악하기 20200 36'): 한글 바로 뒤, 쪽번호 바로 앞의 덩어리.
    // 제목의 연도('2023')를 지우지 않도록 숫자만이면 5자리 이상일 때만, 아니면 o·e·c·문장부호가 섞였을 때만 바꾼다.
    out = out.replace(/([가-힣)])\s+(?:\d{5,}|(?=[0-9oOeEcC.,:;'`~\-_]*[oOeEcC.,:;'`~\-_])[0-9oOeEcC.,:;'`~\-_]{3,})\s+(\d{1,4})$/, '$1 ........ $2');
  }
  return out;
}
