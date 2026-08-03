/**
 * X account-safety humanization policy for background/quiet automation.
 *
 * Design rules:
 * 1. Prefer quiet headed browser over true headless (fingerprint + challenge recovery).
 * 2. Read like a person: gap, scroll, pause, never burst parallel sessions.
 * 3. Fail closed on login wall / captcha / rate limit -> needs_user or cooldown.
 * 4. Keep budgets conservative; cache-first UI should absorb most page opens.
 */

export const X_BROWSER_VIEWPORT = {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1
} as const;

export const X_HUMANIZATION = {
  /** Minimum gap between recorded X page actions (ms). */
  minActionGapMs: 12_000,
  /** Extra random jitter after the minimum gap (ms). */
  actionJitterMs: 10_000,
  /** Soft hourly budget for automated X page actions. */
  hourlyActionBudget: 120,
  /** Daily budget across automation sessions. */
  dailyActionBudget: 300,
  /** After N actions, take a longer human pause. */
  longPauseEveryMin: 2,
  longPauseEveryMax: 4,
  /** Short settle after a single action. */
  settleMinMs: 2_200,
  settleMaxMs: 6_500,
  /** Longer pause block. */
  longPauseMinMs: 8_000,
  longPauseMaxMs: 22_000,
  /** After navigation, browse/read before scraping. */
  postNavReadMinMs: 1_800,
  postNavReadMaxMs: 4_800,
  /** Fast path for post detail / comments (same session reuse). */
  detailMinActionGapMs: 1_200,
  detailActionJitterMs: 900,
  detailPostNavMinMs: 200,
  detailPostNavMaxMs: 550,
  detailSettleMinMs: 180,
  detailSettleMaxMs: 420,
  /** Browse path for switching lists / reading feeds (interactive UX). */
  browseMinActionGapMs: 2_400,
  browseActionJitterMs: 1_200,
  browsePostNavMinMs: 350,
  browsePostNavMaxMs: 900,
  browseSettleMinMs: 220,
  browseSettleMaxMs: 520,
  /** Scroll bursts while "reading" a list/timeline. */
  readScrollMin: 1,
  readScrollMax: 3,
  scrollDistanceMin: 280,
  scrollDistanceMax: 760,
  scrollPauseMinMs: 450,
  scrollPauseMaxMs: 1_600,
  /** Typing cadence. */
  typeDelayMinMs: 55,
  typeDelayMaxMs: 160,
  /** Pointer travel. */
  pointerStepsMin: 28,
  pointerStepsMax: 64,
  pointerDurationMinMs: 520,
  pointerDurationMaxMs: 1_250,
  pointerPreClickPauseMinMs: 320,
  pointerPreClickPauseMaxMs: 980,
  pointerDownUpMinMs: 75,
  pointerDownUpMaxMs: 190,
  /** Cooldown growth. */
  baseCooldownMs: 90_000,
  maxCooldownMs: 30 * 60_000,
  rateLimitCooldownMultiplier: 4
} as const;

export type XActionKind = 'navigate' | 'click' | 'type' | 'scroll' | 'read';

export function isSensitiveLocalHour(date = new Date(), timeZone = 'Asia/Shanghai'): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone }).format(date));
  // Quiet overnight automation looks more bot-like; still allowed but callers may slow further.
  return hour >= 1 && hour < 7;
}

export function nextActionDelayMs(now = Date.now(), lastActionAt = 0, options: { sensitiveHour?: boolean; mode?: 'full' | 'fast' | 'browse' } = {}): number {
  const mode = options.mode ?? 'full';
  const minGap = mode === 'fast'
    ? X_HUMANIZATION.detailMinActionGapMs
    : mode === 'browse'
      ? X_HUMANIZATION.browseMinActionGapMs
      : X_HUMANIZATION.minActionGapMs;
  const jitterMax = mode === 'fast'
    ? X_HUMANIZATION.detailActionJitterMs
    : mode === 'browse'
      ? X_HUMANIZATION.browseActionJitterMs
      : X_HUMANIZATION.actionJitterMs;
  const gap = Math.max(0, lastActionAt + minGap - now);
  const jitter = randomInt(0, jitterMax);
  const nightPenalty = mode === 'full' && (options.sensitiveHour ?? isSensitiveLocalHour())
    ? randomInt(4_000, 12_000)
    : 0;
  return gap + jitter + nightPenalty;
}

export function chooseLongPauseEvery(): number {
  return randomInt(X_HUMANIZATION.longPauseEveryMin, X_HUMANIZATION.longPauseEveryMax);
}

export function chooseSettleDelayMs(longPause: boolean): number {
  if (longPause) return randomInt(X_HUMANIZATION.longPauseMinMs, X_HUMANIZATION.longPauseMaxMs);
  return randomInt(X_HUMANIZATION.settleMinMs, X_HUMANIZATION.settleMaxMs);
}

export function chooseReadPlan(): { scrolls: number; distances: number[]; pauses: number[]; initialPauseMs: number } {
  const scrolls = randomInt(X_HUMANIZATION.readScrollMin, X_HUMANIZATION.readScrollMax);
  return {
    scrolls,
    distances: Array.from({ length: scrolls }, () => randomInt(X_HUMANIZATION.scrollDistanceMin, X_HUMANIZATION.scrollDistanceMax)),
    pauses: Array.from({ length: scrolls }, () => randomInt(X_HUMANIZATION.scrollPauseMinMs, X_HUMANIZATION.scrollPauseMaxMs)),
    initialPauseMs: randomInt(X_HUMANIZATION.postNavReadMinMs, X_HUMANIZATION.postNavReadMaxMs)
  };
}

export function computeCooldownMs(consecutiveFailures: number, rateLimited = false): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const base = X_HUMANIZATION.baseCooldownMs * (2 ** exponent) * (rateLimited ? X_HUMANIZATION.rateLimitCooldownMultiplier : 1);
  return Math.min(base, X_HUMANIZATION.maxCooldownMs);
}

export function randomInt(minimum: number, maximum?: number): number {
  const upper = maximum ?? minimum;
  const lower = maximum === undefined ? 0 : minimum;
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

export function randomFloat(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}
