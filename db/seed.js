// Carga datos de prueba: eventos, egresos y un usuario admin.
require('dotenv').config();
const dayjs = require('dayjs');
const bcrypt = require('bcrypt');
const pool = require('../src/db/pool');

const SALT_ROUNDS = 12;

async function main() {
  try {
    // --- Usuario admin por defecto ---
    const passwordHash = await bcrypt.hash('fundacionsoy123', SALT_ROUNDS);
    await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ('fundacionsoy', 'fundacionsoy@fundacionsoy.org', $1, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, nombre = 'fundacionsoy'`,
      [passwordHash]
    );
    console.log('Usuario configurado: fundacionsoy / fundacionsoy123');

    // --- Evento de ejemplo ---
    const evento = await pool.query(
      `INSERT INTO eventos (nombre, fecha, descripcion)
       VALUES ('Cena a beneficio 2026', $1, 'Cena anual para recaudar fondos para el comedor')
       RETURNING id`,
      [dayjs().subtract(20, 'day').format('YYYY-MM-DD')]
    );
    const eventoId = evento.rows[0].id;

    // --- Egresos de ejemplo ---
    await pool.query(
      `INSERT INTO egresos (fecha, concepto, monto, categoria, evento_id)
       VALUES
       ($1, 'Alquiler de salon', 180000, 'evento', $2),
       ($3, 'Catering', 95000, 'evento', $2),
       ($4, 'Insumos de oficina', 12000, 'administrativo', NULL)`,
      [
        dayjs().subtract(18, 'day').format('YYYY-MM-DD'), eventoId,
        dayjs().subtract(17, 'day').format('YYYY-MM-DD'),
        dayjs().subtract(5, 'day').format('YYYY-MM-DD'),
      ]
    );

    console.log('Datos de ejemplo cargados. Evento id:', eventoId);
    console.log('Ahora subi un archivo de donaciones (ver /donaciones/importar) para ver el flujo completo.');
  } catch (err) {
    console.error('Error cargando datos de ejemplo:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
