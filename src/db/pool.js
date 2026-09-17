const { Pool } = require('pg');

// Local / .env clasico: usa PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.
// Render (y otros hosts administrados) exponen en cambio una unica
// DATABASE_URL y exigen SSL -> si esta presente, se prioriza esa.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    })
  : new Pool();

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de Postgres:', err.message);
});

module.exports = pool;
