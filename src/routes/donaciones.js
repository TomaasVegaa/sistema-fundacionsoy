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
const { consultarDatosPadron } = require('../services/arca/padron');

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
    `SELECT d.*, don.nombre AS donante_nombre, don.email AS donante_email, don.cuit_dni AS donante_cuit,
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

      const { rows: cRows } = await client.query('SELECT * FROM configuracion_arca WHERE id = 1');
      const configArca = cRows[0] || {};
      const padronCache = new Map();

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
          const cuitLimpio = fila.pagador_cuit_dni ? String(fila.pagador_cuit_dni).replace(/\D/g, '') : null;
          let condicionIva = 'consumidor_final';
          let datosPadron = null;

          if (cuitLimpio && cuitLimpio.length === 11) {
            if (!padronCache.has(cuitLimpio)) {
              try {
                const resPadron = await consultarDatosPadron(cuitLimpio, configArca);
                padronCache.set(cuitLimpio, resPadron);
              } catch (ePadron) {
                console.warn(`[Padron ARCA] Error consultando CUIT ${cuitLimpio}:`, ePadron.message);
                padronCache.set(cuitLimpio, { ok: false });
              }
            }

            datosPadron = padronCache.get(cuitLimpio);
            if (datosPadron && datosPadron.ok) {
              if (datosPadron.nombre) {
                fila.pagador_nombre = datosPadron.nombre;
              }
              if (datosPadron.condicion_iva) {
                condicionIva = datosPadron.condicion_iva;
              }
            } else if (cuitLimpio.startsWith('30') || cuitLimpio.startsWith('33') || cuitLimpio.startsWith('34')) {
              condicionIva = 'responsable_inscripto';
            }
          }

          const previo = await client.query(
            `SELECT id, es_recurrente, nombre, condicion_iva, cuit_dni FROM donantes
             WHERE (email IS NOT NULL AND email = $1)
                OR (cuit_dni IS NOT NULL AND (cuit_dni = $2 OR regexp_replace(cuit_dni, '\\D', '', 'g') = $3))
                OR (nombre IS NOT NULL AND nombre = $4 AND $4 IS NOT NULL)
             LIMIT 1`,
            [fila.pagador_email, fila.pagador_cuit_dni, cuitLimpio, fila.pagador_nombre]
          );

          if (previo.rows.length > 0) {
            donanteId = previo.rows[0].id;
            const dExistente = previo.rows[0];

            const nombreEsPlaceholder = !dExistente.nombre || dExistente.nombre === 'Transferencia Bancaria' || dExistente.nombre.startsWith('TRANSF:');
            const actualizarNombre = fila.pagador_nombre && (nombreEsPlaceholder || (datosPadron && datosPadron.ok));
            const actualizarCond = condicionIva && (dExistente.condicion_iva === 'consumidor_final' || !dExistente.condicion_iva);
            const actualizarCuit = cuitLimpio && !dExistente.cuit_dni;

            if (actualizarNombre || actualizarCond || actualizarCuit || !dExistente.es_recurrente) {
              await client.query(
                `UPDATE donantes
                 SET nombre = CASE WHEN $1 THEN $2 ELSE nombre END,
                     condicion_iva = CASE WHEN $3 THEN $4 ELSE condicion_iva END,
                     cuit_dni = CASE WHEN $5 THEN $6 ELSE cuit_dni END,
                     es_recurrente = TRUE
                 WHERE id = $7`,
                [
                  Boolean(actualizarNombre), fila.pagador_nombre || dExistente.nombre,
                  Boolean(actualizarCond), condicionIva || dExistente.condicion_iva,
                  Boolean(actualizarCuit), fila.pagador_cuit_dni || dExistente.cuit_dni,
                  donanteId,
                ]
              );
            }
            recurrentesDetectadas += 1;
            fila.tipo = 'donacion_recurrente';
          } else {
            const nuevoDonante = await client.query(
              `INSERT INTO donantes (nombre, cuit_dni, email, condicion_iva)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [fila.pagador_nombre, fila.pagador_cuit_dni, fila.pagador_email, condicionIva]
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
    if (resultado.yaEnProceso) {
      return res.redirect('/donaciones?en_proceso=1');
    }
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

    if (donante && donante.cuit_dni && config && config.ambiente !== 'mock') {
      const cuitClean = String(donante.cuit_dni).replace(/\D/g, '');
      const nombreIncompleto = !donante.nombre || donante.nombre === 'Transferencia Bancaria' || donante.nombre.startsWith('TRANSF:');
      const condIncompleta = !donante.condicion_iva || donante.condicion_iva === 'consumidor_final';

      if (cuitClean.length === 11 && (nombreIncompleto || condIncompleta)) {
        try {
          const resPadron = await consultarDatosPadron(cuitClean, config);
          if (resPadron && resPadron.ok) {
            if (resPadron.nombre && (nombreIncompleto || !donante.nombre)) {
              donante.nombre = resPadron.nombre;
            }
            if (resPadron.condicion_iva) {
              donante.condicion_iva = resPadron.condicion_iva;
            }
            await pool.query(
              'UPDATE donantes SET nombre = $1, condicion_iva = $2 WHERE id = $3',
              [donante.nombre, donante.condicion_iva, donante.id]
            );
          }
        } catch (e) {
          console.warn(`[PDF] No se pudo actualizar datos de padrón para donante ${donante.id}:`, e.message);
        }
      }
    }

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
