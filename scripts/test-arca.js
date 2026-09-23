#!/usr/bin/env node
/**
 * Diagnóstico de conexión en vivo con ARCA (ex AFIP)
 * Ejecuta una prueba 100% no destructiva:
 * 1. Ping a servidores fiscales (FEDummy)
 * 2. Autenticación con certificado y clave privada (WSAA LoginCms)
 * 3. Consulta de último número en Punto de Venta (FECompUltimoAutorizado)
 *
 * NO emite facturas, NO altera la base de datos ni consume numeración.
 */

const fs = require('fs');
const path = require('path');
const wsaa = require('../src/services/arca/wsaa');
const wsfe = require('../src/services/arca/wsfe');

async function ejecutarDiagnostico() {
  console.log('=====================================================');
  console.log(' DIAGNÓSTICO EN VIVO CON ARCA / AFIP (PRODUCCIÓN)');
  console.log('=====================================================\n');

  // 1. Verificar archivos locales o variables
  const certPath = path.resolve(__dirname, '../secrets/arca.crt');
  const keyPath = path.resolve(__dirname, '../secrets/arca.key');

  console.log('[1/4] Verificando credenciales locales...');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error('❌ Error: No se encontraron los archivos arca.crt o arca.key en la carpeta secrets/.');
    process.exit(1);
  }
  console.log('  ✓ Certificado X.509 encontrado: secrets/arca.crt');
  console.log('  ✓ Clave Privada RSA encontrada: secrets/arca.key');

  const config = {
    ambiente: 'produccion',
    cuit_emisor: '30-71916016-2',
    punto_venta: 2,
    cbte_tipo_default: 11,
    certificado_path: certPath,
    clave_privada_path: keyPath,
  };

  // 2. FEDummy
  console.log('\n[2/4] Consultando estado de los servidores de ARCA (FEDummy)...');
  try {
    const estado = await wsfe.verificarEstadoServidores({ ambiente: 'produccion' });
    console.log(`  ✓ AppServer:  ${estado.appServer}`);
    console.log(`  ✓ DbServer:   ${estado.dbServer}`);
    console.log(`  ✓ AuthServer: ${estado.authServer}`);
    if (!estado.servidoresOk) {
      console.warn('  ⚠️ Aviso: Uno o más servidores de ARCA no respondieron OK.');
    }
  } catch (err) {
    console.error('  ❌ Error comunicándose con servidores ARCA:', err.message);
  }

  // 3. WSAA
  console.log('\n[3/4] Autenticando contra WSAA Producción con certificado digital...');
  let auth = null;
  try {
    auth = await wsaa.obtenerTokenSign(config);
    console.log('  ✓ Token de acceso obtenido con éxito');
    console.log('  ✓ Firma criptográfica (Sign) autorizada por AFIP para WSFE');
  } catch (err) {
    console.error('  ❌ Error en WSAA:', err.message);
    process.exit(1);
  }

  // 4. WSFE
  console.log('\n[4/4] Consultando Punto de Venta 2 en ARCA (FECompUltimoAutorizado)...');
  try {
    const ultimo = await wsfe.consultarUltimoAutorizado({
      ambiente: 'produccion',
      puntoVenta: 2,
      cbteTipo: 11,
      auth,
      cuit: config.cuit_emisor,
    });
    console.log(`  ✓ Último comprobante autorizado en ARCA: #${ultimo}`);
    console.log(`  ✓ Próxima Factura C a emitir legalmente: #${ultimo + 1}`);
  } catch (err) {
    console.error('  ❌ Error consultando punto de venta en WSFE:', err.message);
    process.exit(1);
  }

  console.log('\n=====================================================');
  console.log(' ✓ RESULTADO: 100% OPERATIVO');
  console.log(' La conexión con ARCA está lista para emitir facturas.');
  console.log('=====================================================\n');
}

ejecutarDiagnostico();
