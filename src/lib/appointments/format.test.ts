import { describe, expect, it } from "vitest";
import {
  formatDayLabel,
  formatTimeLabel,
  formatSlotLabel,
  groupSlotsByDay,
  localDayKey,
  localDayRangeUtc,
  weekDaysRangeUtc,
} from "./format";

const TZ = "Africa/Maputo"; // UTC+2
// 06:00 UTC = 08:00 local, Monday 13 Jul 2026
const MON_8AM = new Date("2026-07-13T06:00:00Z");

describe("labels in clinic-local time", () => {
  it("renders hour in the clinic zone, not UTC", () => {
    expect(formatTimeLabel(MON_8AM, TZ)).toBe("08:00");
  });

  it("renders the day with weekday, no stray period", () => {
    const label = formatDayLabel(MON_8AM, TZ);
    expect(label).toContain("13/07");
    expect(label).not.toContain(".");
  });

  it("composes the full slot label", () => {
    expect(formatSlotLabel(MON_8AM, TZ)).toMatch(/13\/07 às 08:00$/);
  });

  it("an instant late in the UTC day belongs to the NEXT local day east of UTC", () => {
    // 23:00 UTC Monday = 01:00 local Tuesday in Maputo.
    expect(localDayKey(new Date("2026-07-13T23:00:00Z"), TZ)).toBe("2026-07-14");
  });
});

describe("localDayRangeUtc", () => {
  it("spans exactly 24h from clinic-local midnight to midnight", () => {
    const { start, end } = localDayRangeUtc(MON_8AM, TZ);
    // 00:00 local Monday = 22:00 UTC Sunday (UTC+2)
    expect(start.toISOString()).toBe("2026-07-12T22:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it("contains the instant it was derived from", () => {
    const { start, end } = localDayRangeUtc(MON_8AM, TZ);
    expect(MON_8AM.getTime() >= start.getTime()).toBe(true);
    expect(MON_8AM.getTime() < end.getTime()).toBe(true);
  });

  it("differs by the zone offset in a different timezone", () => {
    const spEnd = localDayRangeUtc(MON_8AM, "America/Sao_Paulo").start;
    const mzStart = localDayRangeUtc(MON_8AM, TZ).start;
    expect(spEnd.getTime()).not.toBe(mzStart.getTime());
  });
});

describe("weekDaysRangeUtc", () => {
  it("returns 7 consecutive days", () => {
    const days = weekDaysRangeUtc(MON_8AM, TZ);
    expect(days).toHaveLength(7);
    for (let i = 1; i < days.length; i++) {
      expect(days[i].start.getTime()).toBe(days[i - 1].end.getTime());
    }
  });

  it("starts on Monday regardless of which weekday `ref` falls on", () => {
    // Thursday 16 Jul 2026, still the same week as MON_8AM (13 Jul).
    const thursday = new Date("2026-07-16T10:00:00Z");
    const daysFromMonday = weekDaysRangeUtc(MON_8AM, TZ);
    const daysFromThursday = weekDaysRangeUtc(thursday, TZ);
    expect(daysFromThursday[0].start.getTime()).toBe(daysFromMonday[0].start.getTime());
  });

  it("the reference instant falls within its own week's range", () => {
    const days = weekDaysRangeUtc(MON_8AM, TZ);
    expect(MON_8AM.getTime() >= days[0].start.getTime()).toBe(true);
    expect(MON_8AM.getTime() < days[6].end.getTime()).toBe(true);
  });

  it("a Sunday reference still belongs to the week that started the prior Monday", () => {
    // Sunday 19 Jul 2026 local — last day of the same week.
    const sunday = new Date("2026-07-19T10:00:00Z");
    const days = weekDaysRangeUtc(sunday, TZ);
    const monday = weekDaysRangeUtc(MON_8AM, TZ);
    expect(days[0].start.getTime()).toBe(monday[0].start.getTime());
  });
});

describe("groupSlotsByDay", () => {
  const slot = (iso: string) => ({
    inicio: new Date(iso),
    fim: new Date(new Date(iso).getTime() + 30 * 60_000),
  });

  it("groups consecutive slots into their local days", () => {
    const groups = groupSlotsByDay(
      [
        slot("2026-07-13T06:00:00Z"),
        slot("2026-07-13T06:30:00Z"),
        slot("2026-07-14T06:00:00Z"),
      ],
      TZ,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].slots).toHaveLength(2);
    expect(groups[1].key).toBe("2026-07-14");
  });

  it("caps the number of days (WhatsApp lists max 10 rows)", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      slot(new Date(Date.UTC(2026, 6, 13 + i, 6, 0)).toISOString()),
    );
    expect(groupSlotsByDay(many, TZ, 10)).toHaveLength(10);
  });

  it("splits a slot after local midnight into the next day's group", () => {
    const groups = groupSlotsByDay(
      [
        slot("2026-07-13T21:30:00Z"), // 23:30 local Mon
        slot("2026-07-13T22:00:00Z"), // 00:00 local Tue
      ],
      TZ,
    );
    expect(groups).toHaveLength(2);
  });

  it("returns [] for no slots", () => {
    expect(groupSlotsByDay([], TZ)).toHaveLength(0);
  });
});
