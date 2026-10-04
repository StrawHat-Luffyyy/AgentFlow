import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient, type QueryResultRow } from "pg";

const { Pool } = pg;

export type Database = pg.Pool;
export type Transaction = PoolClient;

export function createDatabase(connectionString: string): Database {
  const pool = new Pool({ connectionString, max: 10 });
  // An idle client can fail when PostgreSQL restarts; without a listener the process crashes.
  pool.on("error", (error) => {
    console.error("PostgreSQL idle client error", error);
  });
  return pool;
}

export async function withTransaction<T>(
  database: Database,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // A connection that cannot roll back must not be returned to the pool.
      releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function one<T extends QueryResultRow>(
  client: Pick<Database, "query"> | Pick<Transaction, "query">,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await client.query<T>(text, values);
  if (result.rows.length !== 1) {
    throw new Error(`Expected exactly one row, received ${result.rows.length}`);
  }
  return result.rows[0] as T;
}

export async function migrate(database: Database): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [1_017_041]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS agentflow_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const name of migrations) {
      const existing = await client.query(
        "SELECT 1 FROM agentflow_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount !== 0) continue;

      const sql = await readFile(`${migrationDirectory}/${name}`, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO agentflow_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [1_017_041]).catch(() => undefined);
    client.release();
  }
}
