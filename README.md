# Fundación Soy — Facturación automática ARCA y control de caja

Sistema interno (back-office) para automatizar la emisión de Factura C por
cada donación recibida vía Mercado Pago, y llevar un control de caja
unificado (donaciones facturadas + egresos). Corresponde a la **Fase 1** del
brief: procesamiento por archivo semanal, con la integración por webhook en
tiempo real dejada como fase futura (ver `src/services/facturacion.js`).

## Stack Tecnológico

- **Backend:** Node.js + Express
- **Base de datos:** PostgreSQL (via `pg`, con pool y transacciones ACID)
- **Vistas:** EJS server-rendered (estética editorial "libro de caja")
- **Seguridad:** `bcrypt` (hashing seguro de contraseñas), `express-session` con persistencia en PostgreSQL (`connect-pg-simple`), `helmet` (cabeceras HTTP seguras), `express-rate-limit` (prevención de fuerza bruta en login)
- **Importación / Exportación:** `multer`, `pdf-parse`, `xlsx` (lectura y generación de Excel), `csv-parse`
- **Comprobantes fiscales:** `pdfkit` (generación de Factura C con normativa fiscal) + `qrcode` (código QR con formato oficial de ARCA)
- **Firma digital ARCA:** `node-forge` (para firmar el TRA PKCS#7 en WSAA)

## Características Implementadas

1. 🔐 **Autenticación y Sesiones:**
   - Login seguro con usuario y contraseña (bcrypt).
   - Sesiones persistidas en PostgreSQL (`connect-pg-simple`).
   - Cierre de sesión y protección de todas las rutas del sistema.
   - Rate limiting en endpoint de autenticación.

2. 📄 **Generación de Factura C en PDF:**
   - Comprobante fiscal con diseño institucional que cumple con las regulaciones de ARCA (ex AFIP).
   - Código QR fiscal oficial embebido (datos en base64 según especificación de ARCA).
   - CAE y fecha de vencimiento fiscal.
   - Descarga directa o visualización en navegador desde el listado de donaciones.

3. 📥 **Parser Multi-formato de Mercado Pago (PDF, XLSX, CSV):**
   - Calibrado y probado con extractos reales de cuenta de Mercado Pago.
   - Reconocimiento de bloques multilínea en PDFs.
   - Separación inteligente entre donaciones/transferencias de terceros y rendimientos diarios de dinero invertido.
   - Detección automática de donantes recurrentes por CUIT/DNI, email o nombre.

4. 📊 **Exportación de Reportes a Excel:**
   - Exportación de donaciones (con filtros de fecha y estado de facturación).
   - Exportación de libro de caja (ingresos, egresos y saldos acumulados).

5. 📖 **Paginación Server-Side:**
   - Paginación eficiente en donaciones, caja y egresos para soportar grandes volúmenes de movimientos sin sobrecargar el navegador.

6. ✏️ **Control de Caja, Egresos y Eventos:**
   - Carga de gastos con comprobante adjunto y asociación a eventos benéficos.
   - Eliminación de egresos con recálculo automático del saldo cronológico de caja.
   - Eliminación controlada de eventos con validación de integridad referencial.

7. 🛡️ **Validación Server-Side:**
   - Validación y sanitización estricta de todos los formularios (montos positivos, fechas válidas, verificación de dígito verificador en CUITs).

## Puesta en marcha

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Crear la base de datos** (PostgreSQL debe estar corriendo):
   ```bash
   createdb fundacion_soy
   ```

3. **Configurar variables de entorno:**
   ```bash
   cp .env.example .env
   # Editar .env con las credenciales de tu PostgreSQL y definir SESSION_SECRET
   ```

4. **Aplicar el esquema (migraciones):**
   ```bash
   npm run migrate
   ```

5. **Cargar datos de ejemplo y usuario administrador inicial:**
   ```bash
   npm run seed
   ```
   *Credenciales por defecto creadas por el seed:*
   - **Usuario:** `admin`
   - **Contraseña:** `admin123` *(recomendado cambiar en producción)*

6. **Levantar el servidor:**
   ```bash
   npm start
   # o para desarrollo con reinicio automático:
   npm run dev
   ```

   Abrir `http://localhost:3000` en tu navegador.

## Despliegue

Ver [`DEPLOY.md`](./DEPLOY.md) para la guía paso a paso de despliegue en la nube (Render, Railway, VPS, etc.). Se incluye archivo `render.yaml` preconfigurado.

## Flujo de uso

1. **Configuración ARCA** (`/configuracion`): Mientras no tengas el certificado y la clave privada de ARCA, dejá el ambiente en **"Simulado (mock)"**. El sistema emitirá comprobantes con CAE ficticio permitiendo validar todo el circuito. Al recibir los archivos de ARCA, cambiá a **"Homologación"** para probar contra los servidores de prueba de ARCA.
2. **Importar donaciones** (`/donaciones/importar`): Subí el archivo semanal exportado de Mercado Pago (PDF, XLSX o CSV).
3. **Facturar el lote** (`/donaciones`, botón "Facturar pendientes"): Procesa las donaciones pendientes generando las facturas y los PDFs correspondientes de manera atómica.
4. **Descargar Facturas** (`/donaciones`): Hacé clic en el botón "PDF" de cualquier donación facturada para obtener el comprobante fiscal con su QR.
5. **Egresos y Eventos** (`/egresos`, `/eventos`): Registrá los gastos asociados a las actividades de la fundación.
6. **Caja y Reportes** (`/caja`): Consultá el saldo en tiempo real y exportá los reportes a Excel con un clic.

## Próximos pasos para pasar a Producción definitiva (Fases 2 y 3)

- [ ] Subir el certificado (`.crt`) y clave privada (`.key`) generados en ARCA para WSAA a la carpeta `secrets/`.
- [ ] Configurar el Punto de Venta asignado en ARCA vía la interfaz de Configuración.
- [ ] Completar el llamado SOAP contra el WSDL en `src/services/arca/wsaa.js` (`loginCms`) y `src/services/arca/wsfe.js` (`FECompUltimoAutorizado`, `FECAESolicitar`). Todo el flujo restante del sistema está 100% conectado y listo.
