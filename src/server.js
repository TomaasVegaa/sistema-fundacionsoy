const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const app = require('./app');
const pool = require('./db/pool');

const PORT = process.env.PORT || 3000;

async function inicializarBaseDeDatos() {
  try {
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      console.log('✓ Esquema de base de datos verificado.');

      // Crear o actualizar usuario fundacionsoy con contraseña fundacionsoy123
      const passwordHash = await bcrypt.hash('fundacionsoy123', 12);
      await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, rol)
         VALUES ('fundacionsoy', 'fundacionsoy@fundacionsoy.org', $1, 'admin')
         ON CONFLICT (email) DO UPDATE SET password_hash = $1, nombre = 'fundacionsoy'`,
        [passwordHash]
      );
      console.log('✓ Usuario fundacionsoy configurado: fundacionsoy / fundacionsoy123');

      // Tabla para registrar operaciones únicas del sistema
      await pool.query(`
        CREATE TABLE IF NOT EXISTS system_resets (
          id TEXT PRIMARY KEY,
          ejecutado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      // Limpieza de datos de prueba para la reunión con el cliente
      const resetCheck = await pool.query(
        "SELECT 1 FROM system_resets WHERE id = 'reset_reunion_cliente_20260921'"
      );
      if (resetCheck.rows.length === 0) {
        console.log('Limpiando base de datos de prueba para reunión...');
        await pool.query(`
          TRUNCATE TABLE facturas, caja_movimientos, ingresos_financieros_mp, donaciones, raw_imports, egresos, donantes RESTART IDENTITY CASCADE;
          INSERT INTO system_resets (id) VALUES ('reset_reunion_cliente_20260921');
        `);
        console.log('✓ Base de datos vaciada exitosamente para la reunión.');
      }
    }
  } catch (err) {
    console.error('Aviso al verificar base de datos al inicio:', err.message || err);
  }
}

app.listen(PORT, async () => {
  console.log(`Fundacion Soy — sistema corriendo en http://localhost:${PORT}`);
  await inicializarBaseDeDatos();
});
