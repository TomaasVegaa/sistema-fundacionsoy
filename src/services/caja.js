const pool = require('../db/pool');

async function saldoActual(client) {
  const { rows } = await client.query(
    `SELECT saldo_acumulado FROM caja_movimientos ORDER BY id DESC LIMIT 1`
  );
  return rows[0] ? Number(rows[0].saldo_acumulado) : 0;
}

async function registrarIngreso(client, { monto, fecha, referencia_tipo, referencia_id }) {
  const saldoPrevio = await saldoActual(client);
  const nuevoSaldo = saldoPrevio + Number(monto);
  await client.query(
    `INSERT INTO caja_movimientos (tipo, monto, fecha, referencia_tipo, referencia_id, saldo_acumulado)
     VALUES ('ingreso', $1, $2, $3, $4, $5)`,
    [monto, fecha, referencia_tipo, referencia_id, nuevoSaldo]
  );
  return nuevoSaldo;
}

// Rendimiento de Mercado Pago: suma al saldo igual que una donacion,
// pero no se asocia a un donante ni genera Factura C.
async function registrarIngresoFinanciero(client, { monto, fecha, referenciaId }) {
  const saldoPrevio = await saldoActual(client);
  const nuevoSaldo = saldoPrevio + Number(monto);
  await client.query(
    `INSERT INTO caja_movimientos (tipo, monto, fecha, referencia_tipo, referencia_id, saldo_acumulado)
     VALUES ('ingreso', $1, $2, 'rendimiento_mp', $3, $4)`,
    [monto, fecha, referenciaId, nuevoSaldo]
  );
  return nuevoSaldo;
}

async function registrarEgreso({ monto, fecha, egresoId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saldoPrevio = await saldoActual(client);
    const nuevoSaldo = saldoPrevio - Number(monto);
    await client.query(
      `INSERT INTO caja_movimientos (tipo, monto, fecha, referencia_tipo, referencia_id, saldo_acumulado)
       VALUES ('egreso', $1, $2, 'egreso', $3, $4)`,
      [monto, fecha, egresoId, nuevoSaldo]
    );
    await client.query('COMMIT');
    return nuevoSaldo;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { registrarIngreso, registrarIngresoFinanciero, registrarEgreso, saldoActual };
