import type { Slot } from "./slots";

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
