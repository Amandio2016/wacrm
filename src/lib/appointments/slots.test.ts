import { describe, expect, it } from "vitest";
import { availableSlots, type SlotQuery } from "./slots";

/**
 * Africa/Maputo is UTC+2, no DST — so 08:00 local = 06:00 UTC, always.
 * The fixtures below say local wall time in comments; assertions are on
 * the UTC instants the engine returns.
 */
const TZ = "Africa/Maputo";

// Monday 2026-07-13 (13 Jul 2026 is a Monday).
const MONDAY = "2026-07-13";
const utc = (iso: string) => new Date(iso);

const base: SlotQuery = {
  // Segundas 08:00–12:00 locais
  windows: [{ dia_semana: 1, hora_inicio: "08:00", hora_fim: "12:00" }],
  exceptions: [],
  busy: [],
  slotMinutes: 30,
  timezone: TZ,
  // Search: the whole of that Monday, in UTC.
  from: utc("2026-07-12T22:00:00Z"), // 00:00 local Monday
  to: utc("2026-07-13T22:00:00Z"), // 00:00 local Tuesday
};

const starts = (q: SlotQuery) =>
  availableSlots(q).map((s) => s.inicio.toISOString());

describe("availableSlots — basics", () => {
  it("fills a 4-hour window with eight 30-minute slots at the right UTC instants", () => {
    const got = starts(base);
    expect(got).toHaveLength(8);
    // 08:00 local = 06:00 UTC
    expect(got[0]).toBe("2026-07-13T06:00:00.000Z");
    // last slot 11:30 local = 09:30 UTC
    expect(got[7]).toBe("2026-07-13T09:30:00.000Z");
  });

  it("returns slot ends exactly slotMinutes after starts", () => {
    const slots = availableSlots(base);
    for (const s of slots) {
      expect(s.fim.getTime() - s.inicio.getTime()).toBe(30 * 60_000);
    }
  });

  it("returns nothing on a weekday with no window", () => {
    expect(
      starts({
        ...base,
        // Search Tuesday instead — window is Monday-only.
        from: utc("2026-07-13T22:00:00Z"),
        to: utc("2026-07-14T22:00:00Z"),
      }),
    ).toHaveLength(0);
  });

  it("drops the remainder of a window not divisible by the slot length", () => {
    const got = starts({
      ...base,
      // 08:00–09:50 → only 08:00, 08:30, 09:00 fit; 09:30–10:00 overflows 09:50
      windows: [{ dia_semana: 1, hora_inicio: "08:00", hora_fim: "09:50" }],
    });
    expect(got).toHaveLength(3);
  });

  it("supports multiple windows on the same day (morning + afternoon)", () => {
    const got = starts({
      ...base,
      windows: [
        { dia_semana: 1, hora_inicio: "08:00", hora_fim: "10:00" },
        { dia_semana: 1, hora_inicio: "14:00", hora_fim: "16:00" },
      ],
    });
    expect(got).toHaveLength(8);
    // Gap: nothing between 10:00 and 14:00 local (08:00–12:00 UTC)
    expect(got.filter((s) => s >= "2026-07-13T08:00" && s < "2026-07-13T12:00")).toHaveLength(0);
  });

  it("accepts HH:MM:SS time strings as Postgres returns them", () => {
    const got = starts({
      ...base,
      windows: [{ dia_semana: 1, hora_inicio: "08:00:00", hora_fim: "09:00:00" }],
    });
    expect(got).toHaveLength(2);
  });
});

describe("availableSlots — collisions with existing appointments", () => {
  it("removes exactly the occupied slot", () => {
    const got = starts({
      ...base,
      // 09:00–09:30 local = 07:00–07:30 UTC
      busy: [{ inicio: "2026-07-13T07:00:00Z", fim: "2026-07-13T07:30:00Z" }],
    });
    expect(got).toHaveLength(7);
    expect(got).not.toContain("2026-07-13T07:00:00.000Z");
  });

  it("a misaligned busy interval kills BOTH slots it touches", () => {
    const got = starts({
      ...base,
      // 08:15–08:45 local — a manual booking by the reception desk
      busy: [{ inicio: "2026-07-13T06:15:00Z", fim: "2026-07-13T06:45:00Z" }],
    });
    expect(got).not.toContain("2026-07-13T06:00:00.000Z"); // 08:00 local
    expect(got).not.toContain("2026-07-13T06:30:00.000Z"); // 08:30 local
    expect(got).toHaveLength(6);
  });

  it("back-to-back appointments do not block their neighbours (half-open ranges)", () => {
    const got = starts({
      ...base,
      // Busy exactly 08:00–08:30 local: the 08:30 slot must survive.
      busy: [{ inicio: "2026-07-13T06:00:00Z", fim: "2026-07-13T06:30:00Z" }],
    });
    expect(got).toContain("2026-07-13T06:30:00.000Z");
  });

  it("ignores zero-length or inverted busy rows instead of corrupting the day", () => {
    const got = starts({
      ...base,
      busy: [
        { inicio: "2026-07-13T06:00:00Z", fim: "2026-07-13T06:00:00Z" },
        { inicio: "2026-07-13T08:00:00Z", fim: "2026-07-13T07:00:00Z" },
      ],
    });
    expect(got).toHaveLength(8);
  });
});

describe("availableSlots — exceptions, lead time, and bounds", () => {
  it("a day exception (férias/feriado) removes the whole day", () => {
    expect(
      starts({ ...base, exceptions: [{ data: MONDAY }] }),
    ).toHaveLength(0);
  });

  it("an exception on another date changes nothing", () => {
    expect(
      starts({ ...base, exceptions: [{ data: "2026-07-14" }] }),
    ).toHaveLength(8);
  });

  it("minLeadMinutes hides slots that start too soon", () => {
    const got = starts({
      ...base,
      // "now" is 08:10 local; with 60 min lead the first offer is 09:30.
      from: utc("2026-07-13T06:10:00Z"),
      minLeadMinutes: 60,
    });
    expect(got[0]).toBe("2026-07-13T07:30:00.000Z");
  });

  it("respects the `to` bound exclusively", () => {
    const got = starts({
      ...base,
      // Cut the search at 10:00 local → last offered start is 09:30.
      to: utc("2026-07-13T08:00:00Z"),
    });
    expect(got[got.length - 1]).toBe("2026-07-13T07:30:00.000Z");
  });

  it("spans multiple weeks without duplicating slots", () => {
    const got = starts({
      ...base,
      from: utc("2026-07-12T22:00:00Z"),
      to: utc("2026-07-26T22:00:00Z"), // two Mondays inside
    });
    expect(got).toHaveLength(16);
    expect(new Set(got).size).toBe(16);
  });

  it("returns [] for a nonsense query instead of throwing", () => {
    expect(starts({ ...base, slotMinutes: 0 })).toHaveLength(0);
    expect(
      starts({ ...base, from: base.to, to: base.from }),
    ).toHaveLength(0);
  });
});

describe("availableSlots — timezone correctness", () => {
  it("a zone ahead of UTC books local morning slots on the correct UTC day", () => {
    // 08:00 Monday local in Maputo is 06:00 Monday UTC — never Sunday.
    const got = availableSlots(base);
    expect(got[0].inicio.getUTCDay()).toBe(1);
  });

  it("the same wall-time schedule lands on different instants in a different zone", () => {
    const maputo = starts(base);
    const saoPaulo = starts({
      ...base,
      timezone: "America/Sao_Paulo", // UTC-3
      from: utc("2026-07-13T00:00:00Z"),
      to: utc("2026-07-14T03:00:00Z"),
    });
    // 08:00 local: Maputo → 06:00 UTC; São Paulo → 11:00 UTC.
    expect(maputo[0]).toBe("2026-07-13T06:00:00.000Z");
    expect(saoPaulo[0]).toBe("2026-07-13T11:00:00.000Z");
  });
});
