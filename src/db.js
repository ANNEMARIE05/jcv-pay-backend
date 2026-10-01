import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function migrate() {
  const sqlDir = path.join(__dirname, 'sql');
  const schema = fs.readFileSync(path.join(sqlDir, 'schema.sql'), 'utf8');
  const security = fs.readFileSync(path.join(sqlDir, 'security.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(security);
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
