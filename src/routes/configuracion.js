const express = require('express');
const pool = require('../db/pool');
const { validar, validarCUIT } = require('../middleware/validators');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM configuracion_arca WHERE id = 1');
  res.render('configuracion', {
    config: rows[0],
    activeNav: 'configuracion',
    error: null,
    guardado: req.query.ok === '1',
    vaciado: req.query.vaciado === '1',
  });
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

router.post('/', async (req, res, next) => {
  try {
    const { punto_venta, cbte_tipo_default, cuit_emisor, ambiente, certificado_path, clave_privada_path } = req.body;

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
      }
    ]);

    if (error) {
      return res.render('configuracion', {
        config: {
          punto_venta,
          cbte_tipo_default,
          cuit_emisor,
          ambiente,
          certificado_path,
          clave_privada_path
        },
        activeNav: 'configuracion',
        error,
        guardado: false
      });
    }

    await pool.query(
      `UPDATE configuracion_arca SET
        punto_venta = $1, cbte_tipo_default = $2, cuit_emisor = $3,
        ambiente = $4, certificado_path = $5, clave_privada_path = $6,
        actualizado_en = now()
       WHERE id = 1`,
      [
        punto_venta || null, cbte_tipo_default || 11, cuit_emisor || null,
        ambiente, certificado_path || null, clave_privada_path || null,
      ]
    );
    res.redirect('/configuracion?ok=1');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
