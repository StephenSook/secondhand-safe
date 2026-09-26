import { describe, it, expect } from "vitest";
import { issueSavedCard, verifySavedCard } from "@/server/visa/savedCard";

const secret = Buffer.from("sandbox-secret").toString("base64");
describe("saved card (Visa TMS customer token, signed by us)", () => {
  it("round-trips and keeps only the last digits of the masked number", () => {
    const t = issueSavedCard(secret, { customerId: "5C65F191C5AC936DE063A2598D0A6909", masked: "411111XXXXXX1111" });
    expect(verifySavedCard(secret, t)).toMatchObject({ customerId: "5C65F191C5AC936DE063A2598D0A6909", masked: "XXXX1111" });
  });
  it("refuses a guessed or edited customer id, another key, junk, and an expired token", () => {
    const t = issueSavedCard(secret, { customerId: "5C65F191C5AC936DE063A2598D0A6909", masked: "XXXX1111" });
    const [body, sig] = t.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), customerId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toString("base64url");
    expect(verifySavedCard(secret, `${edited}.${sig}`)).toBeNull();
    expect(verifySavedCard(Buffer.from("other").toString("base64"), t)).toBeNull();
    expect(verifySavedCard(secret, "5C65F191C5AC936DE063A2598D0A6909")).toBeNull();
    expect(verifySavedCard(secret, { customerId: "x" })).toBeNull();
    expect(verifySavedCard(secret, t, Date.now() + 31 * 24 * 3600 * 1000)).toBeNull();
  });
});
