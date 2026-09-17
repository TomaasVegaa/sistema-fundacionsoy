const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const POR_PAGINA = 50;

router.get('/', async (req, res) => {
  const { desde, hasta, tipo } = req.query;
  const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
  const offset = (pagina - 1) * POR_PAGINA;

  const condiciones = [];
  const valores = [];

  if (desde) { valores.push(desde); condiciones.push(`fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`fecha <= $${valores.length}`); }
  if (tipo) { valores.push(tipo); condiciones.push(`tipo = $${valores.length}`); }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM caja_movimientos ${where}`,
    valores
  );
  const total = countRows[0].total;
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  const valoresQuery = [...valores, POR_PAGINA, offset];
  const { rows: movimientos } = await pool.query(
    `SELECT * FROM caja_movimientos ${where} ORDER BY fecha DESC, id DESC LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    valoresQuery
  );

  const { rows: totales } = await pool.query(
    `SELECT
       COALESCE(SUM(monto) FILTER (WHERE tipo = 'ingreso'), 0) AS total_ingresos,
       COALESCE(SUM(monto) FILTER (WHERE tipo = 'egreso'), 0) AS total_egresos
     FROM caja_movimientos ${where}`,
    valores
  );

  const { rows: saldoRows } = await pool.query(
    'SELECT saldo_acumulado FROM caja_movimientos ORDER BY id DESC LIMIT 1'
  );

  res.render('caja', {
    movimientos,
    totales: totales[0],
    saldoActual: saldoRows[0] ? saldoRows[0].saldo_acumulado : 0,
    filtros: req.query,
    activeNav: 'caja',
    paginaActual: pagina,
    totalPaginas,
  });
});

module.exports = router;
