/**
 * 가상 샘플 데이터. 실제 교재가 아니며 모든 항목은 isSample=true 로 표시된다.
 *  - 시중교재(가상): 「독해 마스터 5-1」 (가상 출판사 '가나다교육')
 *  - 자체교재(가상): 「WB 독해 활동지 A」 (가상 제작자 'WB 학습센터')
 */
import type { AuditMeta, Curriculum, CurriculumTextbookRef, LearningItem, LearningObjective, Textbook } from './types.ts';
import { autoAssemble } from './assembler.ts';

function meta(by: string, at: string): AuditMeta {
  return { createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, version: 1, archived: false, isSample: true };
}

export const SAMPLE_IDS = {
  marketTextbook: 'sample-tb-market-rd51',
  inhouseTextbook: 'sample-tb-inhouse-wsA',
  curriculumBasic: 'sample-cur-basic',
  curriculumParallel: 'sample-cur-parallel',
  curriculumSupplement: 'sample-cur-supplement',
  curriculumAdvance: 'sample-cur-advance',
};

const OBJ = (code: string, title: string, grade: string, prereq: string[] = []): Omit<LearningObjective, keyof AuditMeta> => ({
  id: `sample-obj-${code}`,
  code,
  title,
  subject: '독해',
  schoolLevel: '초',
  grade,
  description: `${title} (가상 학습목표)`,
  prerequisiteObjectiveIds: prereq.map((p) => `sample-obj-${p}`),
  prerequisiteVerified: true,
  verificationNote: '가상 샘플: 담당자 확인 가정',
});

export function sampleObjectives(by: string, at: string): LearningObjective[] {
  return [
    OBJ('RD-5-01', '글의 중심 문장 찾기', '5'),
    OBJ('RD-5-02', '문단 요약하기', '5', ['RD-5-01']),
    OBJ('RD-5-03', '설명 방법 파악하기', '5', ['RD-5-01']),
    OBJ('RD-5-04', '주장과 근거 구분하기', '5', ['RD-5-02']),
    OBJ('RD-5-05', '글의 구조 파악하기', '5', ['RD-5-03']),
    OBJ('RD-5-06', '추론하며 읽기', '5', ['RD-5-04', 'RD-5-05']),
    OBJ('RD-6-01', '비판적으로 읽기', '6', ['RD-5-06']),
    OBJ('RD-6-02', '매체 자료 읽기', '6', ['RD-5-05']),
  ].map((o) => ({ ...o, ...meta(by, at) }));
}

function item(p: Partial<LearningItem> & Pick<LearningItem, 'id' | 'unit' | 'title' | 'order' | 'minutes'>): LearningItem {
  return {
    subunit: '',
    objective: '',
    objectiveIds: [],
    progressUnit: 'page',
    quantity: 1,
    minutesSource: 'entered',
    splittable: true,
    prerequisiteItemIds: [],
    usage: 'both',
    excluded: false,
    extra: {},
    ...p,
  };
}

/** 가상 시중교재: 8개 학습항목 × 30분 (시간 배정 테스트용) */
export function sampleMarketTextbook(by: string, at: string): Textbook {
  const id = SAMPLE_IDS.marketTextbook;
  const items: LearningItem[] = [
    item({ id: `${id}-i1`, unit: '1단원 중심 생각', subunit: '1. 중심 문장', title: '중심 문장 찾기', order: 1, minutes: 30, range: { from: 12, to: 23 }, objective: '문단의 중심 문장을 찾는다', objectiveIds: ['sample-obj-RD-5-01'], extra: { passage: '설명문 2편', skill: '중심 문장' } }),
    item({ id: `${id}-i2`, unit: '1단원 중심 생각', subunit: '2. 문단 요약', title: '문단 요약하기', order: 2, minutes: 30, range: { from: 24, to: 35 }, objective: '문단을 한 문장으로 요약한다', objectiveIds: ['sample-obj-RD-5-02'], prerequisiteItemIds: [`${id}-i1`], extra: { passage: '설명문 2편', skill: '요약' } }),
    item({ id: `${id}-i3`, unit: '2단원 설명하는 글', subunit: '1. 설명 방법', title: '설명 방법 파악하기', order: 3, minutes: 30, range: { from: 36, to: 47 }, objective: '정의·예시·비교 등 설명 방법을 안다', objectiveIds: ['sample-obj-RD-5-03'], prerequisiteItemIds: [`${id}-i1`], extra: { passage: '설명문 3편', skill: '설명 방법' } }),
    item({ id: `${id}-i4`, unit: '2단원 설명하는 글', subunit: '2. 글의 구조', title: '글의 구조 파악하기', order: 4, minutes: 30, range: { from: 48, to: 59 }, objective: '처음-중간-끝 구조를 파악한다', objectiveIds: ['sample-obj-RD-5-05'], prerequisiteItemIds: [`${id}-i3`], extra: { passage: '설명문 2편', skill: '구조' } }),
    item({ id: `${id}-i5`, unit: '3단원 주장하는 글', subunit: '1. 주장과 근거', title: '주장과 근거 구분하기', order: 5, minutes: 30, range: { from: 60, to: 71 }, objective: '주장과 근거를 구분한다', objectiveIds: ['sample-obj-RD-5-04'], prerequisiteItemIds: [`${id}-i2`], extra: { passage: '논설문 2편', skill: '주장·근거' } }),
    item({ id: `${id}-i6`, unit: '3단원 주장하는 글', subunit: '2. 근거의 타당성', title: '근거의 타당성 판단하기', order: 6, minutes: 30, range: { from: 72, to: 83 }, objective: '근거가 적절한지 판단한다', objectiveIds: ['sample-obj-RD-5-04'], prerequisiteItemIds: [`${id}-i5`], extra: { passage: '논설문 2편', skill: '타당성' } }),
    item({ id: `${id}-i7`, unit: '4단원 추론하며 읽기', subunit: '1. 생략된 내용', title: '생략된 내용 추론하기', order: 7, minutes: 30, range: { from: 84, to: 95 }, objective: '글에 드러나지 않은 내용을 추론한다', objectiveIds: ['sample-obj-RD-5-06'], prerequisiteItemIds: [`${id}-i4`, `${id}-i6`], extra: { passage: '이야기 글 2편', skill: '추론' } }),
    item({ id: `${id}-i8`, unit: '4단원 추론하며 읽기', subunit: '2. 단원 평가', title: '4단원 종합 평가', order: 8, minutes: 30, range: { from: 96, to: 107 }, objective: '단원 학습 내용을 종합 평가한다', objectiveIds: ['sample-obj-RD-5-06'], prerequisiteItemIds: [`${id}-i7`], splittable: false, extra: { passage: '종합 3편', skill: '종합' } }),
  ];
  return {
    ...meta(by, at),
    id,
    kind: 'market',
    title: '[가상] 독해 마스터 5-1',
    publisher: '가나다교육 (가상 출판사)',
    subject: '독해',
    schoolLevel: '초',
    grade: '5',
    semester: '1',
    stage: '기본',
    edition: '2026년 개정판 (가상)',
    isbn: '',
    sourceUrl: '',
    verification: 'verified',
    usageNote: '가상 샘플 교재. 실제 교재가 아니며 검증용으로만 사용한다.',
    pdfPageOffset: 2,
    excludedRanges: [{ id: `${id}-ex1`, label: '정답과 해설', range: { from: 108, to: 128 } }],
    items,
    defaultUnit: 'page',
  };
}

/** 가상 자체교재: 8개 활동 × 15분. 주교재 항목에 붙는 활동지(보충형 검증용) */
export function sampleInhouseTextbook(by: string, at: string): Textbook {
  const id = SAMPLE_IDS.inhouseTextbook;
  const m = SAMPLE_IDS.marketTextbook;
  const items: LearningItem[] = Array.from({ length: 8 }, (_, i) =>
    item({
      id: `${id}-a${i + 1}`,
      unit: `활동지 ${Math.floor(i / 2) + 1}묶음`,
      subunit: '',
      title: `활동지 ${i + 1}: ${['중심 문장 카드', '요약 문장 만들기', '설명 방법 찾기 게임', '구조도 그리기', '주장·근거 분류', '근거 평가 토론', '추론 퀴즈', '종합 활동'][i]}`,
      order: i + 1,
      minutes: 15,
      progressUnit: 'activity',
      quantity: 1,
      splittable: false,
      objectiveIds: [['RD-5-01', 'RD-5-02', 'RD-5-03', 'RD-5-05', 'RD-5-04', 'RD-5-04', 'RD-5-06', 'RD-5-06'][i]].map((c) => `sample-obj-${c}`),
      attachToItemId: `${m}-i${i + 1}`,
      materials: ['색연필', '포스트잇', '카드 세트', 'A3 종이', '분류표', '토론 카드', '퀴즈지', '종합 활동지'][i],
      usage: i % 4 === 3 ? 'homework' : 'both',
      extra: { activity: '개별 활동', version: 'v1.0' },
    }),
  );
  // 숙제 전용 항목은 테스트 단순화를 위해 수업 사용 가능으로 유지
  for (const it of items) it.usage = 'both';
  return {
    ...meta(by, at),
    id,
    kind: 'inhouse',
    title: '[가상] WB 독해 활동지 A',
    publisher: 'WB 학습센터 (가상 제작자)',
    subject: '독해',
    schoolLevel: '초',
    grade: '5',
    semester: '1',
    stage: '기본',
    edition: 'v1.0 (가상)',
    verification: 'verified',
    usageNote: '가상 샘플 자체교재. 내부 사용 가정.',
    pdfPageOffset: 0,
    excludedRanges: [],
    items,
    defaultUnit: 'activity',
  };
}

export function sampleCurricula(by: string, at: string, tbs: Map<string, Textbook>): Curriculum[] {
  const base = {
    subject: '독해',
    recommendedPerWeek: 2,
    recommendedMinutesPerSession: 60,
    reviewMinutesPerSession: 10,
    bufferMinutesPerSession: 5,
    assessmentEvery: 0,
    curriculumVersion: 1,
    status: 'draft' as const,
    origin: 'custom' as const,
    reviewComments: [],
  };
  const refMarket = { textbookId: SAMPLE_IDS.marketTextbook, edition: '2026년 개정판 (가상)', textbookVersion: 1, role: 'main' as const, includedItemIds: null, excludedItemIds: [] };
  const refInhouse = { textbookId: SAMPLE_IDS.inhouseTextbook, edition: 'v1.0 (가상)', textbookVersion: 1, role: 'supplement' as const, includedItemIds: null, excludedItemIds: [] };

  const mk = (id: string, title: string, mode: Curriculum['compositionMode'], refs: CurriculumTextbookRef[], target: string, goal: string, extra: Partial<Curriculum> = {}): Curriculum => {
    const { sessions, unassigned } = autoAssemble(refs, tbs, mode, { minutesPerSession: 60, reviewMinutes: 10, bufferMinutes: 5, assessmentEvery: 0 });
    return { ...meta(by, at), ...base, id, title, target, goal, textbooks: refs, compositionMode: mode, sessions, unassignedEntries: unassigned, ...extra };
  };

  return [
    mk(SAMPLE_IDS.curriculumBasic, '[가상] 독해 마스터 5-1 기본 진행안', 'sequential', [refMarket], '초5 기본반', '5학년 1학기 독해 기능 8가지를 순서대로 학습한다', { origin: 'recommended' }),
    mk(SAMPLE_IDS.curriculumParallel, '[가상] 주교재 + 활동지 병행안', 'parallel', [refMarket, { ...refInhouse, role: 'sub' }], '초5 기본반', '매 수업 교재 항목 1개(30분)와 활동지 1개(15분)를 병행한다'),
    mk(SAMPLE_IDS.curriculumSupplement, '[가상] 보충형 (주교재 단원에 활동지 연결)', 'supplement', [refMarket, refInhouse], '초5 보충반', '주교재 각 항목 뒤에 연결된 활동지로 보충한다'),
    mk(SAMPLE_IDS.curriculumAdvance, '[가상] 방학 집중 선행안', 'sequential', [refMarket], '초4 선행반', '방학 동안 5학년 1학기 범위를 선행한다', {
      advance: {
        type: 'vacation',
        currentGrade: '4',
        actualStage: '4학년 2학기 완료',
        targetDescription: '5학년 1학기 독해 (독해 마스터 5-1 전체)',
        targetDate: '',
        currentMinMinutes: 20,
        requiredObjectiveIds: ['sample-obj-RD-5-01'],
        prerequisitesConfirmed: false,
      },
    }),
  ];
}
