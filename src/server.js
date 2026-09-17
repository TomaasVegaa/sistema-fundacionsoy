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

      const userCount = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
      if (userCount.rows[0].total === 0) {
        const passwordHash = await bcrypt.hash('admin123', 12);
        await pool.query(
          `INSERT INTO usuarios (nombre, email, password_hash, rol)
           VALUES ($1, $2, $3, 'admin')
           ON CONFLICT (email) DO NOTHING`,
          ['Administrador', 'admin@fundacionsoy.org', passwordHash]
        );
        console.log('✓ Usuario administrador verificado/creado: admin@fundacionsoy.org / admin123');
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
