const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { registrarEgreso } = require('../services/caja');
const { validar, validarMonto, validarFecha, validarTextoRequerido } = require('../middleware/validators');

const router = express.Router();

const uploadsDir = process.env.UPLOADS_DIR || './uploads';
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

const POR_PAGINA = 50;

router.get('/', async (req, res) => {
  const { categoria, evento_id, desde, hasta } = req.query;
  const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
  const offset = (pagina - 1) * POR_PAGINA;

  const condiciones = [];
  const valores = [];

  if (categoria) { valores.push(categoria); condiciones.push(`eg.categoria = $${valores.length}`); }
  if (evento_id) { valores.push(evento_id); condiciones.push(`eg.evento_id = $${valores.length}`); }
  if (desde) { valores.push(desde); condiciones.push(`eg.fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`eg.fecha <= $${valores.length}`); }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM egresos eg ${where}`,
    valores
  );
  const total = countRows[0].total;
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  const valoresQuery = [...valores, POR_PAGINA, offset];
  const { rows: egresos } = await pool.query(
    `SELECT eg.*, ev.nombre AS evento_nombre
     FROM egresos eg LEFT JOIN eventos ev ON ev.id = eg.evento_id
     ${where} ORDER BY eg.fecha DESC
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    valoresQuery
  );
  const { rows: eventos } = await pool.query('SELECT id, nombre FROM eventos ORDER BY fecha DESC');

  res.render('egresos/lista', {
    egresos,
    eventos,
    filtros: req.query,
    activeNav: 'egresos',
    error: null,
    paginaActual: pagina,
    totalPaginas,
  });
});

router.post('/', upload.single('comprobante'), async (req, res, next) => {
  try {
    const { fecha, concepto, monto, categoria, evento_id } = req.body;

    // Validacion
    const error = validar([
      () => validarFecha(fecha),
      () => validarTextoRequerido(concepto, 'Concepto'),
      () => validarMonto(monto),
    ]);

    if (error) {
      const { rows: eventos } = await pool.query('SELECT id, nombre FROM eventos ORDER BY fecha DESC');
      return res.render('egresos/lista', {
        egresos: [], eventos, filtros: {}, activeNav: 'egresos', error,
        paginaActual: 1, totalPaginas: 1,
      });
    }

    const comprobanteUrl = req.file ? `/uploads/${path.basename(req.file.path)}` : null;

    const { rows } = await pool.query(
      `INSERT INTO egresos (fecha, concepto, monto, categoria, evento_id, comprobante_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [fecha, concepto, monto, categoria || null, evento_id || null, comprobanteUrl]
    );

    await registrarEgreso({ monto, fecha, egresoId: rows[0].id });

    res.redirect('/egresos');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Eliminar movimiento de caja asociado
    await pool.query(
      `DELETE FROM caja_movimientos WHERE referencia_tipo = 'egreso' AND referencia_id = $1`,
      [id]
    );

    // Eliminar egreso
    await pool.query('DELETE FROM egresos WHERE id = $1', [id]);

    // Recalcular saldos acumulados
    await recalcularSaldos();

    res.redirect('/egresos');
  } catch (err) {
    next(err);
  }
});

// Recalcula los saldos acumulados de caja despues de una eliminacion
async function recalcularSaldos() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, tipo, monto FROM caja_movimientos ORDER BY fecha ASC, id ASC'
    );
    let saldo = 0;
    for (const mov of rows) {
      saldo += mov.tipo === 'ingreso' ? Number(mov.monto) : -Number(mov.monto);
      await client.query(
        'UPDATE caja_movimientos SET saldo_acumulado = $1 WHERE id = $2',
        [saldo, mov.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
