import { pool } from '../src/db.js';

async function testDb() {
  try {
    const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'");
    console.log('Colonnes transactions:', res.rows.map(r => r.column_name));
    const txCount = await pool.query('SELECT count(*) FROM transactions');
    console.log('Nombre transactions:', txCount.rows[0].count);
  } catch (err) {
    console.error('Erreur DB:', err.message);
  } finally {
    await pool.end();
  }
}

testDb();
