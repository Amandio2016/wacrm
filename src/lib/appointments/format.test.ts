import { describe, expect, it } from "vitest";
import {
  formatDayLabel,
  formatTimeLabel,
  formatSlotLabel,
  groupSlotsByDay,
  localDayKey,
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
