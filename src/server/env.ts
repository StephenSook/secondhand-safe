import { z } from "zod";

/**
 * Environment contract. Each feature asks for exactly the keys it needs (requireEnv), so a missing Visa
 * key never takes down the recall check. parseEnv() is the strict whole-app parse used by the health
 * report and CI; it names every missing key at once.
 */

type Source = Record<string, string | undefined>;

export const INTEGRATIONS = {
  visa: ["VISA_MERCHANT_ID", "VISA_KEY_ID", "VISA_SECRET_KEY"],
  mongo: ["MONGODB_URI"],
  gemini: ["GEMINI_API_KEY"],
  elevenlabs: ["ELEVENLABS_API_KEY"],
  tap: ["TAP_AGENT_PRIVATE_KEY_HEX", "TAP_AGENT_KEY_ID"],
  solana: ["SOLANA_SECRET_KEY_B58"],
} as const;

export type Integration = keyof typeof INTEGRATIONS;

const present = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

export class MissingEnvError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing environment variables: ${missing.join(", ")}`);
    this.name = "MissingEnvError";
  }
}

const schema = z.object({
  VISA_MERCHANT_ID: z.string().min(1),
  VISA_KEY_ID: z.string().min(1),
  VISA_SECRET_KEY: z.string().min(1),
  VISA_HOST: z.string().default("apitest.cybersource.com"),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default("lullabuy"),
  GEMINI_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().optional(),
  TAP_AGENT_PRIVATE_KEY_HEX: z.string().length(64),
  TAP_AGENT_KEY_ID: z.string().min(1),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  SOLANA_SECRET_KEY_B58: z.string().optional(),
  PUBLIC_BASE_URL: z.url(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(src: Source = process.env): Env {
  const clean = Object.fromEntries(Object.entries(src).filter(([, v]) => present(v)));
  const r = schema.safeParse(clean);
  if (!r.success) {
    const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
    const order = Object.keys(schema.shape);
    names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    throw new MissingEnvError(names);
  }
  return r.data;
}

export function requireEnv<K extends string>(keys: readonly K[], src: Source = process.env): Record<K, string> {
  const missing = keys.filter((k) => !present(src[k]));
  if (missing.length) throw new MissingEnvError(missing);
  return Object.fromEntries(keys.map((k) => [k, (src[k] as string).trim()])) as Record<K, string>;
}

export function integrationStatus(src: Source = process.env): Record<Integration, boolean> {
  return Object.fromEntries(
    (Object.keys(INTEGRATIONS) as Integration[]).map((k) => [k, INTEGRATIONS[k].every((n) => present(src[n]))]),
  ) as Record<Integration, boolean>;
}
