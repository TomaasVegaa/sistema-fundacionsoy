const express = require('express');
const pool = require('../db/pool');
const { validar, validarTextoRequerido } = require('../middleware/validators');

const router = express.Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.*,
       COALESCE(SUM(eg.monto), 0) AS total_egresos
     FROM eventos e
     LEFT JOIN egresos eg ON eg.evento_id = e.id
     GROUP BY e.id
     ORDER BY e.fecha DESC NULLS LAST`
  );
  res.render('eventos/lista', { eventos: rows, activeNav: 'eventos', error: null });
});

router.post('/', async (req, res, next) => {
  try {
    const { nombre, fecha, descripcion } = req.body;

    const error = validar([
      () => validarTextoRequerido(nombre, 'Nombre'),
    ]);

    if (error) {
      const { rows } = await pool.query(
        `SELECT e.*, COALESCE(SUM(eg.monto), 0) AS total_egresos
         FROM eventos e LEFT JOIN egresos eg ON eg.evento_id = e.id
         GROUP BY e.id ORDER BY e.fecha DESC NULLS LAST`
      );
      return res.render('eventos/lista', { eventos: rows, activeNav: 'eventos', error });
    }

    await pool.query(
      'INSERT INTO eventos (nombre, fecha, descripcion) VALUES ($1,$2,$3)',
      [nombre, fecha || null, descripcion || null]
    );
    res.redirect('/eventos');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/eliminar', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verificar que no tenga egresos asociados
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM egresos WHERE evento_id = $1',
      [id]
    );

    if (rows[0].total > 0) {
      const { rows: eventos } = await pool.query(
        `SELECT e.*, COALESCE(SUM(eg.monto), 0) AS total_egresos
         FROM eventos e LEFT JOIN egresos eg ON eg.evento_id = e.id
         GROUP BY e.id ORDER BY e.fecha DESC NULLS LAST`
      );
      return res.render('eventos/lista', {
        eventos,
        activeNav: 'eventos',
        error: `No se puede eliminar: el evento tiene ${rows[0].total} egreso(s) asociado(s). Eliminá primero los egresos.`,
      });
    }

    await pool.query('DELETE FROM eventos WHERE id = $1', [id]);
    res.redirect('/eventos');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
