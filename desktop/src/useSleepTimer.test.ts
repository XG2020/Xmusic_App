// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useSleepTimer} from './useSleepTimer';

let root: Root | undefined;
let container: HTMLDivElement;
let timer: ReturnType<typeof useSleepTimer>;
const expired = vi.fn();

function Probe({onExpire}: {onExpire: () => void}) {
  timer = useSleepTimer(onExpire);
  return null;
}

async function mount(onExpire = expired) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(createElement(Probe, {onExpire})); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
  expired.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sleep timer', () => {
  it('counts down to the deadline and expires exactly once', async () => {
    await mount();
    expect(timer.deadline).toBeNull();
    expect(timer.remainingSeconds).toBe(0);
    const now = Date.now();
    await act(async () => { expect(timer.start(1)).toBe(true); });
    expect(timer.deadline).toBe(now + 60_000);
    expect(timer.remainingSeconds).toBe(60);
    await act(async () => { vi.advanceTimersByTime(59_999); });
    expect(timer.remainingSeconds).toBe(1);
    expect(expired).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(timer.deadline).toBeNull();
    expect(timer.remainingSeconds).toBe(0);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('replaces an existing countdown with a fresh deadline', async () => {
    await mount();
    await act(async () => { timer.start(1); });
    await act(async () => { vi.advanceTimersByTime(30_000); });
    const resetAt = Date.now();
    await act(async () => { timer.start(2); });
    expect(timer.deadline).toBe(resetAt + 120_000);
    expect(timer.remainingSeconds).toBe(120);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(expired).not.toHaveBeenCalled();
    expect(timer.remainingSeconds).toBe(90);
    await act(async () => { vi.advanceTimersByTime(90_000); });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('cancels a countdown without pausing playback', async () => {
    await mount();
    await act(async () => { timer.start(1); });
    await act(async () => { timer.cancel(); });
    expect(timer.deadline).toBeNull();
    expect(timer.remainingSeconds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event('focus'));
    });
    expect(expired).not.toHaveBeenCalled();
  });

  it('can cancel and restart within the same update', async () => {
    await mount();
    await act(async () => { timer.start(1); });
    await act(async () => { timer.cancel(); timer.start(1); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(timer.deadline).toBeNull();
  });

  it.each([0, -1, 0.5, 1.5, 1441, NaN, Infinity, -Infinity])(
    'rejects invalid minutes (%s) without disturbing an active countdown', async minutes => {
      await mount();
      await act(async () => { timer.start(30); });
      const deadline = timer.deadline;
      await act(async () => { expect(timer.start(minutes)).toBe(false); });
      expect(timer.deadline).toBe(deadline);
      expect(timer.remainingSeconds).toBe(1800);
      expect(expired).not.toHaveBeenCalled();
    },
  );

  it('accepts the maximum custom duration of one day', async () => {
    await mount();
    const now = Date.now();
    await act(async () => { expect(timer.start(1440)).toBe(true); });
    expect(timer.deadline).toBe(now + 86_400_000);
    expect(timer.remainingSeconds).toBe(86_400);
  });

  it('uses the most recent expiration callback without restarting the countdown', async () => {
    await mount();
    await act(async () => { timer.start(1); });
    const deadline = timer.deadline;
    const latestExpired = vi.fn();
    await act(async () => { root!.render(createElement(Probe, {onExpire: latestExpired})); });
    expect(timer.deadline).toBe(deadline);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(expired).not.toHaveBeenCalled();
    expect(latestExpired).toHaveBeenCalledTimes(1);
  });

  it.each(['focus', 'pageshow', 'visibilitychange'])('checks the wall clock after %s', async eventName => {
    await mount();
    await act(async () => { timer.start(1); });
    // Changing system time does not run the interval, like a suspended renderer waking up.
    vi.setSystemTime(Date.now() + 90_000);
    expect(expired).not.toHaveBeenCalled();
    await act(async () => {
      const target = eventName === 'visibilitychange' ? document : window;
      target.dispatchEvent(new Event(eventName));
    });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(timer.deadline).toBeNull();
    expect(timer.remainingSeconds).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the remaining time when focus returns before expiry', async () => {
    await mount();
    await act(async () => { timer.start(1); });
    vi.setSystemTime(Date.now() + 12_250);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(timer.remainingSeconds).toBe(48);
    expect(expired).not.toHaveBeenCalled();
  });

  it('cleans up on unmount and starts without a countdown after remounting', async () => {
    await mount();
    await act(async () => { timer.start(1); });
    await act(async () => { root!.unmount(); root = undefined; });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(expired).not.toHaveBeenCalled();
    container.remove();
    await mount();
    expect(timer.deadline).toBeNull();
    expect(timer.remainingSeconds).toBe(0);
  });
});
