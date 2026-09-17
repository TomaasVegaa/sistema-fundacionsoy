const express = require('express');
const dayjs = require('dayjs');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [
      resumenDonaciones,
      resumenEgresos,
      saldo,
      pendientesFactura,
      errores,
      serieMensual,
    ] = await Promise.all([
      pool.query(
        `SELECT
          COALESCE(SUM(monto) FILTER (WHERE estado = 'facturada'), 0) AS total_donado,
          COUNT(*) FILTER (WHERE estado = 'facturada') AS facturas_emitidas,
          COUNT(*) FILTER (WHERE estado = 'pendiente_facturacion') AS facturas_pendientes,
          COUNT(*) FILTER (WHERE estado = 'error_facturacion') AS facturas_error,
          COUNT(DISTINCT donante_id) AS cantidad_donantes
         FROM donaciones`
      ),
      pool.query(`SELECT COALESCE(SUM(monto), 0) AS total_egresos FROM egresos`),
      pool.query(`SELECT saldo_acumulado FROM caja_movimientos ORDER BY id DESC LIMIT 1`),
      pool.query(
        `SELECT d.*, don.nombre AS donante_nombre FROM donaciones d
         LEFT JOIN donantes don ON don.id = d.donante_id
         WHERE d.estado = 'pendiente_facturacion' ORDER BY d.fecha ASC LIMIT 5`
      ),
      pool.query(
        `SELECT d.*, don.nombre AS donante_nombre, f.error_detalle FROM donaciones d
         LEFT JOIN donantes don ON don.id = d.donante_id
         LEFT JOIN facturas f ON f.donacion_id = d.id AND f.estado = 'error'
         WHERE d.estado = 'error_facturacion' ORDER BY d.fecha DESC LIMIT 5`
      ),
      pool.query(
        `SELECT to_char(fecha, 'YYYY-MM') AS mes,
           COALESCE(SUM(monto) FILTER (WHERE tipo = 'ingreso'), 0) AS ingresos,
           COALESCE(SUM(monto) FILTER (WHERE tipo = 'egreso'), 0) AS egresos
         FROM caja_movimientos
         WHERE fecha >= (CURRENT_DATE - INTERVAL '6 months')
         GROUP BY mes ORDER BY mes ASC`
      ),
    ]);

    res.render('dashboard', {
      activeNav: 'dashboard',
      resumen: resumenDonaciones.rows[0],
      totalEgresos: resumenEgresos.rows[0].total_egresos,
      saldoActual: saldo.rows[0] ? saldo.rows[0].saldo_acumulado : 0,
      pendientes: pendientesFactura.rows,
      errores: errores.rows,
      serieMensual: serieMensual.rows,
      dayjs,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
