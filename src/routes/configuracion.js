const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const forge = require('node-forge');
const pool = require('../db/pool');
const { validar, validarCUIT } = require('../middleware/validators');
const wsaa = require('../services/arca/wsaa');
const wsfe = require('../services/arca/wsfe');
const { limpiarCache } = wsaa;

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
});

function obtenerInfoCertificado(pemContent, filePath) {
  let pem = pemContent;
  if (!pem && filePath && fs.existsSync(filePath)) {
    try {
      pem = fs.readFileSync(filePath, 'utf8');
    } catch (_) {}
  }
  if (!pem) {
    const defaultPath = path.resolve(__dirname, '../../secrets/arca.crt');
    if (fs.existsSync(defaultPath)) {
      try {
        pem = fs.readFileSync(defaultPath, 'utf8');
      } catch (_) {}
    }
  }

  if (!pem) return null;

  try {
    const cert = forge.pki.certificateFromPem(pem);
    const ahora = new Date();
    const vigente = cert.validity.notBefore <= ahora && ahora <= cert.validity.notAfter;
    const diasRestantes = Math.round((cert.validity.notAfter.getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24));

    const getAttr = (attrs, type) => {
      const a = attrs.find((x) => x.type === type || x.name === type || x.shortName === type);
      return a ? a.value : null;
    };

    return {
      vigente,
      diasRestantes,
      validoDesde: cert.validity.notBefore,
      validoHasta: cert.validity.notAfter,
      cn: getAttr(cert.subject.attributes, 'commonName') || 'SOI',
      emisor: getAttr(cert.issuer.attributes, 'commonName') || 'AFIP Computadores',
      serial: cert.serialNumber,
    };
  } catch (err) {
    return { error: 'Error al interpretar el certificado: ' + err.message };
  }
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM configuracion_arca WHERE id = 1');
  const config = rows[0] || {};
  const certInfo = obtenerInfoCertificado(config.certificado_content, config.certificado_path);

  res.render('configuracion', {
    config,
    certInfo,
    testConexion: null,
    activeNav: 'configuracion',
    error: null,
    guardado: req.query.ok === '1',
    vaciado: req.query.vaciado === '1',
  });
});

router.post('/test-conexion', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configuracion_arca WHERE id = 1');
    const config = rows[0] || {};
    const certInfo = obtenerInfoCertificado(config.certificado_content, config.certificado_path);

    // 1. Verificar estado de servidores ARCA (FEDummy)
    let estadoServidores = { appServer: 'Desconocido', dbServer: 'Desconocido', authServer: 'Desconocido', servidoresOk: false };
    try {
      estadoServidores = await wsfe.verificarEstadoServidores({ ambiente: config.ambiente });
    } catch (e) {
      estadoServidores.error = e.message;
    }

    // 2. Probar autenticación WSAA (Token y Firma)
    let auth = null;
    let authError = null;
    try {
      auth = await wsaa.obtenerTokenSign(config);
    } catch (e) {
      authError = e.message;
    }

    // 3. Consultar último comprobante para validar Punto de Venta
    let ultimoAutorizado = null;
    let ptoVtaError = null;
    if (auth) {
      try {
        ultimoAutorizado = await wsfe.consultarUltimoAutorizado({
          ambiente: config.ambiente,
          puntoVenta: config.punto_venta || 2,
          cbteTipo: config.cbte_tipo_default || 11,
          auth,
          cuit: config.cuit_emisor || '30719160162',
        });
      } catch (e) {
        ptoVtaError = e.message;
      }
    }

    const testConexion = {
      ejecutado: true,
      exito: estadoServidores.servidoresOk && !authError && !ptoVtaError,
      ambiente: config.ambiente,
      servidores: estadoServidores,
      authOk: !authError,
      authError,
      puntoVenta: config.punto_venta || 2,
      ultimoAutorizado,
      proximoComprobante: ultimoAutorizado !== null ? ultimoAutorizado + 1 : null,
      ptoVtaError,
      timestamp: new Date(),
    };

    res.render('configuracion', {
      config,
      certInfo,
      testConexion,
      activeNav: 'configuracion',
      error: null,
      guardado: false,
      vaciado: false,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/vaciar-datos', async (req, res, next) => {
  try {
    await pool.query(`
      TRUNCATE TABLE facturas, caja_movimientos, ingresos_financieros_mp, donaciones, raw_imports, egresos, donantes RESTART IDENTITY CASCADE;
    `);
    res.redirect('/configuracion?vaciado=1');
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  upload.fields([
    { name: 'archivo_certificado', maxCount: 1 },
    { name: 'archivo_clave', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const {
        punto_venta,
        cbte_tipo_default,
        cuit_emisor,
        ambiente,
        certificado_path,
        clave_privada_path,
        razon_social,
        domicilio_comercial,
      } = req.body;

      const error = validar([
        () => {
          if (cuit_emisor && cuit_emisor.trim()) {
            return validarCUIT(cuit_emisor.trim());
          }
          return null;
        },
        () => {
          if (punto_venta) {
            const pv = parseInt(punto_venta, 10);
            if (isNaN(pv) || pv < 1 || pv > 99999) return 'El punto de venta debe ser un número entre 1 y 99999.';
          }
          return null;
        },
        () => {
          if (!['mock', 'homologacion', 'produccion'].includes(ambiente)) {
            return 'El ambiente debe ser mock, homologacion o produccion.';
          }
          return null;
        },
      ]);

      if (error) {
        const { rows } = await pool.query('SELECT * FROM configuracion_arca WHERE id = 1');
        const certInfo = obtenerInfoCertificado(rows[0]?.certificado_content, certificado_path);
        return res.render('configuracion', {
          config: {
            punto_venta,
            cbte_tipo_default,
            cuit_emisor,
            ambiente,
            certificado_path,
            clave_privada_path,
            razon_social,
            domicilio_comercial,
          },
          certInfo,
          activeNav: 'configuracion',
          error,
          guardado: false,
        });
      }

      // Si subieron archivos nuevos mediante el formulario:
      let nuevoCertContent = null;
      let nuevaClaveContent = null;

      if (req.files && req.files.archivo_certificado && req.files.archivo_certificado[0]) {
        nuevoCertContent = req.files.archivo_certificado[0].buffer.toString('utf8');
      }
      if (req.files && req.files.archivo_clave && req.files.archivo_clave[0]) {
        nuevaClaveContent = req.files.archivo_clave[0].buffer.toString('utf8');
      }

      // Sincronizar en disco si hay archivos nuevos
      const secretsDir = path.resolve(__dirname, '../../secrets');
      if (!fs.existsSync(secretsDir)) fs.mkdirSync(secretsDir, { recursive: true });

      if (nuevoCertContent) {
        fs.writeFileSync(path.join(secretsDir, 'arca.crt'), nuevoCertContent, 'utf8');
      }
      if (nuevaClaveContent) {
        fs.writeFileSync(path.join(secretsDir, 'arca.key'), nuevaClaveContent, 'utf8');
      }

      await pool.query(
        `UPDATE configuracion_arca SET
          punto_venta = $1,
          cbte_tipo_default = $2,
          cuit_emisor = $3,
          ambiente = $4,
          certificado_path = $5,
          clave_privada_path = $6,
          razon_social = $7,
          domicilio_comercial = $8,
          certificado_content = COALESCE($9, certificado_content),
          clave_privada_content = COALESCE($10, clave_privada_content),
          actualizado_en = now()
         WHERE id = 1`,
        [
          punto_venta || 2,
          cbte_tipo_default || 11,
          cuit_emisor || '30-71916016-2',
          ambiente,
          certificado_path || './secrets/arca.crt',
          clave_privada_path || './secrets/arca.key',
          razon_social || 'FUNDACION SOI (SERVICIO ONCOLOGICO INFANTIL)',
          domicilio_comercial || 'ASUNCION 731 Piso:1 Dpto:3, San Miguel de Tucumán, Tucumán',
          nuevoCertContent,
          nuevaClaveContent,
        ]
      );

      limpiarCache();

      res.redirect('/configuracion?ok=1');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
