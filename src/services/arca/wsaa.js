// WSAA: Web Service de Autenticacion y Autorizacion de ARCA (ex AFIP).
// Genera un TRA, lo firma con el certificado/clave de la fundacion (CMS)
// y obtiene Token + Sign. Se cachean en memoria porque son validos ~12hs.
//
// En ambiente 'mock' nunca se llama de verdad a ARCA: se devuelve un token
// simulado, para poder desarrollar y probar el resto del sistema sin
// certificado real todavia (pendiente, ver brief seccion 6).

const fs = require('fs');
const forge = require('node-forge');

const WSDL_URLS = {
  homologacion: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  produccion: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
};

let cache = null; // { token, sign, expiraEn }

function tokenVigente() {
  return cache && cache.expiraEn > Date.now();
}

function generarTRA(servicio = 'wsfe') {
  const ahora = new Date();
  const generacion = new Date(ahora.getTime() - 60 * 1000);
  const expiracion = new Date(ahora.getTime() + 11 * 60 * 60 * 1000); // ~11hs, margen contra el limite de 12hs
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

function firmarCMS(traXml, certPath, keyPath) {
  const certPem = fs.readFileSync(certPath, 'utf8');
  const keyPem = fs.readFileSync(keyPath, 'utf8');

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
 * @param {object} config - fila de configuracion_arca (ambiente, certificado_path, clave_privada_path)
 */
async function obtenerTokenSign(config) {
  if (tokenVigente()) return { token: cache.token, sign: cache.sign };

  if (config.ambiente === 'mock') {
    cache = {
      token: 'MOCK-TOKEN-' + Date.now(),
      sign: 'MOCK-SIGN-' + Date.now(),
      expiraEn: Date.now() + 11 * 60 * 60 * 1000,
    };
    return { token: cache.token, sign: cache.sign };
  }

  // --- Fase 2/3: llamada real a ARCA ---
  // Se deja el flujo completo armado para cuando haya certificado real.
  // Requiere agregar un cliente SOAP (ej. 'soap' o 'strong-soap') apuntando
  // a WSDL_URLS[config.ambiente], enviando el CMS firmado como parametro
  // 'in0' del metodo loginCms, y parseando <token>/<sign> de la respuesta.
  const cmsFirmado = firmarCMS(generarTRA('wsfe'), config.certificado_path, config.clave_privada_path);

  throw new Error(
    `Llamada real a WSAA (${config.ambiente}) todavia no esta implementada. ` +
    `El CMS se genero correctamente (${cmsFirmado.length} bytes en base64); ` +
    'falta conectar el cliente SOAP contra ' + WSDL_URLS[config.ambiente] + '.'
  );
}

module.exports = { obtenerTokenSign, generarTRA, firmarCMS, WSDL_URLS };
