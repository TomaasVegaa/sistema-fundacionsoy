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

    // ============ ENCABEZADO ============

    // Linea superior
    doc.lineWidth(1.5)
       .moveTo(margin, 50).lineTo(pageW - margin, 50).stroke();

    // Letra del comprobante (centro)
    doc.fontSize(28).font('Helvetica-Bold')
       .text(letra, centerX - 14, 55, { width: 28, align: 'center' });
    doc.fontSize(8).font('Helvetica')
       .text(`COD. ${pad(factura.cbte_tipo, 3)}`, centerX - 30, 85, { width: 60, align: 'center' });

    // Lado izquierdo: datos del emisor
    doc.fontSize(14).font('Helvetica-Bold')
       .text('Fundación Soy', margin, 58);
    doc.fontSize(9).font('Helvetica')
       .text(`CUIT: ${config.cuit_emisor || 'Sin configurar'}`, margin, 78)
       .text('IVA Exento', margin, 90)
       .text(`Punto de Venta: ${pad(factura.punto_venta, 5)}`, margin, 102);

    // Lado derecho: datos del comprobante
    doc.fontSize(12).font('Helvetica-Bold')
       .text(`FACTURA ${letra}`, pageW - margin - 200, 58, { width: 200, align: 'right' });
    doc.fontSize(10).font('Helvetica')
       .text(`Nro: ${numeroFormateado}`, pageW - margin - 200, 78, { width: 200, align: 'right' })
       .text(`Fecha: ${formatDate(factura.emitida_en || new Date())}`, pageW - margin - 200, 93, { width: 200, align: 'right' });

    // Linea separadora
    doc.lineWidth(0.5)
       .moveTo(margin, 120).lineTo(pageW - margin, 120).stroke();

    // ============ DATOS DEL RECEPTOR ============

    let y = 130;
    doc.fontSize(9).font('Helvetica-Bold').text('DATOS DEL RECEPTOR', margin, y);
    y += 16;
    doc.fontSize(9).font('Helvetica');

    const nombreReceptor = donante ? donante.nombre || 'Consumidor Final' : 'Consumidor Final';
    const docReceptor = donante && donante.cuit_dni ? `CUIT: ${donante.cuit_dni}` : 'Sin identificar (Consumidor Final)';
    const emailReceptor = donante && donante.email ? donante.email : '';

    doc.text(`Nombre: ${nombreReceptor}`, margin, y);
    doc.text(`Documento: ${docReceptor}`, margin + contentW / 2, y);
    y += 14;
    if (emailReceptor) {
      doc.text(`Email: ${emailReceptor}`, margin, y);
      y += 14;
    }
    doc.text(`Condición IVA: ${donante ? donante.condicion_iva || 'Consumidor Final' : 'Consumidor Final'}`, margin, y);
    y += 14;
    doc.text(`Condición de venta: Contado`, margin, y);

    y += 20;
    doc.lineWidth(0.5)
       .moveTo(margin, y).lineTo(pageW - margin, y).stroke();
    y += 10;

    // ============ DETALLE ============

    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Descripción', margin, y, { width: contentW * 0.55 });
    doc.text('Importe', margin + contentW * 0.55, y, { width: contentW * 0.45, align: 'right' });
    y += 16;
    doc.lineWidth(0.3)
       .moveTo(margin, y).lineTo(pageW - margin, y).stroke();
    y += 8;

    doc.fontSize(9).font('Helvetica');
    const concepto = donacion.tipo === 'donacion_recurrente' ? 'Donación recurrente' : 'Donación';
    const refMP = donacion.referencia_mp ? ` (Ref. MP: ${donacion.referencia_mp})` : '';
    doc.text(`${concepto}${refMP}`, margin, y, { width: contentW * 0.55 });
    doc.font('Helvetica-Bold')
       .text(formatMoney(factura.monto), margin + contentW * 0.55, y, { width: contentW * 0.45, align: 'right' });

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
