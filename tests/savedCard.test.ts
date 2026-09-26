import { describe, it, expect } from "vitest";
import { issueSavedCard, verifySavedCard } from "@/server/visa/savedCard";

const signing = Buffer.from("sandbox-signing").toString("base64");
const NOT_WRAPPED = ["0123456789ABCDEF", "0123456789ABCDEF"].join(""); // a bare customer id, not our signed wrapper
describe("saved card (Visa TMS customer token, signed by us)", () => {
  it("round-trips and keeps only the last digits of the masked number", () => {
    const t = issueSavedCard(signing, { customerId: "0123456789ABCDEF0123456789ABCDEF", masked: "411111XXXXXX1111" });
    expect(verifySavedCard(signing, t)).toMatchObject({ customerId: "0123456789ABCDEF0123456789ABCDEF", masked: "XXXX1111" });
  });
  it("refuses a guessed or edited customer id, another key, junk, and an expired token", () => {
    const t = issueSavedCard(signing, { customerId: "0123456789ABCDEF0123456789ABCDEF", masked: "XXXX1111" });
    const [body, sig] = t.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), customerId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toString("base64url");
    expect(verifySavedCard(signing, `${edited}.${sig}`)).toBeNull();
    expect(verifySavedCard(Buffer.from("other").toString("base64"), t)).toBeNull();
    expect(verifySavedCard(signing, NOT_WRAPPED)).toBeNull();
    expect(verifySavedCard(signing, { customerId: "x" })).toBeNull();
    expect(verifySavedCard(signing, t, Date.now() + 8 * 24 * 3600 * 1000)).toBeNull();
  });
});
