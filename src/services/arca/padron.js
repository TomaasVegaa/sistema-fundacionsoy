// Servicio de Consulta al Padrón de ARCA (ws_sr_constancia_inscripcion - personaServiceA5)
// Obtiene automáticamente Razón Social / Nombre y Apellido oficial y Condición frente al IVA.

const wsaa = require('./wsaa');
const { soapPost } = require('./client');

const URLS = {
  homologacion: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
  produccion: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
};

function parsearRespuestaPadron(xmlResp) {
  if (xmlResp.includes('<faultstring>') || xmlResp.includes('&lt;faultstring&gt;')) {
    const faultMatch =
      xmlResp.match(/<faultstring>(.*?)<\/faultstring>/i) ||
      xmlResp.match(/&lt;faultstring&gt;(.*?)&lt;\/faultstring&gt;/i);
    const mensaje = faultMatch ? faultMatch[1] : 'Error en consulta de padrón ARCA';
    throw new Error(mensaje);
  }

  // Extraer nombre o razón social
  let nombre = null;
  const razonSocialMatch = xmlResp.match(/<razonSocial>(.*?)<\/razonSocial>/i);
  if (razonSocialMatch && razonSocialMatch[1].trim()) {
    nombre = razonSocialMatch[1].trim();
  } else {
    const apeMatch = xmlResp.match(/<apellido>(.*?)<\/apellido>/i);
    const nomMatch = xmlResp.match(/<nombre>(.*?)<\/nombre>/i);
    const ape = apeMatch ? apeMatch[1].trim() : '';
    const nom = nomMatch ? nomMatch[1].trim() : '';
    if (ape || nom) {
      nombre = `${ape} ${nom}`.trim();
    }
  }

  // Tipo de persona (FISICA / JURIDICA)
  const tipoPersonaMatch = xmlResp.match(/<tipoPersona>(.*?)<\/tipoPersona>/i);
  const tipoPersona = tipoPersonaMatch ? tipoPersonaMatch[1].trim().toUpperCase() : null;

  // Estado de la clave (ACTIVO / etc.)
  const estadoClaveMatch = xmlResp.match(/<estadoClave>(.*?)<\/estadoClave>/i);
  const estadoClave = estadoClaveMatch ? estadoClaveMatch[1].trim() : null;

  // Domicilio fiscal
  let domicilio = null;
  const dirMatch = xmlResp.match(/<direccion>(.*?)<\/direccion>/i);
  const locMatch = xmlResp.match(/<localidad>(.*?)<\/localidad>/i);
  const provMatch = xmlResp.match(/<descripcionProvincia>(.*?)<\/descripcionProvincia>/i);
  if (dirMatch) {
    const partes = [dirMatch[1].trim(), locMatch ? locMatch[1].trim() : '', provMatch ? provMatch[1].trim() : ''];
    domicilio = partes.filter(Boolean).join(', ');
  }

  // Determinar condición frente al IVA mediante impuestos activos
  let condicionIva = 'consumidor_final';

  // Buscar bloques de impuestos: <idImpuesto>30</idImpuesto> (IVA RI) o 32 (IVA Exento)
  // Chequeamos si el impuesto está activo (estadoImpuesto: AC)
  const bloquesImpuestos = xmlResp.match(/<impuesto>[\s\S]*?<\/impuesto>/gi) || [];
  let tieneIvaRi = false;
  let tieneIvaExento = false;

  for (const b of bloquesImpuestos) {
    const idMatch = b.match(/<idImpuesto>(\d+)<\/idImpuesto>/i);
    const estMatch = b.match(/<estadoImpuesto>([A-Z]+)<\/estadoImpuesto>/i);
    const id = idMatch ? parseInt(idMatch[1], 10) : null;
    const est = estMatch ? estMatch[1] : '';

    if (id === 30 && est === 'AC') tieneIvaRi = true;
    if (id === 32 && est === 'AC') tieneIvaExento = true;
  }

  // Monotributo
  const esMonotributo =
    xmlResp.includes('<datosMonotributo>') ||
    xmlResp.includes('<categoriaMonotributo>') ||
    bloquesImpuestos.some((b) => b.includes('<idImpuesto>20</idImpuesto>') && b.includes('<estadoImpuesto>AC</estadoImpuesto>'));

  if (tieneIvaRi) {
    condicionIva = 'responsable_inscripto';
  } else if (tieneIvaExento) {
    condicionIva = 'iva_exento';
  } else if (esMonotributo) {
    condicionIva = 'monotributo';
  } else if (tipoPersona === 'JURIDICA') {
    condicionIva = 'responsable_inscripto'; // Las personas jurídicas son por defecto RI si no son exentas
  }

  return {
    nombre,
    tipoPersona,
    estadoClave,
    domicilio,
    condicion_iva: condicionIva,
  };
}

/**
 * Consulta los datos de un CUIT en el Padrón de ARCA (ws_sr_constancia_inscripcion).
 * Devuelve Razón Social oficial y Condición frente al IVA.
 *
 * @param {string|number} cuitConsultar
 * @param {object} config - fila de configuracion_arca
 * @returns {Promise<{ ok: boolean, nombre?: string, condicion_iva?: string, domicilio?: string, error?: string }>}
 */
async function consultarDatosPadron(cuitConsultar, config) {
  const cuitClean = String(cuitConsultar || '').replace(/[-\s]/g, '');
  if (!cuitClean || cuitClean.length !== 11) {
    return { ok: false, error: 'CUIT inválido (debe tener 11 dígitos).' };
  }

  const ambiente = config.ambiente || 'produccion';
  if (ambiente === 'mock') {
    return {
      ok: true,
      cuit: cuitClean,
      nombre: 'DONANTE MOCK S.A.',
      tipoPersona: 'JURIDICA',
      condicion_iva: 'responsable_inscripto',
      domicilio: 'Calle Falsa 123, Tucumán',
    };
  }

  const padronUrl = URLS[ambiente] || URLS.produccion;
  const cuitEmisor = String(config.cuit_emisor || '30719160162').replace(/[-\s]/g, '');

  try {
    const auth = await wsaa.obtenerTokenSign(config, 'ws_sr_constancia_inscripcion');

    const soapReq = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona>
      <token>${auth.token}</token>
      <sign>${auth.sign}</sign>
      <cuitRepresentada>${cuitEmisor}</cuitRepresentada>
      <idPersona>${cuitClean}</idPersona>
    </a5:getPersona>
  </soapenv:Body>
</soapenv:Envelope>`;

    const resp = await soapPost(
      padronUrl,
      {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': '',
      },
      soapReq
    );

    const xmlResp = await resp.text();
    const datos = parsearRespuestaPadron(xmlResp);

    return {
      ok: true,
      cuit: cuitClean,
      ...datos,
    };
  } catch (err) {
    // Si falla la consulta a ARCA, aplicamos heurística por CUIT para no fallar
    const esEmpresa = cuitClean.startsWith('30') || cuitClean.startsWith('33') || cuitClean.startsWith('34');
    return {
      ok: false,
      cuit: cuitClean,
      error: err.message,
      condicion_iva_fallback: esEmpresa ? 'responsable_inscripto' : 'consumidor_final',
    };
  }
}

module.exports = { consultarDatosPadron, parsearRespuestaPadron };
