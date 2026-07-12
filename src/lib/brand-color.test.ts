import { describe, expect, it } from "vitest";
import {
  isValidHex,
  relativeLuminance,
  bestForeground,
  buildPrimaryOverrides,
  PRIMARY_OVERRIDE_VARS,
} from "./brand-color";

describe("isValidHex", () => {
  it("accepts a well-formed 6-digit hex", () => {
    expect(isValidHex("#1a2b3c")).toBe(true);
    expect(isValidHex("#FFFFFF")).toBe(true);
  });

  it("rejects shorthand, missing #, and garbage", () => {
    expect(isValidHex("#fff")).toBe(false);
    expect(isValidHex("1a2b3c")).toBe(false);
    expect(isValidHex("not a color")).toBe(false);
    expect(isValidHex(null)).toBe(false);
    expect(isValidHex(undefined)).toBe(false);
    expect(isValidHex("")).toBe(false);
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("orders colours by perceived brightness", () => {
    expect(relativeLuminance("#ffff00")).toBeGreaterThan(relativeLuminance("#0000ff"));
  });
});

describe("bestForeground", () => {
  it("picks dark text on a bright colour", () => {
    expect(bestForeground("#ffff00")).toBe("#0a0a0a"); // yellow
    expect(bestForeground("#ffffff")).toBe("#0a0a0a");
  });

  it("picks light text on a dark colour", () => {
    expect(bestForeground("#000080")).toBe("#ffffff"); // navy
    expect(bestForeground("#000000")).toBe("#ffffff");
  });

  it("never throws on a mid-tone colour", () => {
    expect(() => bestForeground("#808080")).not.toThrow();
    expect(["#ffffff", "#0a0a0a"]).toContain(bestForeground("#808080"));
  });
});

describe("buildPrimaryOverrides", () => {
  it("sets every variable the theme system defines", () => {
    const overrides = buildPrimaryOverrides("#3366ff");
    for (const key of PRIMARY_OVERRIDE_VARS) {
      expect(overrides).toHaveProperty(key);
    }
  });

  it("uses the raw hex for the flat colour variables", () => {
    const overrides = buildPrimaryOverrides("#3366ff");
    expect(overrides["--primary"]).toBe("#3366ff");
    expect(overrides["--ring"]).toBe("#3366ff");
    expect(overrides["--chart-1"]).toBe("#3366ff");
    expect(overrides["--sidebar-primary"]).toBe("#3366ff");
  });

  it("derives hover/soft variants as color-mix expressions carrying the hex", () => {
    const overrides = buildPrimaryOverrides("#3366ff");
    expect(overrides["--primary-hover"]).toContain("#3366ff");
    expect(overrides["--primary-hover"]).toContain("color-mix");
    expect(overrides["--primary-soft"]).toContain("color-mix");
    expect(overrides["--primary-soft-2"]).toContain("color-mix");
  });

  it("picks a contrasting foreground consistent with bestForeground", () => {
    const overrides = buildPrimaryOverrides("#ffff00");
    expect(overrides["--primary-foreground"]).toBe(bestForeground("#ffff00"));
  });
});
