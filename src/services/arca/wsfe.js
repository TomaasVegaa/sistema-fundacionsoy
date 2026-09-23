// WSFE: Web Service de Facturacion Electronica de ARCA (ex AFIP).
// Emite Factura C (CbteTipo 11) via FECAESolicitar.
// Cumple con la Resolucion General 5616 (Condicion Frente al IVA del Receptor).

const WSDL_URLS = {
  homologacion: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  produccion: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
};

function pad(n, len) {
  return String(n || 0).padStart(len, '0');
}

function formatDateYYYYMMDD(d) {
  const fecha = d ? new Date(d) : new Date();
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

const contadoresMock = new Map();

/**
 * Consulta el estado de los servidores de ARCA (FEDummy: AppServer, DbServer, AuthServer).
 * No requiere autenticacion previa y no altera ningun dato.
 */
async function verificarEstadoServidores({ ambiente = 'produccion' }) {
  if (ambiente === 'mock') {
    return { appServer: 'OK', dbServer: 'OK', authServer: 'OK', servidoresOk: true, mock: true };
  }

  const wsfeUrl = WSDL_URLS[ambiente] || WSDL_URLS.produccion;
  const soapReq = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FEDummy xmlns="http://ar.gov.afip.dif.FEV1/" />
  </soap:Body>
</soap:Envelope>`;

  const resp = await fetch(wsfeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://ar.gov.afip.dif.FEV1/FEDummy',
    },
    body: soapReq,
  });

  const xmlResp = await resp.text();
  const appMatch = xmlResp.match(/<AppServer>(.*?)<\/AppServer>/);
  const dbMatch = xmlResp.match(/<DbServer>(.*?)<\/DbServer>/);
  const authMatch = xmlResp.match(/<AuthServer>(.*?)<\/AuthServer>/);

  return {
    appServer: appMatch ? appMatch[1] : 'Error',
    dbServer: dbMatch ? dbMatch[1] : 'Error',
    authServer: authMatch ? authMatch[1] : 'Error',
    servidoresOk: (appMatch?.[1] === 'OK') && (dbMatch?.[1] === 'OK') && (authMatch?.[1] === 'OK'),
  };
}

/**
 * Consulta el ultimo comprobante autorizado para el punto de venta y tipo de comprobante.
 */
async function consultarUltimoAutorizado({ ambiente, puntoVenta, cbteTipo, auth, cuit }) {
  if (ambiente === 'mock') {
    const key = `${puntoVenta}-${cbteTipo}`;
    return contadoresMock.get(key) || 0;
  }

  const wsfeUrl = WSDL_URLS[ambiente];
  if (!wsfeUrl) {
    throw new Error(`Ambiente WSFE desconocido: ${ambiente}`);
  }

  const cuitClean = String(cuit || '').replace(/[-\s]/g, '');
  if (!cuitClean) {
    throw new Error('CUIT del emisor no especificado para consultar último comprobante en ARCA.');
  }

  const soapReq = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${auth.token}</Token>
        <Sign>${auth.sign}</Sign>
        <Cuit>${cuitClean}</Cuit>
      </Auth>
      <PtoVta>${puntoVenta}</PtoVta>
      <CbteTipo>${cbteTipo}</CbteTipo>
    </FECompUltimoAutorizado>
  </soap:Body>
</soap:Envelope>`;

  const resp = await fetch(wsfeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado',
    },
    body: soapReq,
  });

  const xmlResp = await resp.text();

  if (xmlResp.includes('<Errors>') || xmlResp.includes('<Err>')) {
    const codeMatch = xmlResp.match(/<Code>(\d+)<\/Code>/);
    const msgMatch = xmlResp.match(/<Msg>(.*?)<\/Msg>/);
    if (codeMatch && msgMatch) {
      throw new Error(`Error ARCA (${codeMatch[1]}): ${msgMatch[1]}`);
    }
  }

  const nroMatch = xmlResp.match(/<CbteNro>(\d+)<\/CbteNro>/);
  if (!nroMatch) {
    throw new Error('Respuesta WSFE inválida: no se encontró CbteNro en FECompUltimoAutorizado.');
  }

  return parseInt(nroMatch[1], 10);
}

/**
 * Solicita el CAE de un comprobante.
 * @param {object} params
 * @param {string} params.ambiente 'mock' | 'homologacion' | 'produccion'
 * @param {object} params.auth { token, sign } obtenidos de WSAA
 * @param {object} params.emisor { cuit, puntoVenta, cbteTipo }
 * @param {object} params.comprobante { monto, docTipo, docNro, concepto, fecha }
 */
async function solicitarCAE({ ambiente, auth, emisor, comprobante }) {
  const cuitClean = String(emisor.cuit || '').replace(/[-\s]/g, '');

  const ultimo = await consultarUltimoAutorizado({
    ambiente,
    puntoVenta: emisor.puntoVenta,
    cbteTipo: emisor.cbteTipo,
    auth,
    cuit: cuitClean,
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

  const wsfeUrl = WSDL_URLS[ambiente];
  if (!wsfeUrl) {
    throw new Error(`Ambiente WSFE desconocido: ${ambiente}`);
  }

  const docTipo = comprobante.docTipo || 99;
  const docNro = comprobante.docNro ? String(comprobante.docNro).replace(/[-\s]/g, '') : '0';
  const cbteFch = formatDateYYYYMMDD(comprobante.fecha || new Date());
  const impTotal = Number(comprobante.monto).toFixed(2);
  const concepto = comprobante.concepto || 1; // 1 = Productos / General

  // Resolucion General 5616: Condicion Frente al IVA del receptor
  // 5: Consumidor Final (DocTipo 99 o 96)
  // 1: IVA Responsable Inscripto (DocTipo 80)
  // 4: IVA Sujeto Exento
  // 6: Responsable Monotributo
  let condicionIvaId = comprobante.condicionIvaId;
  if (!condicionIvaId) {
    if (docTipo === 99 || docTipo === 96) {
      condicionIvaId = 5; // Consumidor Final
    } else if (docTipo === 80) {
      condicionIvaId = 1; // IVA Responsable Inscripto si tiene CUIT
    } else {
      condicionIvaId = 5;
    }
  }

  let fechasServicioXml = '';
  if (concepto === 2 || concepto === 3) {
    // Si es servicio, requiere periodo de servicio y fecha de vencimiento para el pago
    fechasServicioXml = `
      <FchServDesde>${cbteFch}</FchServDesde>
      <FchServHasta>${cbteFch}</FchServHasta>
      <FchVtoPago>${cbteFch}</FchVtoPago>`;
  }

  // Para Factura C (CbteTipo 11):
  // ImpTotal = ImpNeto
  // ImpTotConc = 0, ImpOpEx = 0, ImpTrib = 0, ImpIVA = 0
  // MonId = 'PES', MonCotiz = 1
  const soapReq = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${auth.token}</Token>
        <Sign>${auth.sign}</Sign>
        <Cuit>${cuitClean}</Cuit>
      </Auth>
      <FeCAEReq>
        <FeCabReq>
          <CantReg>1</CantReg>
          <PtoVta>${emisor.puntoVenta}</PtoVta>
          <CbteTipo>${emisor.cbteTipo}</CbteTipo>
        </FeCabReq>
        <FeDetReq>
          <FECAEDetRequest>
            <Concepto>${concepto}</Concepto>
            <DocTipo>${docTipo}</DocTipo>
            <DocNro>${docNro}</DocNro>
            <CbteDesde>${numero}</CbteDesde>
            <CbteHasta>${numero}</CbteHasta>
            <CbteFch>${cbteFch}</CbteFch>
            <ImpTotal>${impTotal}</ImpTotal>
            <ImpTotConc>0</ImpTotConc>
            <ImpNeto>${impTotal}</ImpNeto>
            <ImpOpEx>0</ImpOpEx>
            <ImpTrib>0</ImpTrib>
            <ImpIVA>0</ImpIVA>
            <MonId>PES</MonId>
            <MonCotiz>1</MonCotiz>
            <CondicionIVAReceptorId>${condicionIvaId}</CondicionIVAReceptorId>${fechasServicioXml}
          </FECAEDetRequest>
        </FeDetReq>
      </FeCAEReq>
    </FECAESolicitar>
  </soap:Body>
</soap:Envelope>`;

  const resp = await fetch(wsfeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://ar.gov.afip.dif.FEV1/FECAESolicitar',
    },
    body: soapReq,
  });

  const xmlResp = await resp.text();

  // Parsear resultado de cabecera y detalle
  const resCabMatch = xmlResp.match(/<Resultado>(.*?)<\/Resultado>/);
  const resultado = resCabMatch ? resCabMatch[1] : null;

  // Extraer errores y observaciones si los hay
  const errores = [];
  const errRegex = /<Err>[\s\S]*?<Code>(\d+)<\/Code>[\s\S]*?<Msg>(.*?)<\/Msg>[\s\S]*?<\/Err>/g;
  let match;
  while ((match = errRegex.exec(xmlResp)) !== null) {
    errores.push(`[${match[1]}] ${match[2]}`);
  }

  const obsRegex = /<Obs>[\s\S]*?<(?:Code|Codigo)>(\d+)<\/(?:Code|Codigo)>[\s\S]*?<(?:Msg|Mensaje)>(.*?)<\/(?:Msg|Mensaje)>[\s\S]*?<\/Obs>/g;
  const observaciones = [];
  while ((match = obsRegex.exec(xmlResp)) !== null) {
    observaciones.push(`[${match[1]}] ${match[2]}`);
  }

  if (resultado !== 'A') {
    const errorMsg = errores.length > 0
      ? errores.join(' | ')
      : observaciones.length > 0
        ? observaciones.join(' | ')
        : 'Rechazado por ARCA sin detalle de error.';
    throw new Error(`ARCA rechazó el comprobante: ${errorMsg}`);
  }

  const caeMatch = xmlResp.match(/<CAE>(\d+)<\/CAE>/);
  const vtoMatch = xmlResp.match(/<CAEFchVto>(\d{8})<\/CAEFchVto>/);

  if (!caeMatch) {
    throw new Error('ARCA aprobó el comprobante pero no devolvió el CAE.');
  }

  let vtoFormateado = null;
  if (vtoMatch) {
    const raw = vtoMatch[1];
    vtoFormateado = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  return {
    ok: true,
    numero_comprobante: numero,
    cae: caeMatch[1],
    vencimiento_cae: vtoFormateado,
    numero_formateado: `${pad(emisor.puntoVenta, 5)}-${pad(numero, 8)}`,
    observaciones,
  };
}

module.exports = { solicitarCAE, consultarUltimoAutorizado, verificarEstadoServidores, WSDL_URLS };
