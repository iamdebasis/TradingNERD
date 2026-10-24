import {
  MarketSchedule,
  type MarketScheduleData,
  type MarketStatus,
  marketStatus,
} from '@tradingnerd/core';
import { useEffect, useState } from 'react';

const schedules = new WeakMap<MarketScheduleData, MarketSchedule>();

/** One MarketSchedule per symbol's calendar, however many rows show it. */
export function scheduleOf(data: MarketScheduleData): MarketSchedule {
  let schedule = schedules.get(data);
  if (!schedule) {
    schedule = new MarketSchedule(data);
    schedules.set(data, schedule);
  }
  return schedule;
}

/**
 * Where a market is in its day now (always open without a calendar), updated at each session
 * boundary as it passes.
 */
export function useMarketStatus(data: MarketScheduleData | undefined): MarketStatus {
  const schedule = data ? scheduleOf(data) : null;
  const [status, setStatus] = useState(() => marketStatus(schedule, Date.now()).status);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = Date.now();
      const next = marketStatus(schedule, now);
      setStatus(next.status);
      if (next.until !== null) timer = setTimeout(update, next.until - now + 50);
    };
    update();
    return () => clearTimeout(timer);
  }, [schedule]);
  return status;
}
