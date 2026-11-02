// Every request runs inside one transaction with app.user_id set.
// The database derives the user's companies and roles from memberships (row-level security).
import pg from 'pg';

export type Db = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString });
  // An idle connection dropped by the database (restart, failover) must not crash the server;
  // the pool opens a new connection for the next request.
  pool.on('error', (err) => console.error('Database connection lost:', err.message));
  return pool;
}

export async function withUser<T>(pool: pg.Pool, userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
