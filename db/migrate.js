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
    console.log('✓ Esquema aplicado correctamente.');

    // Asegurar que exista al menos un usuario administrador
    const passwordHash = await bcrypt.hash('fundacionsoy123', 12);
    await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ('fundacionsoy', 'fundacionsoy@fundacionsoy.org', $1, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, nombre = 'fundacionsoy'`,
      [passwordHash]
    );
    console.log('✓ Usuario configurado: fundacionsoy / fundacionsoy123');
  } catch (err) {
    console.warn('Aviso en migración:', err.message || err);
    // Si estamos en entorno Render durante la fase de Build, no romper el despliegue
    if (process.env.RENDER) {
      console.log('Continuando despliegue (la inicialización de base de datos correrá al iniciar la app).');
      process.exitCode = 0;
      return;
    }
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch (_) {}
  }
}

main();
