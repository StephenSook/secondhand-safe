import { describe, it, expect, afterEach, vi } from "vitest";
import { parseVector, pipeline, toLookAlike, lookalikesByVector, STRONG_COSINE, DIMS } from "@/server/db/vector";
import { GET, POST } from "@/app/api/lookalike/route";

const vec = (x = 0.1) => Array.from({ length: DIMS }, () => x);
const post = (body: unknown) => POST(new Request("http://x/api/lookalike", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("look-alike query vectors are validated before Atlas is asked", () => {
  it("accepts exactly 512 finite numbers with a non-zero length", () => {
    expect(parseVector(vec())).toHaveLength(DIMS);
    expect(parseVector(vec().slice(1))).toBeNull();
    expect(parseVector([...vec().slice(1), Number.NaN])).toBeNull();
    expect(parseVector([...vec().slice(1), Infinity])).toBeNull();
    expect(parseVector(vec(0))).toBeNull();
    expect(parseVector("0.1,0.2")).toBeNull();
    expect(parseVector([...vec().slice(1), "1" as unknown as number])).toBeNull();
  });

  it("the pipeline searches recall photos only, over the vector index, and asks for enough candidates", () => {
    const [vs, proj] = pipeline(vec(), 3) as unknown as [{ $vectorSearch: Record<string, unknown> }, { $project: Record<string, unknown> }];
    expect(vs.$vectorSearch).toMatchObject({ index: "img_vec", path: "embedding", limit: 3, filter: { kind: "recall" } });
    expect(vs.$vectorSearch.numCandidates as number).toBeGreaterThanOrEqual(60);
    expect(proj.$project.score).toEqual({ $meta: "vectorSearchScore" });
    expect(proj.$project).not.toHaveProperty("embedding");
  });

  it("converts Atlas's (1 + cos) / 2 score back to cosine and marks strong resemblance by the threshold", () => {
    const hi = toLookAlike({ recallNumber: "23088", title: "t", notice: "n", image: "i", score: (1 + STRONG_COSINE) / 2 + 0.01 });
    const lo = toLookAlike({ recallNumber: "23088", title: "t", notice: "n", image: "i", score: 0.6 });
    expect(hi.strong).toBe(true);
    expect(lo.cosine).toBeCloseTo(0.2, 5);
    expect(lo.strong).toBe(false);
  });
});

describe("the look-alike endpoint", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("refuses malformed input with 400 and never calls Atlas", async () => {
    expect((await post({ embedding: vec().slice(3) })).status).toBe(400);
    expect((await post({ listingId: "../../etc/passwd" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await GET(new Request("http://x/api/lookalike?listingId=%3Cscript%3E"))).status).toBe(400);
  });
  it("counts malformed requests against the rate limit too", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200)}`;
    const bad = () => POST(new Request("http://x/api/lookalike", { method: "POST", headers: { "x-forwarded-for": ip }, body: "not json" }));
    for (let i = 0; i < 60; i++) expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
  });
  it("answers 503, not a fake match, when Atlas is not configured", async () => {
    vi.stubEnv("MONGODB_URI", "");
    expect(await lookalikesByVector(vec())).toEqual({ ok: false, reason: "unconfigured" });
    const r = await post({ embedding: vec() });
    expect(r.status).toBe(503);
    expect(await r.json()).not.toHaveProperty("matches");
  });
});
