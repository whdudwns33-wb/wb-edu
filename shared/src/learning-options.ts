import type { LearningApproach, PlanSettings } from './types.ts';

export const LEARNING_APPROACHES: LearningApproach[] = ['foundation', 'standard', 'fast'];
export const LEARNING_APPROACH_LABEL: Record<LearningApproach, string> = {
  foundation: '기초·보강형', standard: '표준형', fast: '빠른 진도·심화형',
};
export const LEARNING_APPROACH_DESCRIPTION: Record<LearningApproach, string> = {
  foundation: '복습 시간을 넉넉히 확보하고 새 진도를 천천히 진행합니다.',
  standard: '복습과 새 진도를 균형 있게 배분합니다.',
  fast: '복습 시간을 줄여 새 진도를 빠르게 진행합니다. 심화 내용은 등록된 과정에 있어야 합니다.',
};

/** 검수용 기본 배분이며 학생 수준을 진단하거나 학습 범위를 바꾸지 않는다. */
export function settingsForApproach(settings: PlanSettings, approach: LearningApproach): PlanSettings {
  if (!LEARNING_APPROACHES.includes(approach)) throw new Error('학습안을 올바르게 선택해 주세요.');
  const available = settings.minutesPerLesson - settings.bufferMinutes;
  if (!Number.isFinite(available) || available < 1) throw new Error('수업시간에서 여유 시간을 빼고 1분 이상 남겨 주세요.');
  const ratio = { foundation: 0.4, standard: 0.2, fast: 0.1 }[approach];
  if (ratio === undefined) throw new Error('학습안을 올바르게 선택해 주세요.');
  return { ...settings, reviewMinutes: Math.min(available - 1, Math.round(available * ratio)) };
}
