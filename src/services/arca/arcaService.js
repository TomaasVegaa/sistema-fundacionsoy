const wsaa = require('./wsaa');
const wsfe = require('./wsfe');

/**
 * Emite una Factura C para una donacion, contra el ambiente configurado
 * (mock / homologacion / produccion).
 *
 * @param {object} config fila de configuracion_arca
 * @param {object} donacion { monto, pagador_cuit_dni, fecha }
 * @param {object} [donante] fila de la tabla donantes { cuit_dni, condicion_iva, nombre }
 */
async function emitirFacturaC(config, donacion, donante = null) {
  const { ambiente } = config;

  const auth = await wsaa.obtenerTokenSign(config);

  const docOriginal = (donacion && donacion.pagador_cuit_dni) || (donante && donante.cuit_dni);
  const tieneDocumento = !!docOriginal;
  let docTipo = 99; // 99 = Consumidor Final sin identificar
  let docNro = 0;

  if (tieneDocumento) {
    const docClean = String(docOriginal).replace(/[-\s]/g, '');
    if (docClean.length === 11) {
      docTipo = 80; // CUIT
      docNro = docClean;
    } else if (docClean.length >= 7 && docClean.length <= 8) {
      docTipo = 96; // DNI
      docNro = docClean;
    } else if (docClean.length > 0) {
      docTipo = 80;
      docNro = docClean;
    }
  }

  const emisor = {
    cuit: config.cuit_emisor || '30719160162',
    puntoVenta: config.punto_venta || 2,
    cbteTipo: config.cbte_tipo_default || 11,
  };

  const comprobante = {
    monto: donacion.monto,
    docTipo,
    docNro,
    fecha: donacion.fecha,
  };

  const resultado = await wsfe.solicitarCAE({ ambiente, auth, emisor, comprobante });

  return {
    ambiente,
    cbte_tipo: emisor.cbteTipo,
    punto_venta: emisor.puntoVenta,
    numero_comprobante: resultado.numero_comprobante,
    numero_formateado: resultado.numero_formateado,
    cae: resultado.cae,
    vencimiento_cae: resultado.vencimiento_cae,
  };
}

module.exports = { emitirFacturaC };
