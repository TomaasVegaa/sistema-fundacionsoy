// Cliente HTTP/SOAP seguro y especializado para servicios de ARCA (ex AFIP).
//
// PROBLEMA EN CLOUD / LINUX (Render / Docker / OpenSSL 3):
// Los servidores de AFIP utilizan configuraciones TLS heredadas (ciphers antiguos
// y legacy renegotiation). Node.js 18+ en Linux con OpenSSL 3 por defecto rechaza
// estas conexiones con "unsafe legacy renegotiation disabled" o "fetch failed".
//
// SOLUCIÓN:
// Este cliente configura un https.Agent nativo con:
// - SSL_OP_LEGACY_SERVER_CONNECT
// - ciphers: 'DEFAULT@SECLEVEL=0'
// - family: 4 (fuerza IPv4 para evitar timeouts de IPv6 en cloud containers)
// - Timeout controlado y mensajes de error amigables.

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const afipAgent = new https.Agent({
  keepAlive: true,
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
  ciphers: 'DEFAULT@SECLEVEL=0',
  minVersion: 'TLSv1',
  family: 4,
});

/**
 * Realiza una petición POST SOAP a los servidores de ARCA.
 * @param {string} urlStr
 * @param {object} headers
 * @param {string} body
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<{ ok: boolean, status: number, text: () => Promise<string> }>}
 */
function soapPost(urlStr, headers, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`URL de ARCA inválida: ${urlStr}`));
    }

    const bodyBuffer = Buffer.from(body, 'utf8');

    const req = https.request(
      url,
      {
        method: 'POST',
        agent: afipAgent,
        headers: {
          ...headers,
          'Content-Length': bodyBuffer.length,
          'User-Agent': 'FundacionSoy-Sistema/1.0 (Node.js)',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let responseData = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => responseData,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s) al conectar con ARCA (${url.hostname})`));
    });

    req.on('error', (err) => {
      const detalle = err.code ? `[${err.code}] ${err.message}` : err.message;
      reject(new Error(`Error de comunicación con ARCA (${url.hostname}): ${detalle}`));
    });

    req.write(bodyBuffer);
    req.end();
  });
}

module.exports = { soapPost, afipAgent };
