import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { config } from "./config.js";

// OpenSlaw keeps monetary values and small counters inside JS safe integer bounds.
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));

export const pool = new Pool({
  connectionString: config.databaseUrl
});

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}
