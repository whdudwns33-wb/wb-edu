/**
 * 표·엑셀 붙여넣기 가져오기.
 * 탭 또는 쉼표로 구분된 표를 학습항목으로 변환하고, 저장 전 미리보기와
 * 누락·중복·범위 오류를 돌려준다.
 *
 * 인식하는 열 머리글 (한글/영문, 순서 무관):
 *  대단원 | 소단원 | 제목 | 목표 | 단위 | 시작 | 끝 | 수량 | 시간 | 난이도 | 분할 | 선수 | 용도 | 준비물 | 메모
 * 머리글이 없으면 기본 순서로 해석한다: 대단원, 소단원, 제목, 단위, 시작, 끝, 시간
 */
import type { LearningItem, ProgressUnit } from './types.ts';
import { PROGRESS_UNIT_LABEL } from './types.ts';
import { isRangedUnit } from './units.ts';

export interface ImportIssue {
  row: number; // 1-based (머리글 제외)
  level: 'error' | 'warning';
  message: string;
}

export interface ImportPreview {
  items: LearningItem[];
  issues: ImportIssue[];
  headers: string[];
  rowCount: number;
}

const HEADER_ALIASES: Record<string, string> = {
  대단원: 'unit', 단원: 'unit', unit: 'unit',
  소단원: 'subunit', subunit: 'subunit',
  제목: 'title', 항목: 'title', 학습항목: 'title', title: 'title', name: 'title',
  목표: 'objective', 학습목표: 'objective', objective: 'objective',
  단위: 'progressUnit', 진도단위: 'progressUnit', unittype: 'progressUnit',
  시작: 'from', 시작쪽: 'from', from: 'from', start: 'from',
  끝: 'to', 끝쪽: 'to', to: 'to', end: 'to',
  수량: 'quantity', 개수: 'quantity', quantity: 'quantity',
  시간: 'minutes', 소요시간: 'minutes', 예상시간: 'minutes', 분: 'minutes', minutes: 'minutes',
  난이도: 'difficulty', difficulty: 'difficulty',
  분할: 'splittable', 분할가능: 'splittable', splittable: 'splittable',
  선수: 'prerequisites', 선수학습: 'prerequisites', prerequisites: 'prerequisites',
  용도: 'usage', 사용: 'usage', usage: 'usage',
  준비물: 'materials', materials: 'materials',
  메모: 'teachingNote', 지도메모: 'teachingNote', note: 'teachingNote',
  순서: 'order', order: 'order',
};

const UNIT_ALIASES: Record<string, ProgressUnit> = {
  단원: 'unit', 강: 'lesson', 쪽: 'page', 페이지: 'page', p: 'page', 문항: 'problem', 문제: 'problem',
  지문: 'passage', 어휘: 'vocab', 어휘묶음: 'vocab', 활동: 'activity', 차시: 'session',
  unit: 'unit', lesson: 'lesson', page: 'page', problem: 'problem', passage: 'passage', vocab: 'vocab', activity: 'activity', session: 'session',
};

const DEFAULT_ORDER = ['unit', 'subunit', 'title', 'progressUnit', 'from', 'to', 'minutes'];

function normHeader(h: string): string {
  return h.trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * 탭·쉼표 구분 표를 칸으로 나눈다 (RFC 4180 따옴표 규칙).
 * 엑셀에서 복사하면 쉼표·줄바꿈이 든 칸은 "…"로 감싸지고 칸 안의 따옴표는 ""로 적힌다.
 */
export function parseTable(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n');
  const delimiter = src.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false; // 지금 칸이 따옴표로 시작했는지
  let inQuotes = false;
  const endCell = () => {
    row.push(quoted ? cell : cell.trim());
    cell = '';
    quoted = false;
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim().length > 0)) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
      inQuotes = true;
    } else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else cell += ch;
  }
  endRow();
  return rows;
}

/** 0 이상의 정수만 숫자로 읽는다 ('12.5', '-3', '0x10', '1e2' 는 숫자가 아님) */
function intOf(s: string): number {
  return /^\d{1,6}$/.test(s) ? Number(s) : NaN;
}

export function previewImport(text: string, opts: { idGen?: () => string; defaultUnit?: ProgressUnit; defaultMinutes?: number } = {}): ImportPreview {
  const idGen = opts.idGen ?? (() => (globalThis.crypto?.randomUUID?.() ?? `imp-${Math.random().toString(36).slice(2)}`));
  const rows = parseTable(text);
  const issues: ImportIssue[] = [];
  if (rows.length === 0) return { items: [], issues: [{ row: 0, level: 'error', message: '붙여넣은 내용이 없습니다.' }], headers: [], rowCount: 0 };

  let headers: string[];
  let body: string[][];
  const first = rows[0].map(normHeader);
  const recognized = first.filter((h) => HEADER_ALIASES[h]).length;
  if (recognized >= 2) {
    headers = first.map((h) => HEADER_ALIASES[h] ?? `extra:${h}`);
    body = rows.slice(1);
  } else {
    headers = DEFAULT_ORDER;
    body = rows;
    issues.push({ row: 0, level: 'warning', message: '머리글을 인식하지 못해 기본 순서(대단원, 소단원, 제목, 단위, 시작, 끝, 시간)로 해석했습니다.' });
  }

  const items: LearningItem[] = [];
  // 항목 index → 붙여넣은 표의 행 번호 (순서 열이 있어도 오류 위치는 표의 행으로 알린다)
  const sourceRow = new Map<number, number>();
  // 항목 index → '선수' 칸의 글자 (모든 항목을 읽은 뒤 제목·순서로 연결한다)
  const prereqText = new Map<number, string>();
  const seenKeys = new Map<string, number>();
  body.forEach((cells, i) => {
    const rowNo = i + 1;
    const get = (key: string) => {
      const idx = headers.indexOf(key);
      return idx >= 0 ? (cells[idx] ?? '').trim() : '';
    };
    const title = get('title');
    const unitRaw = get('progressUnit').replace(/\s+/g, '').toLowerCase();
    const progressUnit: ProgressUnit = UNIT_ALIASES[unitRaw] ?? opts.defaultUnit ?? 'page';
    if (unitRaw && !UNIT_ALIASES[unitRaw]) issues.push({ row: rowNo, level: 'warning', message: `알 수 없는 단위 '${get('progressUnit')}' → '${PROGRESS_UNIT_LABEL[progressUnit]}'로 처리` });
    const fromS = get('from');
    const toS = get('to');
    const from = fromS ? intOf(fromS) : NaN;
    const to = toS ? intOf(toS) : NaN;
    const minutesS = get('minutes');
    const minutes = minutesS ? intOf(minutesS) : NaN;
    const quantityS = get('quantity');
    const quantity = quantityS ? intOf(quantityS) : NaN;
    // 숫자 칸에 숫자가 아닌 값이 있으면 조용히 바꾸지 않고 알린다
    if (fromS && !Number.isFinite(from)) issues.push({ row: rowNo, level: 'error', message: `시작 '${fromS}'은(는) 0 이상의 정수가 아닙니다.` });
    if (toS && !Number.isFinite(to)) issues.push({ row: rowNo, level: 'error', message: `끝 '${toS}'은(는) 0 이상의 정수가 아닙니다.` });
    if (minutesS && !Number.isFinite(minutes)) issues.push({ row: rowNo, level: 'warning', message: `시간 '${minutesS}'은(는) 분 단위 정수가 아니어서 추정값을 씁니다.` });
    if (quantityS && !(Number.isFinite(quantity) && quantity > 0)) issues.push({ row: rowNo, level: 'warning', message: `수량 '${quantityS}'은(는) 1 이상의 정수가 아니어서 1로 둡니다.` });

    if (!title && !get('unit') && !get('subunit')) {
      issues.push({ row: rowNo, level: 'error', message: '제목·단원이 모두 비어 있습니다.' });
      return;
    }
    if (!title) issues.push({ row: rowNo, level: 'warning', message: '제목이 비어 있어 소단원/단원명을 제목으로 사용합니다.' });

    let range: LearningItem['range'];
    if (isRangedUnit(progressUnit)) {
      if (Number.isFinite(from) && Number.isFinite(to)) {
        if (to < from) issues.push({ row: rowNo, level: 'error', message: `범위 오류: 끝(${to})이 시작(${from})보다 작습니다.` });
        else range = { from, to };
      } else if (Number.isFinite(from) && !toS) {
        range = { from, to: from };
        issues.push({ row: rowNo, level: 'warning', message: `끝이 비어 있어 ${from} 한 ${PROGRESS_UNIT_LABEL[progressUnit]}으로 두었습니다.` });
      } else if (fromS || toS) {
        // 숫자 오류는 위에서 알렸다
      } else {
        issues.push({ row: rowNo, level: 'error', message: `범위형 단위(${PROGRESS_UNIT_LABEL[progressUnit]})인데 시작·끝이 없습니다.` });
      }
    }

    let minutesFinal = minutes;
    let minutesSource: LearningItem['minutesSource'] = 'entered';
    if (!Number.isFinite(minutes) || minutes <= 0) {
      minutesFinal = opts.defaultMinutes ?? (range ? (range.to - range.from + 1) * 5 : 30);
      minutesSource = 'estimated';
      issues.push({ row: rowNo, level: 'warning', message: `소요시간이 없어 ${minutesFinal}분으로 추정했습니다.` });
    }

    const key = `${get('unit')}|${get('subunit')}|${title}|${range ? `${range.from}-${range.to}` : ''}`;
    if (seenKeys.has(key)) issues.push({ row: rowNo, level: 'warning', message: `${seenKeys.get(key)}행과 중복으로 보입니다.` });
    else seenKeys.set(key, rowNo);

    const splitRaw = get('splittable').toLowerCase();
    const splittable = splitRaw === '' ? (range ? range.to - range.from + 1 >= 2 : false) : ['y', 'yes', 'true', '예', '가능', 'o', '1'].includes(splitRaw);
    const usageRaw = get('usage');
    const usage: LearningItem['usage'] = /숙제|homework/.test(usageRaw) && /수업|class|둘|both/.test(usageRaw) ? 'both' : /숙제|homework/.test(usageRaw) ? 'homework' : /수업|class/.test(usageRaw) ? 'class' : 'both';
    const diffS = get('difficulty');
    const diffRaw = intOf(diffS);
    const difficulty = diffRaw >= 1 && diffRaw <= 5 ? (diffRaw as 1 | 2 | 3 | 4 | 5) : undefined;
    if (diffS && difficulty === undefined) issues.push({ row: rowNo, level: 'warning', message: `난이도 '${diffS}'은(는) 1~5 정수가 아니어서 비워 둡니다.` });
    const extra: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h.startsWith('extra:') && cells[idx]) extra[h.slice(6)] = cells[idx].trim();
    });
    const orderS = get('order');
    const orderRaw = intOf(orderS);
    if (orderS && !(orderRaw > 0)) issues.push({ row: rowNo, level: 'warning', message: `순서 '${orderS}'은(는) 1 이상의 정수가 아니어서 행 순서를 씁니다.` });

    sourceRow.set(items.length, rowNo);
    if (get('prerequisites')) prereqText.set(items.length, get('prerequisites'));
    items.push({
      id: idGen(),
      unit: get('unit'),
      subunit: get('subunit'),
      order: Number.isFinite(orderRaw) && orderRaw > 0 ? orderRaw : rowNo,
      title: title || get('subunit') || get('unit'),
      objective: get('objective'),
      objectiveIds: [],
      progressUnit,
      range,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      minutes: minutesFinal,
      minutesSource,
      difficulty,
      splittable,
      prerequisiteItemIds: [],
      usage,
      materials: get('materials') || undefined,
      teachingNote: get('teachingNote') || undefined,
      excluded: false,
      extra,
    });
  });

  // 범위 겹침 검사 (같은 단위)
  const rowOf = (it: LearningItem) => sourceRow.get(items.indexOf(it)) ?? 0;

  // 선수 학습 칸: 쉼표·세미콜론·슬래시로 나눈 각 값을 같은 표의 항목 제목, 또는 순서 번호로 찾는다
  for (const [idx, raw] of prereqText) {
    const it = items[idx];
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const tok of raw.split(/[,;/]/).map((t) => t.trim()).filter(Boolean)) {
      const byTitle = items.filter((x) => x.title === tok);
      const n = intOf(tok);
      const byOrder = Number.isFinite(n) ? items.filter((x) => x.order === n) : [];
      const hit = byTitle.length === 1 ? byTitle[0] : byOrder.length === 1 ? byOrder[0] : undefined;
      if (!hit || hit === it) unknown.push(tok);
      else if (!ids.includes(hit.id)) ids.push(hit.id);
    }
    it.prerequisiteItemIds = ids;
    if (unknown.length) issues.push({ row: rowOf(it), level: 'warning', message: `선수 학습 '${unknown.join(', ')}'을(를) 이 표의 항목 제목이나 순서 번호에서 찾지 못해 연결하지 않았습니다.` });
  }
  const ranged = items.filter((it) => it.range);
  for (let i = 0; i < ranged.length; i++) {
    for (let j = i + 1; j < ranged.length; j++) {
      const a = ranged[i];
      const b = ranged[j];
      if (a.progressUnit !== b.progressUnit) continue;
      if (a.range!.from <= b.range!.to && b.range!.from <= a.range!.to) {
        issues.push({ row: rowOf(b), level: 'warning', message: `'${a.title}'(${a.range!.from}~${a.range!.to})과 '${b.title}'(${b.range!.from}~${b.range!.to}) 범위가 겹칩니다.` });
      }
    }
  }
  // 범위 빈틈 검사 (쪽 단위)
  const pages = ranged.filter((it) => it.progressUnit === 'page').sort((a, b) => a.range!.from - b.range!.from);
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1].range!;
    const cur = pages[i].range!;
    if (cur.from > prev.to + 1) issues.push({ row: rowOf(pages[i]), level: 'warning', message: `${prev.to + 1}~${cur.from - 1}쪽이 누락되었습니다 (의도한 제외 범위라면 무시).` });
  }

  return { items, issues, headers, rowCount: body.length };
}
