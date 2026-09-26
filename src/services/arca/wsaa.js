// WSAA: Web Service de Autenticacion y Autorizacion de ARCA (ex AFIP).
// Genera un TRA, lo firma con el certificado/clave de la fundacion (CMS)
// y obtiene Token + Sign via LoginCms SOAP. Se cachean en memoria (~11hs).

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { soapPost } = require('./client');

const WSDL_URLS = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
};

let cache = null; // { token, sign, expiraEn, ambiente }

function tokenVigente(ambiente) {
  return cache && cache.ambiente === ambiente && cache.expiraEn > Date.now();
}

function generarTRA(servicio = 'wsfe') {
  const ahora = new Date();
  const generacion = new Date(ahora.getTime() - 10 * 60 * 1000); // 10 min antes por desfasaje de reloj
  const expiracion = new Date(ahora.getTime() + 11 * 60 * 60 * 1000); // ~11hs
  const uniqueId = Math.floor(ahora.getTime() / 1000);

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generacion.toISOString()}</generationTime>
    <expirationTime>${expiracion.toISOString()}</expirationTime>
  </header>
  <service>${servicio}</service>
</loginTicketRequest>`;
}

function obtenerPem(origenContent, origenPath, defaultFilenames = []) {
  if (origenContent && typeof origenContent === 'string' && origenContent.trim().length > 0) {
    return origenContent.trim();
  }
  if (origenPath && fs.existsSync(origenPath)) {
    try {
      return fs.readFileSync(origenPath, 'utf8').trim();
    } catch (_) {}
  }
  for (const fn of defaultFilenames) {
    const candidatePath = path.resolve(fn);
    if (fs.existsSync(candidatePath)) {
      try {
        return fs.readFileSync(candidatePath, 'utf8').trim();
      } catch (_) {}
    }
  }
  return null;
}

function firmarCMS(traXml, certPemOrPath, keyPemOrPath) {
  let certPem = certPemOrPath;
  let keyPem = keyPemOrPath;

  if (typeof certPemOrPath === 'string' && fs.existsSync(certPemOrPath)) {
    certPem = fs.readFileSync(certPemOrPath, 'utf8');
  }
  if (typeof keyPemOrPath === 'string' && fs.existsSync(keyPemOrPath)) {
    keyPem = fs.readFileSync(keyPemOrPath, 'utf8');
  }

  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();

  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

/**
 * Devuelve { token, sign }, obteniendolos de ARCA o del cache/mock segun corresponda.
 * @param {object} config - fila de configuracion_arca
 */
async function obtenerTokenSign(config) {
  const ambiente = config.ambiente || 'mock';

  if (tokenVigente(ambiente)) {
    return { token: cache.token, sign: cache.sign };
  }

  if (ambiente === 'mock') {
    cache = {
      token: 'MOCK-TOKEN-' + Date.now(),
      sign: 'MOCK-SIGN-' + Date.now(),
      expiraEn: Date.now() + 11 * 60 * 60 * 1000,
      ambiente: 'mock',
    };
    return { token: cache.token, sign: cache.sign };
  }

  const wsaaUrl = WSDL_URLS[ambiente];
  if (!wsaaUrl) {
    throw new Error(`Ambiente ARCA desconocido: ${ambiente}`);
  }

  // Resolver certificado y clave privada (DB content, file path, defaults o env)
  const certPem =
    obtenerPem(config.certificado_content, config.certificado_path, [
      './secrets/arca.crt',
      path.join(__dirname, '../../../secrets/arca.crt'),
      './SOI_107a354f002de317.crt',
    ]) || process.env.ARCA_CERT;

  const keyPem =
    obtenerPem(config.clave_privada_content, config.clave_privada_path, [
      './secrets/arca.key',
      path.join(__dirname, '../../../secrets/arca.key'),
      './fundacion_soi.key',
    ]) || process.env.ARCA_KEY;

  if (!certPem) {
    throw new Error('No se encontró el certificado digital de ARCA (.crt). Verificá la configuración.');
  }
  if (!keyPem) {
    throw new Error('No se encontró la clave privada de ARCA (.key). Verificá la configuración.');
  }

  const tra = generarTRA('wsfe');
  const cms = firmarCMS(tra, certPem, keyPem);

  const soapReq = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cms}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const resp = await soapPost(
    wsaaUrl,
    {
      'Content-Type': 'text/xml; charset=UTF-8',
      'SOAPAction': '',
    },
    soapReq
  );

  const xmlResp = await resp.text();

  if (!resp.ok && resp.status !== 500) {
    throw new Error(`Error de comunicación con WSAA (${ambiente}): HTTP ${resp.status}`);
  }

  if (xmlResp.includes('<faultstring>') || xmlResp.includes('&lt;faultstring&gt;')) {
    const faultMatch =
      xmlResp.match(/<faultstring>(.*?)<\/faultstring>/i) ||
      xmlResp.match(/&lt;faultstring&gt;(.*?)&lt;\/faultstring&gt;/i);
    const mensaje = faultMatch ? faultMatch[1] : 'Falla SOAP en WSAA';
    throw new Error(`ARCA WSAA error: ${mensaje}`);
  }

  const tokenMatch =
    xmlResp.match(/<token>(.*?)<\/token>/) || xmlResp.match(/&lt;token&gt;(.*?)&lt;\/token&gt;/);
  const signMatch =
    xmlResp.match(/<sign>(.*?)<\/sign>/) || xmlResp.match(/&lt;sign&gt;(.*?)&lt;\/sign&gt;/);

  if (!tokenMatch || !signMatch) {
    throw new Error('Respuesta inesperada de WSAA: no se recibieron Token y Sign.');
  }

  const token = tokenMatch[1];
  const sign = signMatch[1];

  let expiraEn = Date.now() + 11 * 60 * 60 * 1000;
  const expMatch =
    xmlResp.match(/<expirationTime>(.*?)<\/expirationTime>/) ||
    xmlResp.match(/&lt;expirationTime&gt;(.*?)&lt;\/expirationTime&gt;/);
  if (expMatch) {
    const expDate = new Date(expMatch[1]);
    if (!isNaN(expDate.getTime())) {
      expiraEn = expDate.getTime() - 5 * 60 * 1000; // 5 minutos de margen de seguridad
    }
  }

  cache = { token, sign, expiraEn, ambiente };
  return { token, sign };
}

function limpiarCache() {
  cache = null;
}

module.exports = {
  obtenerTokenSign,
  generarTRA,
  firmarCMS,
  limpiarCache,
  WSDL_URLS,
};
