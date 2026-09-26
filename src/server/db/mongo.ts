import { MongoClient, type Db } from "mongodb";

/**
 * MongoDB Atlas (PLAN 3.11). One client per server instance, reused across requests (Fluid Compute keeps it
 * warm). Returns null when MONGODB_URI is not configured, so every caller can degrade instead of failing.
 */
let clientPromise: Promise<MongoClient> | null = null;

export async function getDb(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) return null;
  if (!clientPromise) {
    clientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 5, appName: "lullabuy" }).connect();
    clientPromise.catch(() => { clientPromise = null; }); // retry on the next request after a failed connect
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB?.trim() || "lullabuy");
}
