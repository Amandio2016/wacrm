/**
 * Slot engine — computes a professional's free, bookable time slots.
 *
 * Pure: takes rows (weekly availability, exceptions, busy intervals)
 * and returns UTC instants. No database, no Date.now() — the caller
 * injects the search window, which is what makes this exhaustively
 * testable, and testable is non-negotiable here: a bug in this file
 * double-books a doctor or offers a 03:00 slot to a patient.
 *
 * Timezone model: weekly availability is stored as CLINIC-LOCAL wall
 * time ("segundas 08:00–12:00") + the account's IANA timezone.
 * This engine converts wall time to UTC per concrete date via Intl —
 * no date library needed, and correct even for DST zones (Africa/Maputo
 * has none, but the code must not care).
 *
 * The DB's EXCLUDE constraint (migration 041) remains the last line of
 * defense against races — this engine is about not OFFERING taken
 * slots, the constraint is about not ACCEPTING them.
 */

export interface WeeklyWindow {
  /** 0 = domingo … 6 = sábado — matches Postgres EXTRACT(DOW). */
  dia_semana: number;
  /** Clinic-local wall time, "HH:MM" or "HH:MM:SS". */
  hora_inicio: string;
  hora_fim: string;
}

export interface DayException {
  /** "YYYY-MM-DD" in clinic-local terms. Whole day off. */
  data: string;
}

export interface BusyInterval {
  /** UTC instants (ISO strings or Dates) of existing appointments. */
  inicio: string | Date;
  fim: string | Date;
}

export interface SlotQuery {
  windows: WeeklyWindow[];
  exceptions: DayException[];
  busy: BusyInterval[];
  /** Slot length offered, from profissionais.duracao_consulta_minutos. */
  slotMinutes: number;
  /** IANA zone from accounts.timezone, e.g. "Africa/Maputo". */
  timezone: string;
  /** Search window (UTC). Slots starting before `from` or at/after `to`
   *  are not returned. */
  from: Date;
  to: Date;
  /** Don't offer slots starting sooner than this many minutes after
   *  `from` — a patient booking "in 3 minutes" helps nobody. */
  minLeadMinutes?: number;
}

export interface Slot {
  inicio: Date;
  fim: Date;
}

const DAY_MS = 86_400_000;

/**
 * Offset of `tz` from UTC at instant `at`, in ms. Positive east of
 * Greenwich (Africa/Maputo → +7 200 000).
 */
function tzOffsetMs(tz: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;

  // "GMT+02:00", "GMT-03:30", or bare "GMT" for UTC itself.
  const m = name?.match(/GMT(?:([+-])(\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`Cannot resolve offset for timezone "${tz}"`);
  if (!m[1]) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000);
}

/** Local calendar date + weekday of a UTC instant, in `tz`. */
function localDateOf(tz: string, at: Date): { ymd: string; dow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(at);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    dow: dowMap[get("weekday")],
  };
}

/**
 * Convert clinic-local wall time on a given local date to a UTC instant.
 * Two-pass: guess with the offset at an approximate instant, then
 * re-check the offset at the guess (handles DST transitions; a no-op
 * for fixed-offset zones).
 */
function wallTimeToUtc(tz: string, ymd: string, hhmm: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);

  const offset = tzOffsetMs(tz, new Date(naive));
  let guess = new Date(naive - offset);
  const refined = tzOffsetMs(tz, guess);
  if (refined !== offset) guess = new Date(naive - refined);
  return guess;
}

function toMs(v: string | Date): number {
  return (v instanceof Date ? v : new Date(v)).getTime();
}

/**
 * All free slots for one professional inside [from, to).
 *
 * Overlap rule is strict interval intersection — a busy 08:15–08:45
 * kills BOTH the 08:00 and the 08:30 slot, because neither can run
 * uninterrupted. Slots are aligned to hora_inicio in steps of
 * slotMinutes; a window whose length isn't a multiple of the slot
 * simply loses the remainder (08:00–11:50 with 30-min slots ends at
 * 11:30).
 */
export function availableSlots(query: SlotQuery): Slot[] {
  const {
    windows,
    exceptions,
    busy,
    slotMinutes,
    timezone,
    from,
    to,
    minLeadMinutes = 0,
  } = query;

  if (slotMinutes <= 0 || to.getTime() <= from.getTime()) return [];

  const closedDays = new Set(exceptions.map((e) => e.data));
  const busyRanges = busy
    .map((b) => ({ start: toMs(b.inicio), end: toMs(b.fim) }))
    .filter((b) => b.end > b.start);

  const earliestStart = from.getTime() + minLeadMinutes * 60_000;
  const slotMs = slotMinutes * 60_000;
  const out: Slot[] = [];

  // Walk local calendar days. Start one day early: a UTC `from` can land
  // late in the previous local day for zones ahead of UTC.
  for (
    let cursor = from.getTime() - DAY_MS;
    cursor < to.getTime() + DAY_MS;
    cursor += DAY_MS
  ) {
    const { ymd, dow } = localDateOf(timezone, new Date(cursor));
    if (closedDays.has(ymd)) continue;

    for (const w of windows) {
      if (w.dia_semana !== dow) continue;

      const windowStart = wallTimeToUtc(timezone, ymd, w.hora_inicio);
      const windowEnd = wallTimeToUtc(timezone, ymd, w.hora_fim);
      if (windowEnd.getTime() <= windowStart.getTime()) continue;

      for (
        let s = windowStart.getTime();
        s + slotMs <= windowEnd.getTime();
        s += slotMs
      ) {
        const e = s + slotMs;
        if (s < earliestStart) continue;
        if (s >= to.getTime()) break;

        const collides = busyRanges.some((b) => s < b.end && b.start < e);
        if (!collides) out.push({ inicio: new Date(s), fim: new Date(e) });
      }
    }
  }

  // Windows may arrive unordered, and the ±1-day walk can enumerate a
  // local date from two cursors. Sort + dedupe by start instant.
  out.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  return out.filter(
    (s, i) => i === 0 || s.inicio.getTime() !== out[i - 1].inicio.getTime(),
  );
}
