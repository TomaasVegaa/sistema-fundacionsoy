// WSFE: Web Service de Facturacion Electronica de ARCA.
// Emite Factura C (CbteTipo 11) via FECAESolicitar.
//
// En ambiente 'mock' se simula una respuesta exitosa con un CAE ficticio,
// para poder desarrollar y probar todo el flujo de facturacion + caja
// sin depender del certificado ni del punto de venta real (Fase 1).

const WSDL_URLS = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  produccion: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
};

function pad(n, len) {
  return String(n).padStart(len, '0');
}

/**
 * Consulta el ultimo comprobante autorizado para el punto de venta.
 * En mock, se lleva un contador en memoria por punto de venta.
 */
const contadoresMock = new Map();

async function consultarUltimoAutorizado({ ambiente, puntoVenta, cbteTipo, auth }) {
  if (ambiente === 'mock') {
    const key = `${puntoVenta}-${cbteTipo}`;
    return contadoresMock.get(key) || 0;
  }

  throw new Error(
    `FECompUltimoAutorizado real (${ambiente}) todavia no esta implementado. ` +
    'Falta conectar el cliente SOAP contra ' + WSDL_URLS[ambiente] + ' usando el token/sign de WSAA.'
  );
}

/**
 * Solicita el CAE de un comprobante.
 * @param {object} params
 * @param {string} params.ambiente 'mock' | 'homologacion' | 'produccion'
 * @param {object} params.auth { token, sign } obtenidos de WSAA
 * @param {object} params.emisor { cuit, puntoVenta, cbteTipo }
 * @param {object} params.comprobante { monto, docTipo, docNro, conceptoDesc }
 */
async function solicitarCAE({ ambiente, auth, emisor, comprobante }) {
  const ultimo = await consultarUltimoAutorizado({
    ambiente,
    puntoVenta: emisor.puntoVenta,
    cbteTipo: emisor.cbteTipo,
    auth,
  });
  const numero = ultimo + 1;

  if (ambiente === 'mock') {
    const key = `${emisor.puntoVenta}-${emisor.cbteTipo}`;
    contadoresMock.set(key, numero);

    const vencimiento = new Date();
    vencimiento.setDate(vencimiento.getDate() + 10);

    return {
      ok: true,
      numero_comprobante: numero,
      cae: `MOCK${pad(Date.now() % 100000000, 8)}`,
      vencimiento_cae: vencimiento.toISOString().slice(0, 10),
      numero_formateado: `${pad(emisor.puntoVenta || 0, 5)}-${pad(numero, 8)}`,
    };
  }

  // --- Fase 2/3: llamada real a ARCA ---
  // FECAESolicitar espera un FeCAEReq con FeCabReq (CantReg, PtoVta, CbteTipo)
  // y FeDetReq[] (uno por comprobante: Concepto, DocTipo, DocNro, CbteDesde,
  // CbteHasta, ImpTotal, CondicionIVAReceptorId, etc). La respuesta trae
  // FeCabResp.Resultado ('A'|'R') y, si es 'A', el CAE y su vencimiento.
  throw new Error(
    `FECAESolicitar real (${ambiente}) todavia no esta implementado. ` +
    'Falta conectar el cliente SOAP contra ' + WSDL_URLS[ambiente] + '.'
  );
}

module.exports = { solicitarCAE, consultarUltimoAutorizado, WSDL_URLS };
