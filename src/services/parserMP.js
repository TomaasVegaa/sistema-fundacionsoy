// Normaliza un archivo de Mercado Pago (CSV, XLSX o PDF) a la estructura comun
// que usa el resto del sistema.
//
// El parser de PDF fue calibrado contra un "Resumen de cuenta en pesos" real
// de Mercado Pago (agosto 2026). El formato del PDF es multi-linea:
//   Linea 1: dd-mm-yyyy                   (fecha)
//   Linea 2: Descripcion del movimiento   (puede ocupar 1-3 lineas)
//   Linea N: 12345678$ -1.234,56$ 5.678,90  (ID operacion + valor + saldo)
//
// Cada "bloque" se reconstruye juntando estas lineas antes de clasificar.

const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

// ---- CSV / XLSX ----

function normalizarTexto(t) {
  return String(t || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Elimina tildes y diacríticos
    .replace(/[^a-z0-9\s]/g, ' ')   // Convierte puntuación a espacios
    .replace(/\s+/g, ' ')           // Unifica espacios múltiples
    .trim();
}

const COLUMN_ALIASES = {
  fecha: [
    'fecha de aprobacion',
    'fecha de aprobacion de la operacion',
    'fecha de origen',
    'fecha de creacion',
    'fecha de la operacion',
    'fecha de liquidacion del dinero',
    'fecha de liquidacion',
    'fecha operacion',
    'fecha',
    'date',
    'date_created',
    'date_approved',
    'release_date',
    'creation_date',
  ],
  monto: [
    'valor de la compra',
    'transaction_amount',
    'monto bruto',
    'monto de la operacion',
    'monto total',
    'importe total',
    'monto',
    'amount',
    'importe',
    'valor',
    'total',
    'monto neto de la operacion',
    'net_amount',
  ],
  referencia: [
    'id de operacion en mercado pago',
    'id de la operacion',
    'id de operacion',
    'id operacion',
    'numero de operacion',
    'nro de operacion',
    'nro de referencia',
    'nro. de referencia',
    'nro referencia',
    'nro operacion',
    'payment_id',
    'source_id',
    'external_reference',
    'referencia',
    'operation_id',
    'id',
  ],
  pagador_nombre: [
    'nombre del comprador',
    'nombre de comprador',
    'nombre del pagador',
    'nombre del titular',
    'nombre del donante',
    'nombre y apellido',
    'apellido y nombre',
    'donante',
    'comprador',
    'pagador',
    'titular',
    'payer_name',
    'payer.first_name',
    'payer.last_name',
    'nombre',
    'descripcion',
    'motivo',
    'concepto',
    'reason',
  ],
  pagador_email: [
    'email del comprador',
    'email de comprador',
    'email del pagador',
    'email',
    'correo del comprador',
    'correo',
    'payer_email',
    'payer.email',
  ],
  pagador_cuit_dni: [
    'identificacion del comprador',
    'documento del comprador',
    'cuit del comprador',
    'dni del comprador',
    'cuit',
    'cuil',
    'dni',
    'cuit cuil',
    'payer_identification',
    'payer.identification.number',
    'identificacion',
    'documento',
  ],
  tipo: [
    'tipo de medio de pago',
    'tipo de operacion',
    'medio de pago',
    'tipo',
    'payment_type',
    'operation_type',
    'type',
  ],
  estado_origen: [
    'tipo de operacion',
    'estado de la operacion',
    'estado',
    'status',
    'payment_status',
  ],
};

function encontrarValor(fila, aliases) {
  const headers = Object.keys(fila);
  // Paso 1: Coincidencia exacta con alias normalizado
  for (const a of aliases) {
    const normA = normalizarTexto(a);
    for (const h of headers) {
      if (normalizarTexto(h) === normA && fila[h] != null && String(fila[h]).trim() !== '') {
        return fila[h];
      }
    }
  }
  // Paso 2: Coincidencia por subcadena
  for (const a of aliases) {
    const normA = normalizarTexto(a);
    if (normA.length < 4) continue;
    for (const h of headers) {
      const normH = normalizarTexto(h);
      if (normH.includes(normA) && fila[h] != null && String(fila[h]).trim() !== '') {
        return fila[h];
      }
    }
  }
  return null;
}

function parsearFecha(raw) {
  if (!raw) return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  if (typeof raw === 'number') {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0));
    }
  }
  const s = String(raw).trim();
  const dIso = new Date(s);
  if (!Number.isNaN(dIso.getTime())) return dIso;

  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const [, d, mth, y, h, min, sec] = m;
    return new Date(Date.UTC(Number(y), Number(mth) - 1, Number(d), Number(h || 0), Number(min || 0), Number(sec || 0)));
  }

  return null;
}

function parsearMonto(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isNaN(raw) ? null : raw;
  let s = String(raw).trim().replace(/[\$\s]/g, '');
  if (/\.\d{3},\d{2}$/.test(s) || (s.includes(',') && !s.includes('.'))) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function filaARegistro(fila) {
  const rawFecha = encontrarValor(fila, COLUMN_ALIASES.fecha);
  const rawMonto = encontrarValor(fila, COLUMN_ALIASES.monto);
  const referencia = encontrarValor(fila, COLUMN_ALIASES.referencia);
  const tipoRaw = String(encontrarValor(fila, COLUMN_ALIASES.tipo) || '').toLowerCase();
  const estadoRaw = String(encontrarValor(fila, COLUMN_ALIASES.estado_origen) || 'aprobado');
  let nombreRaw = encontrarValor(fila, COLUMN_ALIASES.pagador_nombre);
  let cuitRaw = encontrarValor(fila, COLUMN_ALIASES.pagador_cuit_dni);

  const conceptoRaw = String(encontrarValor(fila, ['concepto', 'causal', 'descripcion', 'motivo']) || '');

  // Si no hay CUIT en columna separada, buscar CUIT en el concepto (11 dígitos continuos)
  if (!cuitRaw && conceptoRaw) {
    const cuitMatch = conceptoRaw.match(/\b(20|23|24|27|30|33|34)\d{9}\b/);
    if (cuitMatch) cuitRaw = cuitMatch[0];
  }

  // Si el nombre no venía separado pero viene en concepto tipo TRANSF APELLIDO/NOMBRE
  if ((!nombreRaw || nombreRaw === conceptoRaw) && conceptoRaw.startsWith('TRANSF ')) {
    const parts = conceptoRaw.replace('TRANSF ', '').split(/\s+/);
    if (parts.length > 0 && !/^\d+$/.test(parts[0])) {
      nombreRaw = parts[0].replace('/', ' ');
    }
  } else if (conceptoRaw.includes('TEF DATANET PR')) {
    const tefMatch = conceptoRaw.match(/TEF DATANET PR (.*?) \d{11}/);
    if (tefMatch) nombreRaw = tefMatch[1].trim();
  }

  return {
    fecha: parsearFecha(rawFecha),
    monto: parsearMonto(rawMonto),
    referencia_mp: referencia != null ? String(referencia).trim() : null,
    pagador_nombre: nombreRaw ? String(nombreRaw).trim() : null,
    pagador_email: encontrarValor(fila, COLUMN_ALIASES.pagador_email) || null,
    pagador_cuit_dni: cuitRaw ? String(cuitRaw).trim() : null,
    tipo: tipoRaw.includes('recurr') || tipoRaw.includes('suscrip') ? 'donacion_recurrente' : 'donacion_unica',
    estado_origen: estadoRaw,
  };
}

function detectarDelimitadorCSV(texto) {
  const primeraLinea = texto.split('\n')[0] || '';
  const puntoYComa = (primeraLinea.match(/;/g) || []).length;
  const coma = (primeraLinea.match(/,/g) || []).length;
  const tab = (primeraLinea.match(/\t/g) || []).length;
  if (tab > puntoYComa && tab > coma) return '\t';
  if (puntoYComa > coma) return ';';
  return ',';
}

function parseCSV(buffer) {
  const texto = buffer.toString('utf8');
  const delimiter = detectarDelimitadorCSV(texto);
  const filas = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, delimiter });
  return filas.map(filaARegistro);
}

function obtenerFilasDeHoja(hoja) {
  const rowsRaw = XLSX.utils.sheet_to_json(hoja, { header: 1, defval: null });
  if (!rowsRaw || rowsRaw.length === 0) return [];

  // Buscar en las primeras 15 filas cuál contiene los encabezados principales
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rowsRaw.length, 15); i++) {
    const fila = rowsRaw[i];
    if (!Array.isArray(fila)) continue;
    const filaTexto = fila.map((c) => normalizarTexto(c)).join(' ');
    // Detecta cabeceras de Mercado Pago o de extractos bancarios (Banco Macro / Home Banking)
    if (
      (filaTexto.includes('fecha') && (filaTexto.includes('monto') || filaTexto.includes('importe') || filaTexto.includes('valor'))) ||
      (filaTexto.includes('referencia') && filaTexto.includes('concepto')) ||
      (filaTexto.includes('operacion') && (filaTexto.includes('id') || filaTexto.includes('aprobacion') || filaTexto.includes('compra') || filaTexto.includes('neto')))
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) headerIndex = 0;

  const headers = rowsRaw[headerIndex];
  if (!Array.isArray(headers)) return [];

  const resultado = [];
  for (let i = headerIndex + 1; i < rowsRaw.length; i++) {
    const fila = rowsRaw[i];
    if (!Array.isArray(fila) || fila.every((c) => c == null || c === '')) continue;
    // Detener si es pie de página de Banco Macro u otros bancos
    if (fila[0] && (String(fila[0]).startsWith('Fecha de descarga') || String(fila[0]).startsWith('Empresa:'))) {
      break;
    }
    const obj = {};
    headers.forEach((h, idx) => {
      if (h != null && String(h).trim() !== '') obj[String(h).trim()] = fila[idx];
    });
    resultado.push(obj);
  }
  return resultado;
}

function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let mejorFilas = [];
  for (const name of wb.SheetNames) {
    const hoja = wb.Sheets[name];
    const filasHoja = obtenerFilasDeHoja(hoja);
    if (filasHoja.length > mejorFilas.length) {
      mejorFilas = filasHoja;
    }
  }
  return mejorFilas.map(filaARegistro);
}

// ---- PDF — Parser calibrado contra resumen real de Mercado Pago ----
//
// Estructura detectada en el PDF real:
//   - Encabezado: "RESUMEN DE CUENTA EN PESOS", nombre, CVU, CUIT, periodo, saldos
//   - Headers de pagina repetidos: "FechaDescripcion\nID de la\noperacion\nValorSaldo"
//   - Numeracion de paginas: "N/M"
//   - Movimientos en bloques multi-linea:
//       dd-mm-yyyy
//       Descripcion linea 1
//       Descripcion linea 2 (opcional)
//       Descripcion linea 3 (opcional)
//       <ID_OPERACION>$ <VALOR>$ <SALDO>
//
// El monto del movimiento aparece como "$ -1.234,56" y el saldo como "$ 5.678,90"
// pegados en la misma linea con el ID, sin espacios claros entre ellos.

// Regex para detectar lineas de fecha al inicio: dd-mm-yyyy
const RE_FECHA_LINEA = /^(\d{2}-\d{2}-\d{4})$/;

// Regex para la linea de datos: ID_OPERACION seguido de montos con $
// Ejemplo: "172662109428$ -52.031,86$ 877.665,79"
// Captura: (1) id operacion, (2) valor (con signo), (3) saldo
const RE_DATOS_LINEA = /^(\d{6,20})\$\s*(-?[\d.,]+)\$\s*(-?[\d.,]+)$/;

// Lineas que son ruido del PDF (encabezados, pies de pagina)
const RE_RUIDO = /^(\d+\/\d+|FechaDescripci|ID de la|operaci[oó]n|ValorSaldo|RESUMEN DE CUENTA|Periodo:|Saldo inicial:|Saldo final:|Entradas:|Salidas:|CVU:|CUIT|DETALLE DE MOVIMIENTOS|Del \d)$/i;

// Patrones de clasificacion — calibrados contra el PDF real
const PATRONES_RENDIMIENTO = [
  /^rendimientos?$/i,
  /rendimiento/i,
  /dinero invertido/i,
  /r[eé]dito/i,
  /inter[eé]s/i,
  /intereses/i,
  /ganancia por saldo/i,
  /cuenta remunerada/i,
  /pago de inter[eé]s/i,
  /liq\.?\s*rendimiento/i,
];

// Movimientos que son ingresos (transferencias recibidas, pagos recibidos, etc.)
const PATRONES_INGRESO = [
  /transferencia recibida/i,
  /transferencia/i,
  /transf\b/i,
  /tef datanet/i,
  /pago recibido/i,
  /recibiste un pago/i,
  /cobraste/i,
  /donaci[oó]n/i,
  /acreditaci[oó]n/i,
  /dep[oó]sito/i,
  /dinero retirado/i,         // en el PDF real, "Dinero retirado X" son ingresos al saldo
  /devoluci[oó]n de pago/i,
];

// Movimientos que son egresos (pagos de servicios, transferencias enviadas, debitos)
const PATRONES_EGRESO = [
  /pago de servicio/i,
  /transferencia enviada/i,
  /d[eé]bito por deuda/i,
  /dinero reservado/i,
  /compra en/i,
  /retiro de dinero/i,
  /cr[eé]ditos de mercado pago/i,
];

function parsearMontoAR(texto) {
  // Convierte "1.234,56" o "-1.234,56" a numero
  return Number(texto.replace(/\./g, '').replace(',', '.'));
}

function parsearFechaDD_MM_YYYY(texto) {
  // Convierte "dd-mm-yyyy" a Date
  const [d, m, y] = texto.split('-');
  const fecha = new Date(`${y}-${m}-${d}`);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

async function parsePDF(buffer) {
  const data = await pdfParse(buffer);
  const lineas = data.text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Paso 1: Agrupar lineas en bloques de movimientos.
  // Cada bloque empieza con una linea de fecha y termina con una linea de datos (ID+monto+saldo).
  const bloques = [];
  let bloqueActual = null;

  for (const linea of lineas) {
    // Saltar ruido (encabezados repetidos, numeracion de pagina, etc.)
    if (RE_RUIDO.test(linea)) continue;

    const matchFecha = linea.match(RE_FECHA_LINEA);
    if (matchFecha) {
      // Nueva fecha encontrada — si habia un bloque anterior sin cerrar, lo descartamos
      // (puede pasar si el PDF tiene algo raro)
      bloqueActual = {
        fecha: parsearFechaDD_MM_YYYY(matchFecha[1]),
        descripcionLineas: [],
        idOperacion: null,
        valor: null,
        saldo: null,
      };
      continue;
    }

    if (!bloqueActual) continue; // Lineas antes del primer movimiento

    const matchDatos = linea.match(RE_DATOS_LINEA);
    if (matchDatos) {
      // Linea de datos: cierra el bloque actual
      bloqueActual.idOperacion = matchDatos[1];
      bloqueActual.valor = parsearMontoAR(matchDatos[2]);
      bloqueActual.saldo = parsearMontoAR(matchDatos[3]);
      bloques.push(bloqueActual);
      bloqueActual = null;
      continue;
    }

    // Cualquier otra linea es parte de la descripcion
    bloqueActual.descripcionLineas.push(linea);
  }

  // Paso 2: Clasificar cada bloque como rendimiento, ingreso (donacion) o egreso
  const filas = [];
  const rendimientos = [];
  const invalidas = [];

  for (const bloque of bloques) {
    if (!bloque.fecha || bloque.valor == null) {
      invalidas.push({ descripcion: bloque.descripcionLineas.join(' '), motivo: 'sin_fecha_o_monto' });
      continue;
    }

    const descripcion = bloque.descripcionLineas.join(' ');

    // Clasificar
    const esRendimiento = PATRONES_RENDIMIENTO.some((re) => re.test(descripcion));
    if (esRendimiento) {
      rendimientos.push({
        fecha: bloque.fecha,
        monto: Math.abs(bloque.valor),
        descripcion,
      });
      continue;
    }

    const esIngreso = bloque.valor > 0 || PATRONES_INGRESO.some((re) => re.test(descripcion));
    const esEgreso = bloque.valor < 0 || PATRONES_EGRESO.some((re) => re.test(descripcion));

    if (esEgreso && bloque.valor < 0) {
      // Los egresos no son donaciones — se descartan para el sistema de facturacion
      // pero se registran como invalidas para auditoria
      invalidas.push({
        fecha: bloque.fecha,
        monto: bloque.valor,
        referencia_mp: bloque.idOperacion,
        descripcion,
        tipo_detectado: 'egreso',
      });
      continue;
    }

    // Extraer nombre del pagador/origen de la descripcion
    // En el PDF real, la descripcion es algo como:
    //   "Transferencia recibida LORENA DEL VALLE JEREZ DEL CAMPO"
    //   "Dinero retirado Berta teresa"
    let pagadorNombre = null;
    const matchTransf = descripcion.match(/transferencia recibida\s+(.+)/i);
    const matchRetirado = descripcion.match(/dinero retirado\s+(.+)/i);
    const matchPago = descripcion.match(/pago recibido\s+(?:de\s+)?(.+)/i);
    const matchDevolucion = descripcion.match(/devoluci[oó]n de pago de servicio\s+(.+)/i);
    if (matchTransf) pagadorNombre = matchTransf[1].trim();
    else if (matchRetirado) pagadorNombre = matchRetirado[1].trim();
    else if (matchPago) pagadorNombre = matchPago[1].trim();
    else if (matchDevolucion) pagadorNombre = matchDevolucion[1].trim();

    // Determinar el estado
    let estadoOrigen = 'aprobado';
    if (!esIngreso && !esEgreso) {
      estadoOrigen = 'clasificado_por_defecto_revisar';
    }

    filas.push({
      fecha: bloque.fecha,
      monto: Math.abs(bloque.valor),
      referencia_mp: bloque.idOperacion,
      pagador_nombre: pagadorNombre,
      pagador_email: null,
      pagador_cuit_dni: null,
      tipo: 'donacion_unica',
      estado_origen: estadoOrigen,
    });
  }

  return { filas, rendimientos, invalidas };
}

/**
 * @param {Buffer} buffer contenido crudo del archivo subido
 * @param {'csv'|'xlsx'|'pdf'} formato
 * @returns {Promise<{filas: Array, rendimientos: Array, invalidas: Array}>}
 */
async function parsearArchivoMP(buffer, formato) {
  if (formato === 'pdf') return parsePDF(buffer);

  const registros = formato === 'xlsx' ? parseXLSX(buffer) : parseCSV(buffer);

  const filas = [];
  const rendimientos = [];
  const invalidas = [];

  for (const r of registros) {
    const valida = r.fecha && !Number.isNaN(r.fecha.getTime()) && r.monto != null && !Number.isNaN(r.monto) && r.referencia_mp;
    if (!valida) {
      invalidas.push(r);
      continue;
    }

    // Detectar si es un rendimiento financiero de Mercado Pago
    const textoCompleto = `${r.pagador_nombre || ''} ${r.estado_origen || ''}`.toLowerCase();
    const esRendimiento = PATRONES_RENDIMIENTO.some((re) => re.test(textoCompleto));
    if (esRendimiento) {
      rendimientos.push({
        fecha: r.fecha,
        monto: Math.abs(r.monto),
        descripcion: r.pagador_nombre || 'Rendimiento Mercado Pago',
      });
      continue;
    }

    // Si el monto es negativo o 0, es un egreso o compra QR (no es donación para facturar)
    if (r.monto <= 0) {
      invalidas.push({
        ...r,
        tipo_detectado: 'egreso_o_devolucion',
      });
      continue;
    }

    // Detectar transferencias propias entre cuentas de la misma fundación o fondos propios
    const cuitFundacion = '30719160162';
    const esPropia =
      (r.pagador_cuit_dni && r.pagador_cuit_dni.replace(/[-\s]/g, '') === cuitFundacion) ||
      textoCompleto.includes(cuitFundacion) ||
      textoCompleto.includes('liq susc') ||
      textoCompleto.includes('liq.susc');
    if (esPropia) {
      invalidas.push({
        ...r,
        tipo_detectado: 'transferencia_propia',
      });
      continue;
    }

    filas.push(r);
  }

  return { filas, rendimientos, invalidas };
}

module.exports = { parsearArchivoMP };
