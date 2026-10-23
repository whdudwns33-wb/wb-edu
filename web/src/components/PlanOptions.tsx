import type { LearningApproach, PlanSettings } from '@wb/shared';
import { LEARNING_APPROACH_DESCRIPTION, LEARNING_APPROACH_LABEL } from '@wb/shared';

export interface PlanOptionSummary {
  learningApproach: LearningApproach;
  settings: PlanSettings;
  endDateComputed: string;
  lessons: Array<{ status: string }>;
  unassigned: unknown[];
}

export function planDateLabel(mode: PlanSettings['mode'], unassignedCount: number): string {
  return mode === 'pace' && !unassignedCount ? '완료 예정일' : '마지막 배정일';
}

export function PlanOptions({ options, selected, onSelect, disabled = false }: { options: PlanOptionSummary[]; selected: LearningApproach | null; onSelect: (approach: LearningApproach) => void; disabled?: boolean }) {
  return (
    <fieldset className="plan-options" disabled={disabled}>
      <legend>학생에게 맞는 안을 하나 선택하세요</legend>
      <p className="muted small mb">같은 학습 범위와 수업 조건으로 비교합니다. 선택 전에는 계획을 저장하지 않습니다.</p>
      <div className="grid cols-3">
        {options.map((option) => {
          const approach = option.learningApproach;
          return (
            <label key={approach} className={`plan-option ${selected === approach ? 'selected' : ''}`}>
              <span className="check plan-option-heading">
                <input type="radio" name="learning-approach" value={approach} checked={selected === approach} onChange={() => onSelect(approach)} aria-label={LEARNING_APPROACH_LABEL[approach]} />
                <strong>{LEARNING_APPROACH_LABEL[approach]}</strong>
                {selected === approach && <span className="badge primary">선택됨</span>}
              </span>
              <p className="small mt">{LEARNING_APPROACH_DESCRIPTION[approach]}</p>
              <dl>
                <div><dt>회당 복습</dt><dd>{option.settings.reviewMinutes}분</dd></div>
                <div><dt>회당 새 진도 가능</dt><dd>{option.settings.minutesPerLesson - option.settings.reviewMinutes - option.settings.bufferMinutes}분</dd></div>
                <div><dt>예상 수업</dt><dd>{option.lessons.filter((l) => l.status === 'scheduled' || l.status === 'makeup').length}회</dd></div>
                <div><dt>{planDateLabel(option.settings.mode, option.unassigned.length)}</dt><dd>{option.endDateComputed || '미정'}</dd></div>
                {!!option.unassigned.length && <div><dt>완료 예정일</dt><dd>미정</dd></div>}
                <div><dt>미배정</dt><dd>{option.unassigned.length}건</dd></div>
              </dl>
            </label>
          );
        })}
      </div>
      <p className="muted small mt">검수용 기본 배분: 여유 시간을 뺀 수업시간의 40% / 20% / 10%를 복습에 확보합니다. 학생 수준 진단이나 심화 문항 생성은 하지 않습니다. 짧은 수업에서는 안별 결과가 같을 수 있습니다.</p>
    </fieldset>
  );
}
