import { createApp } from './app.js';
import { config, isProd } from './config.js';
import { migrate, pool } from './db.js';
import { ensurePlatformAdmin, ensurePrincipalCaisse } from './services/seed.js';

async function main() {
  if (isProd && config.jwtSecret === 'dev-only-change-me') {
    throw new Error('Définissez JWT_SECRET avant de lancer en production.');
  }
  await migrate();
  await ensurePlatformAdmin();
  await ensurePrincipalCaisse();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`JCV Pay API sur ${config.publicBaseUrl}`);
    console.log(`Swagger sur ${config.publicBaseUrl}/api/docs`);
  });
}

main().catch(async (error) => {
  console.error('Démarrage impossible :', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
