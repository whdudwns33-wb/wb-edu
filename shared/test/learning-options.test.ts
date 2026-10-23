import { describe, expect, it } from 'vitest';
import type { LearningApproach, PlanSettings } from '../src/types.ts';
import { LEARNING_APPROACHES, settingsForApproach } from '../src/learning-options.ts';

const settings: PlanSettings = {
  startDate: '2026-10-19', endDate: '', targetDate: '', weekdays: [1, 3, 5], minutesPerLesson: 90, reviewMinutes: 10, bufferMinutes: 5,
  mode: 'pace', academicYearStartMonth: 3, holidaySetIds: [], offDays: [], makeupDays: [], fixedEvents: [],
  tracks: { review: 0, advance: 0, advanceWeekdays: null, currentMinMinutes: 0 }, maxDays: 400,
};

describe('학생 맞춤 시간 배분안', () => {
  it('같은 수업 조건에서 복습만 40%·20%·10%로 바꾸고 원본을 보존한다', () => {
    const before = structuredClone(settings);
    const options = LEARNING_APPROACHES.map((id) => settingsForApproach(settings, id));
    expect(options.map((s) => s.reviewMinutes)).toEqual([34, 17, 9]);
    for (const option of options) expect({ ...option, reviewMinutes: settings.reviewMinutes }).toEqual(settings);
    expect(settings).toEqual(before);
  });
  it.each([1, 2, 30, 60, 600])('%i분 수업에 새 진도 시간이 최소 1분 남는다', (minutes) => {
    for (const id of LEARNING_APPROACHES) {
      const result = settingsForApproach({ ...settings, minutesPerLesson: minutes, bufferMinutes: 0 }, id);
      expect(result.reviewMinutes).toBeGreaterThanOrEqual(0);
      expect(result.reviewMinutes).toBeLessThanOrEqual(minutes - 1);
    }
  });
  it.each(['unknown', 'constructor', 'toString'])('알 수 없는 안 %s를 거절한다', (id) => {
    expect(() => settingsForApproach(settings, id as LearningApproach)).toThrow('학습안');
  });
  it('시간이 남지 않으면 거절한다', () => {
    expect(() => settingsForApproach({ ...settings, bufferMinutes: 90 }, 'standard')).toThrow('1분');
  });
});
