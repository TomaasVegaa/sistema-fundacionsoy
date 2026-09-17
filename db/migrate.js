// Corre schema.sql contra la base de datos (local o Render via DATABASE_URL)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const pool = require('../src/db/pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Aplicando esquema de base de datos...');
  try {
    await pool.query(sql);
    console.log('Esquema aplicado correctamente.');

    // Asegurar que exista al menos un usuario administrador
    const userCount = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
    if (userCount.rows[0].total === 0) {
      const passwordHash = await bcrypt.hash('admin123', 12);
      await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, rol)
         VALUES ($1, $2, $3, 'admin')
         ON CONFLICT (email) DO NOTHING`,
        ['Administrador', 'admin@fundacionsoy.org', passwordHash]
      );
      console.log('✓ Usuario administrador inicial creado: admin@fundacionsoy.org / admin123');
    }
  } catch (err) {
    console.error('Error aplicando el esquema:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
