import { describe, it, expect } from "vitest";
import { parseEnv, requireEnv, integrationStatus, MissingEnvError } from "@/server/env";

describe("env", () => {
  it("names every missing key", () => {
    expect(() => parseEnv({})).toThrow(/VISA_MERCHANT_ID.*MONGODB_URI/s);
  });

  it("requireEnv names only the missing keys a feature needs", () => {
    try {
      requireEnv(["GEMINI_API_KEY", "MONGODB_URI"], { MONGODB_URI: "mongodb://x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingEnvError);
      expect((e as MissingEnvError).missing).toEqual(["GEMINI_API_KEY"]);
    }
  });

  it("treats blank strings as missing", () => {
    expect(() => requireEnv(["GEMINI_API_KEY"], { GEMINI_API_KEY: "  " })).toThrow(/GEMINI_API_KEY/);
  });

  it("reports integration status as booleans and never leaks a value", () => {
    const s = integrationStatus({ GEMINI_API_KEY: "secret-value-123" });
    expect(s.gemini).toBe(true);
    expect(s.visa).toBe(false);
    expect(JSON.stringify(s)).not.toContain("secret-value-123");
  });
});
