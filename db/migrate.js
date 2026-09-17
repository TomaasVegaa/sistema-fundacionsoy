// Corre schema.sql contra la base configurada en .env
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool();
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log(`Conectando a ${process.env.PGDATABASE}@${process.env.PGHOST}:${process.env.PGPORT} ...`);
  try {
    await pool.query(sql);
    console.log('Esquema aplicado correctamente.');
  } catch (err) {
    console.error('Error aplicando el esquema:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
