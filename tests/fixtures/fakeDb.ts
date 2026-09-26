import type { Db } from "mongodb";

/**
 * A tiny in-memory stand-in for the MongoDB calls the recall call makes. Every operation yields to the event loop
 * first, so concurrent callers interleave, and each operation then runs to completion in one tick, the way a single
 * document write is atomic in Atlas. It proves the LOGIC of the claims and caps; Atlas's own atomicity is assumed.
 */
type Doc = Record<string, unknown> & { _id: string };
const tick = () => new Promise((ok) => setTimeout(ok, 0));

function matches(d: Doc, f: Record<string, unknown>): boolean {
  return Object.entries(f).every(([k, v]) => {
    const got = k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], d);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const op = v as Record<string, unknown>;
      if ("$lt" in op) return typeof got === "number" && got < (op.$lt as number);
      if ("$in" in op) return (op.$in as unknown[]).includes(got);
      if ("$ne" in op) return got !== op.$ne;
    }
    return got === v;
  });
}

function apply(d: Doc, u: Record<string, Record<string, unknown>>, inserting: boolean) {
  for (const [k, v] of Object.entries(u.$set ?? {})) d[k] = v;
  for (const [k, v] of Object.entries(u.$inc ?? {})) d[k] = ((d[k] as number) ?? 0) + (v as number);
  if (inserting) for (const [k, v] of Object.entries(u.$setOnInsert ?? {})) d[k] = v;
  for (const [k, v] of Object.entries(u.$push ?? {})) d[k] = [...((d[k] as unknown[]) ?? []), v];
}

export function fakeDb(opts: { failing?: string[] } = {}) {
  const data = new Map<string, Map<string, Doc>>();
  const col = (name: string) => { if (!data.has(name)) data.set(name, new Map()); return data.get(name)!; };
  const guard = (name: string) => { if (opts.failing?.includes(name)) throw new Error(`${name} is down`); };
  const db = {
    collection(name: string) {
      const c = col(name);
      return {
        async createIndex() { return "ok"; },
        async insertOne(d: Doc) {
          await tick(); guard(name);
          if (c.has(d._id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
          c.set(d._id, structuredClone(d)); return { insertedId: d._id };
        },
        async updateOne(f: Record<string, unknown>, u: Record<string, Record<string, unknown>>, o?: { upsert?: boolean }) {
          await tick(); guard(name);
          const hit = [...c.values()].find((d) => matches(d, f));
          if (hit) { apply(hit, u, false); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; }
          if (!o?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
          const id = f._id as string;
          if (c.has(id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
          const d: Doc = { _id: id };
          apply(d, u, true); c.set(id, d);
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        },
        async findOne(f: Record<string, unknown>) {
          await tick(); guard(name);
          const d = [...c.values()].find((x) => matches(x, f));
          return d ? structuredClone(d) : null;
        },
        find(f: Record<string, unknown>) {
          return { toArray: async () => { await tick(); guard(name); return [...c.values()].filter((x) => matches(x, f)).map((x) => structuredClone(x)); } };
        },
      };
    },
  };
  return { db: db as unknown as Db, data, docs: (name: string) => [...col(name).values()] };
}
