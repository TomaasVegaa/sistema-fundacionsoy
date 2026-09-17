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

const COLUMN_ALIASES = {
  fecha: ['fecha', 'date', 'fecha de aprobacion', 'release_date'],
  monto: ['monto', 'amount', 'transaction_amount', 'importe', 'valor'],
  referencia: ['referencia', 'id', 'payment_id', 'external_reference', 'source_id', 'id de la operación', 'id de la operacion'],
  pagador_nombre: ['pagador', 'payer_name', 'nombre', 'payer.first_name', 'descripción', 'descripcion'],
  pagador_email: ['email', 'payer_email', 'payer.email'],
  pagador_cuit_dni: ['cuit', 'dni', 'payer_identification', 'payer.identification.number', 'cuit/ cuil'],
  tipo: ['tipo', 'payment_type', 'type'],
  estado_origen: ['estado', 'status', 'payment_status'],
};

function normalizarHeader(h) {
  return String(h || '').trim().toLowerCase();
}

function encontrarValor(fila, alias) {
  const headers = Object.keys(fila);
  for (const h of headers) {
    if (alias.includes(normalizarHeader(h))) return fila[h];
  }
  return null;
}

function filaARegistro(fila) {
  const rawFecha = encontrarValor(fila, COLUMN_ALIASES.fecha);
  const rawMonto = encontrarValor(fila, COLUMN_ALIASES.monto);
  const referencia = encontrarValor(fila, COLUMN_ALIASES.referencia);
  const tipoRaw = String(encontrarValor(fila, COLUMN_ALIASES.tipo) || '').toLowerCase();

  return {
    fecha: rawFecha ? new Date(rawFecha) : null,
    monto: rawMonto != null ? Number(String(rawMonto).replace(/[^0-9.,-]/g, '').replace(',', '.')) : null,
    referencia_mp: referencia != null ? String(referencia) : null,
    pagador_nombre: encontrarValor(fila, COLUMN_ALIASES.pagador_nombre) || null,
    pagador_email: encontrarValor(fila, COLUMN_ALIASES.pagador_email) || null,
    pagador_cuit_dni: encontrarValor(fila, COLUMN_ALIASES.pagador_cuit_dni) || null,
    tipo: tipoRaw.includes('recurr') || tipoRaw.includes('suscrip') ? 'donacion_recurrente' : 'donacion_unica',
    estado_origen: encontrarValor(fila, COLUMN_ALIASES.estado_origen) || 'desconocido',
  };
}

function parseCSV(buffer) {
  const filas = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
  return filas.map(filaARegistro);
}

function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: null });
  return filas.map(filaARegistro);
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
  /inter[eé]s generad/i,
  /ganancia por saldo/i,
  /cuenta remunerada/i,
];

// Movimientos que son ingresos (transferencias recibidas, pagos recibidos, etc.)
const PATRONES_INGRESO = [
  /transferencia recibida/i,
  /pago recibido/i,
  /recibiste un pago/i,
  /cobraste/i,
  /donaci[oó]n/i,
  /acreditaci[oó]n/i,
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
  const invalidas = [];

  for (const r of registros) {
    const valida = r.fecha && !Number.isNaN(r.fecha.getTime()) && r.monto != null && !Number.isNaN(r.monto) && r.referencia_mp;
    if (valida) filas.push(r);
    else invalidas.push(r);
  }

  return { filas, rendimientos: [], invalidas };
}

module.exports = { parsearArchivoMP };
