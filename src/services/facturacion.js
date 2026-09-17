// Esta es la funcion central que pide el brief (seccion 9): cualquier
// donacion normalizada, sin importar si vino del parser de archivo (Fase 1)
// o de un futuro webhook de Mercado Pago (Fase 2), termina llamando a
// procesarDonacion(). El dia que se agregue el webhook, solo hace falta un
// adaptador de entrada nuevo que llame a esta misma funcion.

const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const arcaService = require('./arca/arcaService');
const { registrarIngreso } = require('./caja');
const { generarFacturaPDF } = require('./pdfFactura');

async function obtenerConfigArca(client) {
  const { rows } = await client.query('SELECT * FROM configuracion_arca WHERE id = 1');
  return rows[0];
}

/**
 * Factura una donacion puntual y, si sale bien, la refleja en caja.
 * Un error de ARCA en esta donacion NUNCA debe tirar abajo el resto del
 * lote: se captura y se deja la donacion en estado 'error_facturacion'.
 */
async function procesarDonacion(donacionId) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM donaciones WHERE id = $1', [donacionId]);
    const donacion = rows[0];
    if (!donacion) throw new Error(`Donacion ${donacionId} no encontrada`);
    if (donacion.estado === 'facturada') return { ok: true, yaFacturada: true };

    const config = await obtenerConfigArca(client);

    try {
      const resultado = await arcaService.emitirFacturaC(config, donacion);

      await client.query('BEGIN');

      const factura = await client.query(
        `INSERT INTO facturas
          (cbte_tipo, punto_venta, numero_comprobante, cae, vencimiento_cae, monto, donacion_id, estado, ambiente, emitida_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'emitida',$8, now())
         RETURNING id`,
        [
          resultado.cbte_tipo, resultado.punto_venta, resultado.numero_comprobante,
          resultado.cae, resultado.vencimiento_cae, donacion.monto, donacion.id, resultado.ambiente,
        ]
      );
      const facturaId = factura.rows[0].id;

      // Obtener donante si existe para incluir en el PDF
      let donante = null;
      if (donacion.donante_id) {
        const { rows: dRows } = await client.query('SELECT * FROM donantes WHERE id = $1', [donacion.donante_id]);
        donante = dRows[0] || null;
      }

      // Generar y almacenar el PDF de la factura
      const facturasDir = process.env.FACTURAS_DIR || path.resolve(__dirname, '../../storage/facturas');
      if (!fs.existsSync(facturasDir)) {
        fs.mkdirSync(facturasDir, { recursive: true });
      }
      const pdfFilePath = path.join(facturasDir, `factura_${facturaId}.pdf`);
      try {
        const pdfBuffer = await generarFacturaPDF({
          factura: {
            id: facturaId,
            cbte_tipo: resultado.cbte_tipo,
            punto_venta: resultado.punto_venta,
            numero_comprobante: resultado.numero_comprobante,
            cae: resultado.cae,
            vencimiento_cae: resultado.vencimiento_cae,
            monto: donacion.monto,
            ambiente: resultado.ambiente,
            emitida_en: new Date()
          },
          donacion,
          donante,
          config
        });
        await fs.promises.writeFile(pdfFilePath, pdfBuffer);
        await client.query('UPDATE facturas SET pdf_url = $1 WHERE id = $2', [pdfFilePath, facturaId]);
      } catch (pdfErr) {
        console.error(`Error generando PDF para factura ${facturaId}:`, pdfErr);
      }

      await client.query(
        `UPDATE donaciones SET estado = 'facturada', factura_id = $1 WHERE id = $2`,
        [facturaId, donacion.id]
      );

      await registrarIngreso(client, {
        monto: donacion.monto,
        fecha: donacion.fecha,
        referencia_tipo: 'donacion',
        referencia_id: donacion.id,
      });

      await client.query('COMMIT');
      return { ok: true, facturaId, cae: resultado.cae };
    } catch (errArca) {
      await client.query('ROLLBACK').catch(() => {});
      await client.query(
        `UPDATE donaciones SET estado = 'error_facturacion' WHERE id = $1`,
        [donacion.id]
      );
      await client.query(
        `INSERT INTO facturas (monto, donacion_id, estado, error_detalle, ambiente)
         VALUES ($1, $2, 'error', $3, $4)`,
        [donacion.monto, donacion.id, errArca.message, config.ambiente]
      );
      return { ok: false, error: errArca.message };
    }
  } finally {
    client.release();
  }
}

/**
 * Procesa un lote completo de donaciones pendientes. Cada una se procesa
 * de forma independiente: un error nunca frena a las demas.
 */
async function procesarLotePendiente() {
  const { rows } = await pool.query(
    `SELECT id FROM donaciones WHERE estado = 'pendiente_facturacion' ORDER BY fecha ASC`
  );

  const resultados = [];
  for (const { id } of rows) {
    // eslint-disable-next-line no-await-in-loop
    const r = await procesarDonacion(id);
    resultados.push({ donacionId: id, ...r });
  }

  return {
    total: resultados.length,
    exitosas: resultados.filter((r) => r.ok).length,
    conError: resultados.filter((r) => !r.ok).length,
    detalle: resultados,
  };
}

module.exports = { procesarDonacion, procesarLotePendiente };
