const wsaa = require('./wsaa');
const wsfe = require('./wsfe');

/**
 * Emite una Factura C para una donacion, contra el ambiente configurado
 * (mock / homologacion / produccion). No conoce nada del origen de la
 * donacion (archivo o, a futuro, webhook) — solo recibe los datos ya
 * normalizados que necesita para facturar.
 *
 * @param {object} config fila de configuracion_arca
 * @param {object} donacion { monto, pagador_cuit_dni }
 */
async function emitirFacturaC(config, donacion) {
  const { ambiente } = config;

  const auth = await wsaa.obtenerTokenSign(config);

  const tieneDocumento = !!donacion.pagador_cuit_dni;
  const emisor = {
    cuit: config.cuit_emisor,
    puntoVenta: config.punto_venta,
    cbteTipo: config.cbte_tipo_default || 11,
  };
  const comprobante = {
    monto: donacion.monto,
    docTipo: tieneDocumento ? 80 : 99, // 80 = CUIT, 99 = Consumidor Final sin identificar
    docNro: tieneDocumento ? donacion.pagador_cuit_dni : 0,
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
