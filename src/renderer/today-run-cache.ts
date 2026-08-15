import type { DailyTaskSnapshot } from './today-run-view';

type TodayRunCache = {
  planDate: string;
  task: DailyTaskSnapshot | null;
  running: boolean;
  updatedAt: number;
};

let cache: TodayRunCache | null = null;

export function readTodayRunCache(planDate: string): TodayRunCache | null {
  if (!cache || cache.planDate !== planDate) return null;
  return cache;
}

export function writeTodayRunCache(input: {
  planDate: string;
  task: DailyTaskSnapshot | null;
  running: boolean;
}): void {
  cache = {
    planDate: input.planDate,
    task: input.task,
    running: input.running,
    updatedAt: Date.now()
  };
}

export function clearTodayRunCache(planDate?: string): void {
  if (!cache) return;
  if (planDate && cache.planDate !== planDate) return;
  cache = null;
}
