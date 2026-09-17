// Funciones de validacion server-side reutilizables.

function validarMonto(valor) {
  const n = Number(valor);
  if (Number.isNaN(n) || n <= 0) return 'El monto debe ser un número mayor a 0.';
  if (n > 99999999999) return 'El monto es demasiado grande.';
  return null;
}

function validarFecha(valor) {
  if (!valor) return 'La fecha es obligatoria.';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return 'La fecha no es válida.';
  return null;
}

function validarTextoRequerido(valor, campo) {
  const t = String(valor || '').trim();
  if (!t) return `El campo "${campo}" es obligatorio.`;
  if (t.length > 500) return `El campo "${campo}" es demasiado largo (máx. 500 caracteres).`;
  return null;
}

function validarCUIT(valor) {
  if (!valor) return null; // opcional
  const limpio = String(valor).replace(/[-\s]/g, '');
  if (!/^\d{11}$/.test(limpio)) return 'El CUIT debe tener 11 dígitos.';
  // Digito verificador
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(limpio[i]) * mult[i];
  const resto = 11 - (suma % 11);
  const verificador = resto === 11 ? 0 : resto === 10 ? 9 : resto;
  if (verificador !== Number(limpio[10])) return 'El dígito verificador del CUIT no es válido.';
  return null;
}

function validarEmail(valor) {
  if (!valor) return null; // opcional
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor)) return 'El email no tiene un formato válido.';
  return null;
}

function sanitizar(texto) {
  if (!texto) return '';
  return String(texto).trim()
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Ejecuta un array de validaciones y devuelve el primer error, o null si todo OK.
function validar(validaciones) {
  for (const v of validaciones) {
    const error = v();
    if (error) return error;
  }
  return null;
}

module.exports = { validarMonto, validarFecha, validarTextoRequerido, validarCUIT, validarEmail, sanitizar, validar };
