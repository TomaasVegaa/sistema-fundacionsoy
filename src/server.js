const fs = require('fs');
const path = require('path');
const tls = require('tls');
const bcrypt = require('bcrypt');
const app = require('./app');
const pool = require('./db/pool');

// Compatibilidad de OpenSSL 3 en Linux (Render) con servidores heredados de ARCA/AFIP
try {
  tls.DEFAULT_CIPHERS = 'DEFAULT@SECLEVEL=0';
} catch (_) {}

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

  // 2b. Migrar columnas y sincronizar credenciales de ARCA
  try {
    await pool.query(`
      ALTER TABLE configuracion_arca ADD COLUMN IF NOT EXISTS certificado_content TEXT;
      ALTER TABLE configuracion_arca ADD COLUMN IF NOT EXISTS clave_privada_content TEXT;
      ALTER TABLE configuracion_arca ADD COLUMN IF NOT EXISTS razon_social TEXT;
      ALTER TABLE configuracion_arca ADD COLUMN IF NOT EXISTS domicilio_comercial TEXT;
    `);

    const secretsDir = path.resolve(__dirname, '../secrets');
    if (!fs.existsSync(secretsDir)) {
      fs.mkdirSync(secretsDir, { recursive: true });
    }

    const certCandidates = [
      path.join(secretsDir, 'arca.crt'),
      path.resolve(__dirname, '../SOI_107a354f002de317.crt'),
    ];
    const keyCandidates = [
      path.join(secretsDir, 'arca.key'),
      path.resolve(__dirname, '../fundacion_soi.key'),
    ];

    let certContent = process.env.ARCA_CERT || null;
    let keyContent = process.env.ARCA_KEY || null;
    for (const p of certCandidates) {
      if (fs.existsSync(p)) {
        certContent = fs.readFileSync(p, 'utf8');
        break;
      }
    }
    for (const p of keyCandidates) {
      if (fs.existsSync(p)) {
        keyContent = fs.readFileSync(p, 'utf8');
        break;
      }
    }

    await pool.query(
      `UPDATE configuracion_arca SET
        cuit_emisor = COALESCE(cuit_emisor, '30-71916016-2'),
        punto_venta = COALESCE(punto_venta, 2),
        razon_social = COALESCE(razon_social, 'FUNDACION SOI (SERVICIO ONCOLOGICO INFANTIL)'),
        domicilio_comercial = COALESCE(domicilio_comercial, 'ASUNCION 731 Piso:1 Dpto:3, San Miguel de Tucumán, Tucumán'),
        certificado_path = COALESCE(certificado_path, './secrets/arca.crt'),
        clave_privada_path = COALESCE(clave_privada_path, './secrets/arca.key'),
        certificado_content = COALESCE($1, certificado_content),
        clave_privada_content = COALESCE($2, clave_privada_content),
        ambiente = CASE WHEN $1 IS NOT NULL OR certificado_content IS NOT NULL THEN 'produccion' ELSE ambiente END
       WHERE id = 1`,
      [certContent, keyContent]
    );

    // Escribir a secrets/ si falta en disco pero existe en la BD
    const { rows: arcaRows } = await pool.query('SELECT certificado_content, clave_privada_content FROM configuracion_arca WHERE id = 1');
    if (arcaRows.length > 0) {
      const row = arcaRows[0];
      const diskCert = path.join(secretsDir, 'arca.crt');
      const diskKey = path.join(secretsDir, 'arca.key');
      if (row.certificado_content && !fs.existsSync(diskCert)) {
        fs.writeFileSync(diskCert, row.certificado_content, 'utf8');
      }
      if (row.clave_privada_content && !fs.existsSync(diskKey)) {
        fs.writeFileSync(diskKey, row.clave_privada_content, 'utf8');
      }
    }

    console.log('✓ Configuración y credenciales de ARCA verificadas y sincronizadas.');
  } catch (err) {
    console.error('Aviso al configurar ARCA:', err.message || err);
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
