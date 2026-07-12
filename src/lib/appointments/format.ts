import type { Slot } from "./slots";
import { localDateOf, wallTimeToUtc } from "./slots";

/**
 * Pure label/grouping helpers for the booking dialogue. Everything a
 * patient reads ("seg, 13/07 às 08:00") is produced here, in the
 * CLINIC's timezone — a UTC leak in these labels books people at the
 * wrong hour even when the stored instants are perfect.
 */

/** "seg, 13/07" — weekday + day/month in clinic-local time, pt locale. */
export function formatDayLabel(at: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("pt-PT", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
  // pt-PT emits "seg., 13/07" — the stray period reads badly on a button.
  return fmt.format(at).replace(".", "");
}

/** "08:00" in clinic-local time. */
export function formatTimeLabel(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("pt-PT", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** "seg, 13/07 às 08:00" — for confirmations and reception alerts. */
export function formatSlotLabel(at: Date, timezone: string): string {
  return `${formatDayLabel(at, timezone)} às ${formatTimeLabel(at, timezone)}`;
}

/** Clinic-local "YYYY-MM-DD" of an instant — grouping key for days. */
export function localDayKey(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The [start, end) UTC instants spanning a clinic-local calendar day.
 * `at` picks which local day via `localDateOf`; pass `new Date()` for
 * "today", or an offset instant for "N days from today".
 */
export function localDayRangeUtc(
  at: Date,
  timezone: string,
): { start: Date; end: Date } {
  const { ymd } = localDateOf(timezone, at);
  const start = wallTimeToUtc(timezone, ymd, "00:00");
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

/**
 * The 7 clinic-local calendar days (Monday-first) of the week
 * containing `ref`, as [start, end) UTC ranges each.
 *
 * Each day's range is derived independently via `localDayRangeUtc`
 * rather than by adding 7×86 400 000ms once — so a DST transition
 * inside the week (not a concern for Africa/Maputo, but this is
 * general-purpose) can never drift the boundary by an hour.
 */
export function weekDaysRangeUtc(
  ref: Date,
  timezone: string,
): { start: Date; end: Date }[] {
  const { dow } = localDateOf(timezone, ref);
  const stepsBack = (dow + 6) % 7; // Monday=0 … Sunday=6
  const approxMonday = new Date(
    localDayRangeUtc(ref, timezone).start.getTime() - stepsBack * 86_400_000,
  );
  // Re-snap: the subtraction above assumes fixed-length local days,
  // which localDayRangeUtc corrects for any zone where that's untrue.
  let cursor = localDayRangeUtc(approxMonday, timezone).start;

  const days: { start: Date; end: Date }[] = [];
  for (let i = 0; i < 7; i++) {
    const { start, end } = localDayRangeUtc(cursor, timezone);
    days.push({ start, end });
    cursor = end;
  }
  return days;
}

export interface DayGroup {
  /** "YYYY-MM-DD" clinic-local. */
  key: string;
  label: string;
  slots: Slot[];
}

/**
 * Group a flat slot list by clinic-local day, capped at `maxDays`
 * (WhatsApp lists carry at most 10 rows). Slots arrive sorted from the
 * engine, so groups come out chronological for free.
 */
export function groupSlotsByDay(
  slots: Slot[],
  timezone: string,
  maxDays = 10,
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const slot of slots) {
    const key = localDayKey(slot.inicio, timezone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.slots.push(slot);
    } else {
      if (groups.length === maxDays) break;
      groups.push({
        key,
        label: formatDayLabel(slot.inicio, timezone),
        slots: [slot],
      });
    }
  }
  return groups;
}
