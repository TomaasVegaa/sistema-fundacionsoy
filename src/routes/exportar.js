const express = require('express');
const XLSX = require('xlsx');
const pool = require('../db/pool');
const dayjs = require('dayjs');

const router = express.Router();

router.get('/donaciones', async (req, res) => {
  const { desde, hasta } = req.query;
  const condiciones = [];
  const valores = [];

  if (desde) { valores.push(desde); condiciones.push(`d.fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`d.fecha <= $${valores.length}`); }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT d.*, don.nombre AS donante_nombre, don.email AS donante_email,
            f.cae, f.numero_comprobante, f.punto_venta
     FROM donaciones d
     LEFT JOIN donantes don ON don.id = d.donante_id
     LEFT JOIN facturas f ON f.id = d.factura_id
     ${where}
     ORDER BY d.fecha DESC, d.id DESC`,
    valores
  );

  const wb = XLSX.utils.book_new();
  const data = rows.map(r => ({
    Fecha: dayjs(r.fecha).format('DD/MM/YYYY'),
    Donante: r.donante_nombre || 'Sin identificar',
    Email: r.donante_email || '',
    Tipo: r.tipo === 'donacion_recurrente' ? 'Recurrente' : 'Puntual',
    Monto: Number(r.monto),
    Estado: r.estado,
    'Referencia MP': r.referencia_mp,
    CAE: r.cae || '',
    Comprobante: r.numero_comprobante ? `${String(r.punto_venta || 0).padStart(5, '0')}-${String(r.numero_comprobante).padStart(8, '0')}` : '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  // Ancho de columnas
  ws['!cols'] = [
    { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 12 },
    { wch: 14 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Donaciones');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `donaciones_${dayjs().format('YYYYMMDD')}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

router.get('/caja', async (req, res) => {
  const { desde, hasta, tipo } = req.query;
  const condiciones = [];
  const valores = [];

  if (desde) { valores.push(desde); condiciones.push(`fecha >= $${valores.length}`); }
  if (hasta) { valores.push(hasta); condiciones.push(`fecha <= $${valores.length}`); }
  if (tipo) { valores.push(tipo); condiciones.push(`tipo = $${valores.length}`); }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT * FROM caja_movimientos ${where} ORDER BY fecha DESC, id DESC`,
    valores
  );

  const wb = XLSX.utils.book_new();
  const data = rows.map(r => ({
    Fecha: dayjs(r.fecha).format('DD/MM/YYYY'),
    Tipo: r.tipo === 'ingreso' ? 'Ingreso' : 'Egreso',
    Origen: r.referencia_tipo === 'donacion' ? `Donación #${r.referencia_id}`
          : r.referencia_tipo === 'rendimiento_mp' ? `Rendimiento MP #${r.referencia_id}`
          : `Egreso #${r.referencia_id}`,
    Monto: r.tipo === 'egreso' ? -Number(r.monto) : Number(r.monto),
    'Saldo acumulado': Number(r.saldo_acumulado),
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 25 }, { wch: 14 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Caja');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `caja_${dayjs().format('YYYYMMDD')}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

module.exports = router;
