import {useCallback, useEffect, useRef, useState} from 'react';

type SleepTimerState = {deadline: number | null; remainingSeconds: number};

const stopped: SleepTimerState = {deadline: null, remainingSeconds: 0};

export function useSleepTimer(onExpire: () => void) {
  const [timer, setTimer] = useState<SleepTimerState>(stopped);
  const [run, setRun] = useState(0);
  const deadlineRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const clearIntervalTimer = useCallback(() => {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    deadlineRef.current = null;
    clearIntervalTimer();
    setTimer(stopped);
  }, [clearIntervalTimer]);

  const checkDeadline = useCallback(() => {
    const deadline = deadlineRef.current;
    if (deadline === null) return;
    const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remainingSeconds === 0) {
      // Clear before invoking the callback so simultaneous wake events cannot fire twice.
      cancel();
      onExpireRef.current();
      return;
    }
    setTimer(current => current.deadline === deadline && current.remainingSeconds === remainingSeconds
      ? current : {deadline, remainingSeconds});
  }, [cancel]);

  const start = useCallback((minutes: number) => {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return false;
    const deadline = Date.now() + minutes * 60_000;
    deadlineRef.current = deadline;
    setTimer({deadline, remainingSeconds: minutes * 60});
    setRun(current => current + 1);
    return true;
  }, []);

  useEffect(() => {
    if (timer.deadline === null) return;
    intervalRef.current = window.setInterval(checkDeadline, 1000);
    return clearIntervalTimer;
  }, [timer.deadline, run, checkDeadline, clearIntervalTimer]);

  useEffect(() => {
    // Timers may be throttled while hidden or suspended; use the wall-clock deadline on return.
    window.addEventListener('focus', checkDeadline);
    window.addEventListener('pageshow', checkDeadline);
    document.addEventListener('visibilitychange', checkDeadline);
    return () => {
      deadlineRef.current = null;
      clearIntervalTimer();
      window.removeEventListener('focus', checkDeadline);
      window.removeEventListener('pageshow', checkDeadline);
      document.removeEventListener('visibilitychange', checkDeadline);
    };
  }, [checkDeadline, clearIntervalTimer]);

  return {...timer, start, cancel};
}
