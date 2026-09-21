const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const app = require('./app');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3000;

async function inicializarBaseDeDatos() {
  // 1. Aplicar o verificar esquema
  try {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      console.log('✓ Esquema de base de datos verificado.');
    }
  } catch (err) {
    console.error('Aviso al verificar esquema de base de datos:', err.message || err);
  }

  // 2. Configurar usuarios fundacionsoy y admin con clave fundacionsoy123
  try {
    const passwordHash = await bcrypt.hash('fundacionsoy123', 12);

    // Usuario fundacionsoy
    await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
       VALUES ('fundacionsoy', 'fundacionsoy@fundacionsoy.org', $1, 'admin', TRUE)
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, nombre = 'fundacionsoy', activo = TRUE`,
      [passwordHash]
    );

    // Usuario admin (por compatibilidad, con la misma clave)
    await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol, activo)
       VALUES ('admin', 'admin@fundacionsoy.org', $1, 'admin', TRUE)
       ON CONFLICT (email) DO UPDATE SET password_hash = $1, activo = TRUE`,
      [passwordHash]
    );
    console.log('✓ Usuarios fundacionsoy y admin configurados correctamente con clave fundacionsoy123.');
  } catch (err) {
    console.error('Error al configurar usuarios:', err.message || err);
  }

  // 3. Limpieza de datos de prueba para la reunión con el cliente
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_resets (
        id TEXT PRIMARY KEY,
        ejecutado_en TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const resetCheck = await pool.query(
      "SELECT 1 FROM system_resets WHERE id = 'reset_reunion_cliente_20260921_definitivo'"
    );
    if (resetCheck.rows.length === 0) {
      console.log('Limpiando base de datos de prueba para la reunión...');
      await pool.query(`
        TRUNCATE TABLE facturas, caja_movimientos, ingresos_financieros_mp, donaciones, raw_imports, egresos, donantes RESTART IDENTITY CASCADE;
      `);
      await pool.query(
        "INSERT INTO system_resets (id) VALUES ('reset_reunion_cliente_20260921_definitivo') ON CONFLICT DO NOTHING;"
      );
      console.log('✓ Base de datos vaciada exitosamente para la reunión.');
    }
  } catch (err) {
    console.error('Error al vaciar base de datos de prueba:', err.message || err);
  }
}

app.listen(PORT, async () => {
  console.log(`Fundacion Soy — sistema corriendo en http://localhost:${PORT}`);
  await inicializarBaseDeDatos();
});
