/**
 * WB 커리큘럼 플래너 - 공용 도메인 타입
 *
 * 네 층 분리:
 *  A. 교재 원본 (Textbook / LearningItem)
 *  B. 표준 커리큘럼 (Curriculum / CurriculumSession)
 *  C. 실행 계획 (Plan / Lesson / Assignment)
 *  D. 실제 진행 기록 (ProgressRecord / UnderstandingCheck)
 *
 * 모든 연결은 화면 표시명이 아니라 id로 한다.
 */

export type ISODate = string; // 'YYYY-MM-DD' (한국 시간대 기준 달력 날짜)
export type ISODateTime = string; // ISO 8601

// ──────────────────────────────────────────────
// 공통
// ──────────────────────────────────────────────

export interface AuditMeta {
  createdAt: ISODateTime;
  createdBy: string; // userId
  updatedAt: ISODateTime;
  updatedBy: string;
  /** 낙관적 동시성 제어용. 저장 시 version이 일치해야 한다. */
  version: number;
  /** 삭제 대신 보관 처리 */
  archived: boolean;
  /** 가상 샘플 데이터 여부 (실제 운영 데이터와 구분) */
  isSample: boolean;
}

export type Subject = '국어' | '영어' | '수학' | '독해' | '기타' | string;
export type SchoolLevel = '초' | '중' | '고' | '공통';

// ──────────────────────────────────────────────
// A. 교재 원본
// ──────────────────────────────────────────────

export type TextbookKind = 'market' | 'inhouse'; // 시중 / 자체
export type VerificationStatus = 'unverified' | 'reviewing' | 'verified'; // 미확인 / 검토 중 / 확인

/** 진도 단위 */
export type ProgressUnit =
  | 'unit' // 단원
  | 'lesson' // 강
  | 'page' // 쪽
  | 'problem' // 문항
  | 'passage' // 지문
  | 'vocab' // 어휘 묶음
  | 'activity' // 활동
  | 'session'; // 차시

export const PROGRESS_UNIT_LABEL: Record<ProgressUnit, string> = {
  unit: '단원',
  lesson: '강',
  page: '쪽',
  problem: '문항',
  passage: '지문',
  vocab: '어휘 묶음',
  activity: '활동',
  session: '차시',
};

/** 범위가 있는 단위(쪽·문항 등)는 from~to, 그 외는 수량만 */
export interface ItemRange {
  from: number;
  to: number; // inclusive. 12~23 → 12개
}

export type MinutesSource = 'entered' | 'estimated'; // 직접 입력 / 추정

export type ItemUsage = 'class' | 'homework' | 'both';

export interface LearningItem {
  id: string;
  /** 대단원 */
  unit: string;
  /** 소단원 */
  subunit: string;
  /** 학습 순서 (교재 내 정렬) */
  order: number;
  title: string;
  /** 학습 목표 (서술) */
  objective: string;
  /** 연결된 학습목표 id */
  objectiveIds: string[];
  progressUnit: ProgressUnit;
  /** 쪽·문항 등 범위형 단위일 때 */
  range?: ItemRange;
  /** 범위가 없는 단위일 때 수량 (기본 1) */
  quantity: number;
  /** 예상 소요시간(분) */
  minutes: number;
  minutesSource: MinutesSource;
  difficulty?: 1 | 2 | 3 | 4 | 5;
  splittable: boolean;
  /** 먼저 배워야 하는 항목 id (같은 교재 또는 다른 교재) */
  prerequisiteItemIds: string[];
  usage: ItemUsage;
  materials?: string;
  teachingNote?: string;
  /** 보충형 구성에서 주교재의 특정 항목에 붙는 자체 활동지 등 */
  attachToItemId?: string;
  /** 정답·해설·부록 등 제외 범위 여부 */
  excluded: boolean;
  /** 과목별 선택 항목 (독해: 지문·독해기능, 수학: 개념·유형·오답 등) */
  extra: Record<string, string>;
}

export interface ExcludedRange {
  id: string;
  label: string; // 예: 정답과 해설
  range: ItemRange;
}

export interface Textbook extends AuditMeta {
  id: string;
  kind: TextbookKind;
  title: string;
  publisher: string; // 출판사 또는 제작자
  subject: Subject;
  schoolLevel: SchoolLevel;
  grade: string; // 예: '3', '중1', '' (자유 입력)
  semester: string; // 예: '1', '2', ''
  stage: string; // 단계/레벨
  /** 판본·개정연도 또는 자체교재 버전 */
  edition: string;
  isbn?: string;
  sourceUrl?: string;
  verification: VerificationStatus;
  /** 사용 범위·이용 권한 메모 */
  usageNote: string;
  /** 인쇄 쪽수와 PDF 페이지 번호 차이 (pdfPage = printedPage + offset) */
  pdfPageOffset: number;
  excludedRanges: ExcludedRange[];
  items: LearningItem[];
  /** 기본 진도 단위 (완료율 집계용) */
  defaultUnit: ProgressUnit;
}

// ──────────────────────────────────────────────
// 학습목표 및 선수 학습 관계
// ──────────────────────────────────────────────

export interface LearningObjective extends AuditMeta {
  id: string;
  code: string; // 예: 'RD-2-03'
  title: string;
  subject: Subject;
  schoolLevel: SchoolLevel;
  grade: string;
  description: string;
  /** 선수 목표 */
  prerequisiteObjectiveIds: string[];
  /** 선수 관계가 검증된 자료 또는 담당자 확인으로 확정되었는지 */
  prerequisiteVerified: boolean;
  /** 담당자 확인 메모 (출처) */
  verificationNote: string;
}

// ──────────────────────────────────────────────
// B. 표준 커리큘럼
// ──────────────────────────────────────────────

export type Track = 'current' | 'review' | 'advance'; // 현행 / 복습·보충 / 선행
export type Activity = 'new' | 'practice' | 'review' | 'assessment' | 'homework';

export const TRACK_LABEL: Record<Track, string> = {
  current: '현행',
  review: '복습·보충',
  advance: '선행',
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  new: '새 학습',
  practice: '연습',
  review: '복습',
  assessment: '평가',
  homework: '숙제',
};

export type CompositionMode = 'sequential' | 'parallel' | 'supplement';
export const COMPOSITION_LABEL: Record<CompositionMode, string> = {
  sequential: '순차형',
  parallel: '병행형',
  supplement: '보충형',
};

export type TextbookRole = 'main' | 'sub' | 'supplement';

export interface CurriculumTextbookRef {
  textbookId: string;
  /** 참조 시점 교재 판본 (교재 개정 추적용) */
  edition: string;
  textbookVersion: number;
  role: TextbookRole;
  /** 포함 범위: 비어 있으면 전체 (제외 항목 제외) */
  includedItemIds: string[] | null;
  excludedItemIds: string[];
}

/** 과정 차시 안의 한 항목 배치 */
export interface SessionEntry {
  id: string;
  textbookId: string;
  itemId: string;
  track: Track;
  activity: Activity;
  minutes: number;
  /** 분할된 경우 부분 범위 (범위형 단위) 또는 분할 비율 */
  portion?: ItemRange;
  /** 수량형 단위 분할 시 (예: 활동 1개를 2차시로) 비율 0~1 */
  fraction?: number;
  /** 같은 항목을 복습·심화 목적으로 반복할 때 */
  repeatPurpose?: 'review' | 'deepen' | 'assessment';
  note?: string;
}

export interface CurriculumSession {
  id: string;
  order: number; // 1차시, 2차시...
  title: string;
  entries: SessionEntry[];
  /** 복습·평가 위치 표시 */
  marker?: 'review' | 'assessment' | 'buffer';
}

export type CurriculumStatus = 'draft' | 'reviewing' | 'verified';
export type CurriculumOrigin = 'recommended' | 'custom'; // 교재별 권장안 / 사용자 맞춤안

export interface Curriculum extends AuditMeta {
  id: string;
  title: string;
  subject: Subject;
  target: string; // 대상 (예: 초5 기본반)
  goal: string;
  textbooks: CurriculumTextbookRef[];
  compositionMode: CompositionMode;
  sessions: CurriculumSession[];
  /** 차시에 배치되지 않은 항목 */
  unassignedEntries: SessionEntry[];
  /** 권장 수업 빈도 (주당 횟수) */
  recommendedPerWeek: number;
  /** 회당 권장 수업시간 */
  recommendedMinutesPerSession: number;
  /** 회당 복습 시간 */
  reviewMinutesPerSession: number;
  /** 회당 여유 시간 */
  bufferMinutesPerSession: number;
  /** N차시마다 평가 (0 = 없음) */
  assessmentEvery: number;
  /** 과정 버전 */
  curriculumVersion: number;
  status: CurriculumStatus;
  origin: CurriculumOrigin;
  /** 선행 과정 설정 (선택) */
  advance?: AdvanceSettings;
  reviewComments: ReviewComment[];
}

export type AdvanceType = 'next_semester' | 'next_grade' | 'domain' | 'vacation';
export const ADVANCE_TYPE_LABEL: Record<AdvanceType, string> = {
  next_semester: '다음 학기 선행',
  next_grade: '다음 학년 선행',
  domain: '특정 영역 선행',
  vacation: '방학 집중 선행',
};

export interface AdvanceSettings {
  type: AdvanceType;
  currentGrade: string; // 현재 학년
  actualStage: string; // 실제 학습 단계
  targetDescription: string; // 목표 학년·학기 또는 영역·교재·단원
  targetDate: ISODate | '';
  /** 현행에 반드시 확보할 시간 (회당 분) */
  currentMinMinutes: number;
  /** 필요한 기초 개념·확인 항목 (학습목표 id) */
  requiredObjectiveIds: string[];
  /** 담당자가 기초 확인을 완료했는지 */
  prerequisitesConfirmed: boolean;
  prerequisitesConfirmedBy?: string;
  prerequisitesConfirmedAt?: ISODateTime;
}

export interface ReviewComment {
  id: string;
  at: ISODateTime;
  by: string;
  text: string;
}

// ──────────────────────────────────────────────
// C. 실행 계획
// ──────────────────────────────────────────────

export type PlanMode = 'period' | 'pace'; // 기간 우선 / 속도 우선
export type PlanStatus = 'draft' | 'confirmed' | 'archived';

export type LessonStatus = 'scheduled' | 'cancelled' | 'makeup' | 'holiday';

export interface FixedEvent {
  id: string;
  date: ISODate;
  title: string;
  /** 해당 수업에서 차지하는 분 (0이면 표시만) */
  minutes: number;
}

export interface OffDay {
  id: string;
  date: ISODate;
  reason: string; // 휴강, 방학, 공휴일 등
  source: 'holiday' | 'manual';
}

export interface MakeupDay {
  id: string;
  date: ISODate;
  minutes?: number; // 비어 있으면 회당 수업시간
  note: string;
}

export interface TrackAllocation {
  /** 복습·보충 트랙에 배정할 회당 분 (0 = 없음) */
  review: number;
  /** 선행 트랙에 배정할 회당 분 (0 = 없음) */
  advance: number;
  /** 선행을 특정 요일에만 배치 (null = 모든 수업일) */
  advanceWeekdays: number[] | null;
  /** 현행 최소 확보 시간 */
  currentMinMinutes: number;
}

export interface PlanSettings {
  startDate: ISODate;
  /** 기간 우선일 때 종료일. 속도 우선일 때는 계산 결과 */
  endDate: ISODate | '';
  /** 목표 완료일 (경고 기준) */
  targetDate: ISODate | '';
  /** 수업 요일 0=일 ... 6=토 */
  weekdays: number[];
  minutesPerLesson: number;
  reviewMinutes: number;
  bufferMinutes: number;
  mode: PlanMode;
  /** 학년도 시작월 (기본 3) */
  academicYearStartMonth: number;
  /** 적용 공휴일 연도 세트 식별 */
  holidaySetIds: string[];
  offDays: OffDay[];
  makeupDays: MakeupDay[];
  fixedEvents: FixedEvent[];
  tracks: TrackAllocation;
  /** 속도 우선: 최대 탐색 일수 (무한 루프 방지) */
  maxDays: number;
}

export type UnassignedReason =
  | 'time_short' // 총시간 부족
  | 'unsplittable' // 분할 불가
  | 'prerequisite' // 순서 제약
  | 'fixed_conflict' // 고정 일정 충돌
  | 'target_exceeded' // 목표일 초과
  | 'excluded'; // 사용자 제외

export const UNASSIGNED_REASON_LABEL: Record<UnassignedReason, string> = {
  time_short: '총시간 부족',
  unsplittable: '분할 불가',
  prerequisite: '순서 제약',
  fixed_conflict: '고정 일정 충돌',
  target_exceeded: '목표일 초과',
  excluded: '제외',
};

export interface Assignment {
  id: string;
  lessonId: string;
  /** 출처 과정 차시 */
  sessionId: string;
  sessionOrder: number;
  entryId: string;
  textbookId: string;
  itemId: string;
  track: Track;
  activity: Activity;
  minutes: number;
  portion?: ItemRange;
  fraction?: number;
  order: number;
  /** 특정 날짜에 고정 */
  locked: boolean;
  /** 이어서 진행: 원래 배정 id */
  continuedFrom?: string;
  repeatPurpose?: SessionEntry['repeatPurpose'];
}

export interface Lesson {
  id: string;
  date: ISODate;
  status: LessonStatus;
  /** 회당 총 수업시간 */
  totalMinutes: number;
  /** 복습·여유·고정일정 제외 후 새 진도 가능 분 */
  availableMinutes: number;
  reviewMinutes: number;
  bufferMinutes: number;
  fixedMinutes: number;
  note: string;
  /** 수업 준비물·점검 메모 */
  checklist: string;
}

export interface UnassignedEntry {
  id: string;
  sessionId: string;
  sessionOrder: number;
  entryId: string;
  textbookId: string;
  itemId: string;
  track: Track;
  activity: Activity;
  minutes: number;
  portion?: ItemRange;
  fraction?: number;
  reason: UnassignedReason;
  detail: string;
  /** 이어서 진행으로 생긴 남은 범위가 미배정이 된 경우, 원래 배정 id (중복 이어서 진행을 막는 연결) */
  continuedFrom?: string;
}

/** 실행 계획이 보존하는 과정·교재 스냅샷 */
export interface PlanSnapshot {
  curriculumId: string;
  curriculumTitle: string;
  curriculumVersion: number;
  compositionMode: CompositionMode;
  takenAt: ISODateTime;
  sessions: CurriculumSession[];
  textbooks: Array<{
    id: string;
    title: string;
    edition: string;
    kind: TextbookKind;
    publisher: string;
    textbookVersion: number;
    defaultUnit: ProgressUnit;
    pdfPageOffset: number;
    items: LearningItem[];
  }>;
  advance?: AdvanceSettings;
  /**
   * 과정의 일부만 계획한 경우의 선택 (스냅샷 갱신 때 다시 적용).
   * assumedDone: 선택 범위 앞 차시의 배치 분량. 이미 배운 것으로 보고 선수 조건 판단에 쓴다
   *   (한 항목이 앞 차시와 선택 범위에 나뉘어 있으면 앞 차시 쪽 분량만 배운 것으로 본다).
   */
  selection?: { fromSessionOrder?: number; toSessionOrder?: number; includeItemIds?: string[]; assumedDone: Array<{ itemId: string; portion?: ItemRange; fraction?: number }> };
}

export type RecordStatus = 'done' | 'partial' | 'not_done' | 'excluded';
export const RECORD_STATUS_LABEL: Record<RecordStatus, string> = {
  done: '완료',
  partial: '부분 완료',
  not_done: '미진행',
  excluded: '제외',
};

export interface ProgressRecord {
  id: string;
  assignmentId: string;
  lessonId: string;
  date: ISODate;
  status: RecordStatus;
  /** 부분 완료 시 완료한 범위 (범위형) */
  completedPortion?: ItemRange;
  /** 수량형 부분 완료 비율 */
  completedFraction?: number;
  /** 실제로 걸린 시간(분, 선택). 교재 예상 소요시간 개선 제안에 쓴다 */
  actualMinutes?: number;
  reason: string;
  note: string;
  recordedAt: ISODateTime;
  recordedBy: string;
}

export interface UnderstandingCheck {
  id: string;
  lessonId: string;
  itemId: string;
  textbookId: string;
  objectiveIds: string[];
  result: 'confirmed' | 'needs_review' | 'not_confirmed';
  note: string;
  checkedAt: ISODateTime;
  checkedBy: string;
}

export type HistoryAction =
  | 'create'
  | 'generate'
  | 'postpone'
  | 'continue'
  | 'swap'
  | 'pin'
  | 'reschedule'
  | 'undo'
  | 'cancel_lesson'
  | 'restore_lesson'
  | 'add_makeup'
  | 'edit_settings'
  | 'confirm'
  | 'record'
  | 'manual_edit';

export interface HistoryEntry {
  id: string;
  at: ISODateTime;
  by: string;
  action: HistoryAction;
  description: string;
  /** 되돌리기용 이전 배정 상태 (기록은 포함하지 않음) */
  before?: ScheduleState;
  /** 이 변경 시점 이후 생성된 기록이 있으면 되돌리기를 막는다 */
  undone?: boolean;
}

/** 되돌리기 대상이 되는 배정 상태 묶음 */
export interface ScheduleState {
  lessons: Lesson[];
  assignments: Assignment[];
  unassigned: UnassignedEntry[];
  settings: PlanSettings;
  endDateComputed: ISODate | '';
}

export interface Plan extends AuditMeta {
  id: string;
  title: string;
  subject: Subject;
  /** 대상 (반·학생은 선택. 비워도 됨) */
  target: string;
  /** 반 또는 개인 식별 (선택) — 복제 시 제외 */
  classOrStudentRef: string;
  curriculumId: string;
  snapshot: PlanSnapshot;
  settings: PlanSettings;
  lessons: Lesson[];
  assignments: Assignment[];
  unassigned: UnassignedEntry[];
  records: ProgressRecord[];
  understandingChecks: UnderstandingCheck[];
  status: PlanStatus;
  planVersion: number;
  /** 속도 우선일 때 계산된 완료 예정일 */
  endDateComputed: ISODate | '';
  history: HistoryEntry[];
  author: string;
  reviewer: string;
  /** 이 계획에 필수로 지정된 학습목표 */
  requiredObjectiveIds: string[];
  confirmedAt?: ISODateTime;
  confirmedBy?: string;
  /** 허용된 강사 (관리자는 항상 가능) */
  allowedUserIds: string[];
  /**
   * 캘린더 구독 주소 (로그인 없이 열리는 비밀 주소). 폐기하면 바로 막힌다.
   * 복제 시 따라가지 않는다.
   */
  calendarFeeds?: Array<{ token: string; audience: 'teacher' | 'student'; createdAt: string; createdBy: string; label: string }>;
}

// ──────────────────────────────────────────────
// 설정·양식
// ──────────────────────────────────────────────

export interface Holiday {
  id: string;
  date: ISODate;
  name: string;
  year: number;
  /** 출처 */
  source: string;
  /** 확인 상태 */
  verified: boolean;
  enabled: boolean;
}

export interface HolidaySet extends AuditMeta {
  id: string;
  name: string;
  year: number;
  source: string;
  holidays: Holiday[];
}

export interface SubjectFieldTemplate {
  subject: Subject;
  /** 학습항목 extra 필드 키·라벨 */
  fields: Array<{ key: string; label: string }>;
}

export interface OutputTemplate extends AuditMeta {
  id: string;
  name: string;
  audience: 'teacher' | 'student';
  /** 포함 열 (주간·일간 표) */
  columns: string[];
  /** 연간·분기·월간 표의 열 (없거나 비면 대상별 기본 열) */
  summaryColumns?: { year?: string[]; quarter?: string[]; month?: string[] };
  headerNote: string;
  footerNote: string;
}

export interface AppSettings extends AuditMeta {
  id: 'app';
  academicYearStartMonth: number;
  defaultMinutesPerLesson: number;
  defaultReviewMinutes: number;
  defaultBufferMinutes: number;
  subjectFields: SubjectFieldTemplate[];
  organizationName: string;
}

// ──────────────────────────────────────────────
// 사용자·권한
// ──────────────────────────────────────────────

export type UserRole = 'admin' | 'teacher';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: ISODateTime;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}
