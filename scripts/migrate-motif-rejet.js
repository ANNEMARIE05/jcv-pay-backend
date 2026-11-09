import { pool } from '../src/db.js';

async function migrate() {
  try {
    await pool.query(`
      ALTER TABLE transactions 
      ADD COLUMN IF NOT EXISTS motif_rejet TEXT;
    `);
    console.log('Migration OK: motif_rejet ajouté à transactions.');
  } catch (err) {
    console.error('Erreur migration:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();
