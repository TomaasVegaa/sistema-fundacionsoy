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
    }
  } catch (err) {
    console.error('Aviso al verificar base de datos al inicio:', err.message || err);
  }
}

app.listen(PORT, async () => {
  console.log(`Fundacion Soy — sistema corriendo en http://localhost:${PORT}`);
  await inicializarBaseDeDatos();
});
