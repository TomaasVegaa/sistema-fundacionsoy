const express = require('express');
const multer = require('multer');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const pool = require('../db/pool');
const { parsearArchivoMP } = require('../services/parserMP');
const { procesarDonacion, procesarLotePendiente } = require('../services/facturacion');
const { registrarIngresoFinanciero } = require('../services/caja');
const { generarFacturaPDF } = require('../services/pdfFactura');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const POR_PAGINA = 50;

router.get('/', async (req, res) => {
  const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
  const offset = (pagina - 1) * POR_PAGINA;

  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS total FROM donaciones');
  const total = countRows[0].total;
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  const { rows } = await pool.query(
    `SELECT d.*, don.nombre AS donante_nombre, don.email AS donante_email,
            f.pdf_url,
            (SELECT error_detalle FROM facturas WHERE donacion_id = d.id ORDER BY id DESC LIMIT 1) AS error_detalle
     FROM donaciones d
     LEFT JOIN donantes don ON don.id = d.donante_id
     LEFT JOIN facturas f ON f.id = d.factura_id
     ORDER BY d.fecha DESC, d.id DESC
     LIMIT $1 OFFSET $2`,
    [POR_PAGINA, offset]
  );
  res.render('donaciones/lista', {
    donaciones: rows,
    activeNav: 'donaciones',
    paginaActual: pagina,
    totalPaginas,
    filtros: req.query,
  });
});

router.get('/importar', (req, res) => {
  res.render('donaciones/importar', { resumen: null, activeNav: 'donaciones' });
});

router.post('/importar', upload.single('archivo'), async (req, res, next) => {
  try {
    if (!req.file) return res.redirect('/donaciones/importar');

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const formato = ext === 'pdf' ? 'pdf' : ext === 'xlsx' || ext === 'xls' ? 'xlsx' : 'csv';
    const { filas, rendimientos, invalidas } = await parsearArchivoMP(req.file.buffer, formato);

    const client = await pool.connect();
    let duplicadas = 0;
    let importadas = 0;
    let recurrentesDetectadas = 0;

    try {
      await client.query('BEGIN');

      const rawImport = await client.query(
        `INSERT INTO raw_imports (nombre_archivo, formato, contenido_crudo, filas_totales)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.file.originalname, formato, req.file.buffer.toString('base64'), filas.length]
      );
      const rawImportId = rawImport.rows[0].id;

      for (const fila of filas) {
        const existe = await client.query(
          'SELECT id FROM donaciones WHERE referencia_mp = $1',
          [fila.referencia_mp]
        );
        if (existe.rows.length > 0) {
          duplicadas += 1;
          // eslint-disable-next-line no-continue
          continue;
        }

        let donanteId = null;
        if (fila.pagador_email || fila.pagador_cuit_dni || fila.pagador_nombre) {
          const previo = await client.query(
            `SELECT id, es_recurrente FROM donantes
             WHERE (email IS NOT NULL AND email = $1)
                OR (cuit_dni IS NOT NULL AND cuit_dni = $2)
                OR (nombre IS NOT NULL AND nombre = $3 AND $3 IS NOT NULL)
             LIMIT 1`,
            [fila.pagador_email, fila.pagador_cuit_dni, fila.pagador_nombre]
          );

          if (previo.rows.length > 0) {
            donanteId = previo.rows[0].id;
            if (!previo.rows[0].es_recurrente) {
              await client.query('UPDATE donantes SET es_recurrente = TRUE WHERE id = $1', [donanteId]);
            }
            recurrentesDetectadas += 1;
            fila.tipo = 'donacion_recurrente';
          } else {
            const nuevoDonante = await client.query(
              `INSERT INTO donantes (nombre, cuit_dni, email) VALUES ($1,$2,$3) RETURNING id`,
              [fila.pagador_nombre, fila.pagador_cuit_dni, fila.pagador_email]
            );
            donanteId = nuevoDonante.rows[0].id;
          }
        }

        await client.query(
          `INSERT INTO donaciones (donante_id, fecha, monto, referencia_mp, tipo, estado_origen, raw_import_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            donanteId,
            dayjs(fila.fecha).format('YYYY-MM-DD'),
            fila.monto,
            fila.referencia_mp,
            fila.tipo,
            fila.estado_origen,
            rawImportId,
          ]
        );
        importadas += 1;
      }

      // Rendimientos de MP (dinero invertido): no son donaciones, van
      // directo a caja como ingreso financiero, sin donante ni factura.
      for (const r of rendimientos) {
        const rendimiento = await client.query(
          `INSERT INTO ingresos_financieros_mp (fecha, monto, descripcion, raw_import_id)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [dayjs(r.fecha).format('YYYY-MM-DD'), r.monto, r.descripcion, rawImportId]
        );
        await registrarIngresoFinanciero(client, {
          monto: r.monto,
          fecha: dayjs(r.fecha).format('YYYY-MM-DD'),
          referenciaId: rendimiento.rows[0].id,
        });
      }

      await client.query(
        `UPDATE raw_imports SET procesado = TRUE, filas_importadas = $1, filas_duplicadas = $2 WHERE id = $3`,
        [importadas, duplicadas, rawImportId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const clasificadasPorDefecto = filas.filter((f) => f.estado_origen === 'clasificado_por_defecto_revisar').length;

    res.render('donaciones/importar', {
      activeNav: 'donaciones',
      resumen: {
        archivo: req.file.originalname,
        formato,
        totalFilas: filas.length,
        importadas,
        duplicadas,
        recurrentesDetectadas,
        rendimientos: rendimientos.length,
        clasificadasPorDefecto,
        invalidas: invalidas.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/procesar-lote', async (req, res, next) => {
  try {
    const resultado = await procesarLotePendiente();
    res.redirect(
      `/donaciones?procesado=1&total=${resultado.total}&ok=${resultado.exitosas}&error=${resultado.conError}`
    );
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reintentar', async (req, res, next) => {
  try {
    await procesarDonacion(req.params.id);
    res.redirect('/donaciones');
  } catch (err) {
    next(err);
  }
});

// Descargar / Visualizar PDF de factura
router.get('/:id/factura.pdf', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*, d.id as donacion_id, d.monto as donacion_monto, d.tipo as donacion_tipo,
              d.referencia_mp, d.fecha as donacion_fecha, d.donante_id
       FROM facturas f
       JOIN donaciones d ON d.factura_id = f.id
       WHERE d.id = $1 AND f.estado = 'emitida'`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).send('Factura no encontrada o no emitida.');
    }

    const factura = rows[0];
    let donante = null;
    if (factura.donante_id) {
      const dRes = await pool.query('SELECT * FROM donantes WHERE id = $1', [factura.donante_id]);
      donante = dRes.rows[0] || null;
    }

    const cRes = await pool.query('SELECT * FROM configuracion_arca WHERE id = 1');
    const config = cRes.rows[0] || {};

    const donacion = {
      id: factura.donacion_id,
      monto: factura.donacion_monto,
      tipo: factura.donacion_tipo,
      referencia_mp: factura.referencia_mp,
      fecha: factura.donacion_fecha,
    };

    // Regenerar dinámicamente con el diseño mejorado
    const pdfBuffer = await generarFacturaPDF({
      factura,
      donacion,
      donante,
      config,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factura_${factura.numero_comprobante || req.params.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
