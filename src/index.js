import os from 'os';
import { createApp } from './app.js';
import { config, isProd } from './config.js';
import { migrate, pool } from './db.js';
import { ensurePlatformAdmin, ensurePrincipalCaisse } from './services/seed.js';

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

async function main() {
  if (isProd && config.jwtSecret === 'dev-only-change-me') {
    throw new Error('Définissez JWT_SECRET avant de lancer en production.');
  }
  await migrate();
  await ensurePlatformAdmin();
  await ensurePrincipalCaisse();
  const app = createApp();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`JCV Pay API sur http://localhost:${config.port}`);
    console.log(`Swagger sur http://localhost:${config.port}/api/docs`);
    for (const address of lanAddresses()) {
      console.log(`Depuis un téléphone : http://${address}:${config.port}`);
    }
  });
}

main().catch(async (error) => {
  console.error('Démarrage impossible :', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
