// Genera un PDF de Factura C con todos los datos fiscales obligatorios.
// Incluye: datos del emisor, tipo de comprobante, datos del receptor,
// detalle, totales, CAE, fecha vencimiento CAE, y codigo QR fiscal.

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const TIPO_COMPROBANTE = {
  1: 'A', 2: 'A', 3: 'A', 6: 'B', 7: 'B', 8: 'B', 11: 'C', 12: 'C', 13: 'C',
};

function pad(n, len) {
  return String(n || 0).padStart(len, '0');
}

function formatMoney(n) {
  return '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '—';
  const fecha = new Date(d);
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatDateYYYYMMDD(d) {
  if (!d) return '';
  const fecha = new Date(d);
  const dd = String(fecha.getDate()).padStart(2, '0');
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const yyyy = fecha.getFullYear();
  return `${yyyy}${mm}${dd}`;
}

const CONDICION_IVA_MAP = {
  consumidor_final: 'Consumidor Final',
  iva_exento: 'IVA Exento',
  exento: 'IVA Exento',
  responsable_inscripto: 'IVA Responsable Inscripto',
  monotributo: 'Responsable Monotributo',
  no_responsable: 'No Responsable',
};

function formatCondicionIva(c) {
  if (!c) return 'Consumidor Final';
  const k = String(c).toLowerCase().trim();
  return CONDICION_IVA_MAP[k] || c;
}

function formatCuitDni(doc) {
  if (!doc) return 'Sin identificar (Consumidor Final)';
  const s = String(doc).replace(/\D/g, '');
  if (s.length === 11) {
    return `CUIT: ${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}`;
  }
  if (s.length === 8 || s.length === 7) {
    return `DNI: ${s.slice(0, -6)}.${s.slice(-6, -3)}.${s.slice(-3)}`;
  }
  return `Doc: ${doc}`;
}

function formatNombreReceptor(nombre) {
  if (!nombre) return 'Consumidor Final';
  const s = String(nombre).trim();
  if (/^TRANSF:[A-Za-z0-9_-]+$/i.test(s)) {
    return 'Transferencia Bancaria';
  }
  return s;
}

/**
 * Genera el buffer de un PDF de Factura C.
 * @param {object} params
 * @param {object} params.factura - fila de la tabla facturas
 * @param {object} params.donacion - fila de la tabla donaciones
 * @param {object} params.donante - fila de la tabla donantes (puede ser null)
 * @param {object} params.config - fila de configuracion_arca
 * @returns {Promise<Buffer>}
 */
async function generarFacturaPDF({ factura, donacion, donante, config }) {
  const letra = TIPO_COMPROBANTE[factura.cbte_tipo] || 'C';
  const numeroFormateado = `${pad(factura.punto_venta, 5)}-${pad(factura.numero_comprobante, 8)}`;

  // Generar QR fiscal (formato ARCA)
  // URL: https://www.afip.gob.ar/fe/qr/?p=BASE64_JSON
  const qrData = {
    ver: 1,
    fecha: formatDateYYYYMMDD(factura.emitida_en || new Date()),
    cuit: Number(String(config.cuit_emisor || '0').replace(/[-\s]/g, '')),
    ptoVta: factura.punto_venta || 0,
    tipoCmp: factura.cbte_tipo,
    nroCmp: factura.numero_comprobante || 0,
    importe: Number(factura.monto),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: donante && donante.cuit_dni ? 80 : 99,
    nroDocRec: donante && donante.cuit_dni ? Number(String(donante.cuit_dni).replace(/[-\s]/g, '')) : 0,
    tipoCodAut: 'E',
    codAut: Number(factura.cae || 0),
  };

  const qrUrl = 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(qrData)).toString('base64');
  const qrBuffer = await QRCode.toBuffer(qrUrl, { width: 130, margin: 1 });

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const margin = 50;
    const contentW = pageW - margin * 2;
    const centerX = pageW / 2;

    const razonSocial = (config && config.razon_social) || 'FUNDACION SOI (SERVICIO ONCOLOGICO INFANTIL)';
    const cuitEmisor = (config && config.cuit_emisor) || '30-71916016-2';
    const domicilio = (config && config.domicilio_comercial) || 'Asunción 731 Piso 1 Dpto 3 - San Miguel de Tucumán';

    // ============ ENCABEZADO ============

    // Linea superior
    doc.lineWidth(1.5)
       .moveTo(margin, 50).lineTo(pageW - margin, 50).stroke();

    // Letra del comprobante (centro con recuadro)
    doc.lineWidth(1).rect(centerX - 18, 50, 36, 40).stroke();
    doc.fontSize(24).font('Helvetica-Bold')
       .text(letra, centerX - 18, 56, { width: 36, align: 'center' });
    doc.fontSize(7.5).font('Helvetica')
       .text(`COD. ${pad(factura.cbte_tipo, 3)}`, centerX - 30, 93, { width: 60, align: 'center' });

    // Lado izquierdo: datos del emisor
    doc.fontSize(11).font('Helvetica-Bold')
       .text(razonSocial, margin, 58, { width: centerX - margin - 30 });
    doc.fontSize(8.5).font('Helvetica')
       .text(`CUIT: ${cuitEmisor}`, margin, 85)
       .text('Condición frente al IVA: IVA Exento', margin, 97)
       .text(`Domicilio: ${domicilio}`, margin, 109, { width: centerX - margin - 30 });

    // Lado derecho: datos del comprobante
    doc.fontSize(13).font('Helvetica-Bold')
       .text(`FACTURA ${letra}`, pageW - margin - 220, 58, { width: 220, align: 'right' });
    doc.fontSize(9.5).font('Helvetica')
       .text(`Punto de Venta: ${pad(factura.punto_venta, 5)}  Comp. Nro: ${pad(factura.numero_comprobante, 8)}`, pageW - margin - 250, 78, { width: 250, align: 'right' })
       .text(`Fecha de Emisión: ${formatDate(factura.emitida_en || new Date())}`, pageW - margin - 220, 93, { width: 220, align: 'right' })
       .text('Concepto: Aportes y Donaciones', pageW - margin - 220, 108, { width: 220, align: 'right' });

    // Linea separadora
    doc.lineWidth(0.5)
       .moveTo(margin, 138).lineTo(pageW - margin, 138).stroke();

    // ============ DATOS DEL RECEPTOR ============

    let y = 146;
    doc.fontSize(9).font('Helvetica-Bold').text('DATOS DEL RECEPTOR', margin, y);
    y += 16;
    doc.fontSize(9).font('Helvetica');

    const rawNombre = donante ? donante.nombre : null;
    const nombreReceptor = formatNombreReceptor(rawNombre);
    const docReceptor = formatCuitDni(donante ? donante.cuit_dni : null);
    const emailReceptor = donante && donante.email ? donante.email : '';
    const condicionIva = formatCondicionIva(donante ? donante.condicion_iva : 'Consumidor Final');

    // Fila 1: Nombre / Razón Social en su propia línea completa para evitar solapamiento
    doc.font('Helvetica-Bold').text('Nombre / Razón Social: ', margin, y, { continued: true });
    doc.font('Helvetica').text(nombreReceptor, { width: contentW - 130 });
    y += 15;

    // Fila 2: Documento (izquierda) y Condición frente al IVA (derecha)
    const colDerX = margin + contentW * 0.52;
    doc.font('Helvetica-Bold').text('Documento: ', margin, y, { continued: true });
    doc.font('Helvetica').text(docReceptor);

    doc.font('Helvetica-Bold').text('Condición frente al IVA: ', colDerX, y, { continued: true });
    doc.font('Helvetica').text(condicionIva);
    y += 15;

    // Fila 3: Condición de venta (izquierda) y Email (derecha si existe)
    doc.font('Helvetica-Bold').text('Condición de venta: ', margin, y, { continued: true });
    doc.font('Helvetica').text('Contado / Transferencia');

    if (emailReceptor) {
      doc.font('Helvetica-Bold').text('Email: ', colDerX, y, { continued: true });
      doc.font('Helvetica').text(emailReceptor);
    }
    y += 15;

    y += 4;
    doc.lineWidth(0.5)
       .moveTo(margin, y).lineTo(pageW - margin, y).stroke();
    y += 10;

    // ============ DETALLE ============

    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Descripción', margin, y, { width: contentW * 0.65 });
    doc.text('Importe', margin + contentW * 0.65, y, { width: contentW * 0.35, align: 'right' });
    y += 16;
    doc.lineWidth(0.3)
       .moveTo(margin, y).lineTo(pageW - margin, y).stroke();
    y += 8;

    doc.fontSize(9).font('Helvetica');
    const concepto = donacion.tipo === 'donacion_recurrente' ? 'Donación recurrente' : 'Donación';
    const refMP = donacion.referencia_mp ? ` (Ref: ${donacion.referencia_mp})` : '';
    const fechaDon = donacion.fecha ? ` - Fecha: ${formatDate(donacion.fecha)}` : '';
    doc.text(`${concepto}${refMP}${fechaDon}`, margin, y, { width: contentW * 0.65 });
    doc.font('Helvetica-Bold')
       .text(formatMoney(factura.monto), margin + contentW * 0.65, y, { width: contentW * 0.35, align: 'right' });

    y += 30;
    doc.lineWidth(0.5)
       .moveTo(margin, y).lineTo(pageW - margin, y).stroke();
    y += 10;

    // ============ TOTAL ============

    doc.fontSize(12).font('Helvetica-Bold')
       .text('TOTAL', margin, y)
       .text(formatMoney(factura.monto), margin + contentW * 0.4, y, { width: contentW * 0.6, align: 'right' });

    y += 30;
    doc.lineWidth(0.5)
       .moveTo(margin, y).lineTo(pageW - margin, y).stroke();
    y += 15;

    // ============ CAE ============

    doc.fontSize(9).font('Helvetica-Bold')
       .text('CAE:', margin, y);
    doc.font('Helvetica')
       .text(factura.cae || 'Sin CAE', margin + 30, y);

    doc.font('Helvetica-Bold')
       .text('Vto. CAE:', margin + contentW * 0.5, y);
    doc.font('Helvetica')
       .text(formatDate(factura.vencimiento_cae), margin + contentW * 0.5 + 55, y);

    y += 14;
    if (factura.ambiente === 'mock') {
      doc.fontSize(8).fillColor('#8c4636')
         .text('⚠ COMPROBANTE SIMULADO — CAE FICTICIO (modo mock)', margin, y);
      doc.fillColor('#000000');
      y += 14;
    }

    // ============ QR FISCAL ============

    y += 10;
    doc.image(qrBuffer, centerX - 65, y, { width: 130, height: 130 });
    y += 135;
    doc.fontSize(7).font('Helvetica')
       .text('Comprobante autorizado — ARCA (ex-AFIP)', margin, y, { width: contentW, align: 'center' });

    doc.end();
  });
}

module.exports = { generarFacturaPDF };
