-- ============================================================
-- Fundacion Soy — Esquema PostgreSQL (Fase 1)
-- Idempotente: puede correrse varias veces sin romper nada.
-- ============================================================

CREATE TABLE IF NOT EXISTS donantes (
  id              BIGSERIAL PRIMARY KEY,
  nombre          TEXT,
  cuit_dni        TEXT,
  email           TEXT,
  telefono        TEXT,
  condicion_iva   TEXT DEFAULT 'consumidor_final',
  es_recurrente   BOOLEAN NOT NULL DEFAULT FALSE,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS donantes_email_uidx
  ON donantes (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donantes_cuit_uidx
  ON donantes (cuit_dni) WHERE cuit_dni IS NOT NULL;

CREATE TABLE IF NOT EXISTS raw_imports (
  id                BIGSERIAL PRIMARY KEY,
  nombre_archivo    TEXT NOT NULL,
  formato           TEXT NOT NULL CHECK (formato IN ('csv', 'xlsx', 'pdf')),
  contenido_crudo   TEXT NOT NULL,          -- archivo original en base64, para auditoria
  filas_totales     INTEGER,
  filas_importadas  INTEGER,
  filas_duplicadas  INTEGER,
  procesado         BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_importacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS donaciones (
  id             BIGSERIAL PRIMARY KEY,
  donante_id     BIGINT REFERENCES donantes(id),
  fecha          DATE NOT NULL,
  monto          NUMERIC(14,2) NOT NULL,
  referencia_mp  TEXT NOT NULL,
  tipo           TEXT NOT NULL CHECK (tipo IN ('donacion_unica', 'donacion_recurrente')),
  estado_origen  TEXT,
  estado         TEXT NOT NULL DEFAULT 'pendiente_facturacion'
                 CHECK (estado IN ('pendiente_facturacion', 'facturada', 'error_facturacion')),
  factura_id     BIGINT,
  raw_import_id  BIGINT REFERENCES raw_imports(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotencia: nunca importar dos veces la misma transaccion de MP.
CREATE UNIQUE INDEX IF NOT EXISTS donaciones_referencia_uidx
  ON donaciones (referencia_mp);

CREATE INDEX IF NOT EXISTS donaciones_estado_idx ON donaciones (estado);
CREATE INDEX IF NOT EXISTS donaciones_fecha_idx ON donaciones (fecha);

CREATE TABLE IF NOT EXISTS facturas (
  id                  BIGSERIAL PRIMARY KEY,
  cbte_tipo           INTEGER NOT NULL DEFAULT 11,
  punto_venta         INTEGER,
  numero_comprobante  BIGINT,
  cae                 TEXT,
  vencimiento_cae     DATE,
  monto               NUMERIC(14,2) NOT NULL,
  donacion_id         BIGINT NOT NULL REFERENCES donaciones(id),
  pdf_url             TEXT,
  estado              TEXT NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente', 'emitida', 'error')),
  error_detalle       TEXT,
  ambiente            TEXT NOT NULL DEFAULT 'mock',
  emitida_en          TIMESTAMPTZ
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'donaciones_factura_fk'
  ) THEN
    ALTER TABLE donaciones
      ADD CONSTRAINT donaciones_factura_fk
      FOREIGN KEY (factura_id) REFERENCES facturas(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Rendimientos que Mercado Pago acredita por dejar el saldo invertido
-- (cuenta remunerada). NO son donaciones: no llevan donante, no se
-- facturan con Factura C, pero si suman al saldo de caja como ingreso.
CREATE TABLE IF NOT EXISTS ingresos_financieros_mp (
  id             BIGSERIAL PRIMARY KEY,
  fecha          DATE NOT NULL,
  monto          NUMERIC(14,2) NOT NULL,
  descripcion    TEXT,               -- texto original de la linea, para auditoria
  raw_import_id  BIGINT REFERENCES raw_imports(id),
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eventos (
  id           BIGSERIAL PRIMARY KEY,
  nombre       TEXT NOT NULL,
  fecha        DATE,
  descripcion  TEXT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS egresos (
  id               BIGSERIAL PRIMARY KEY,
  fecha            DATE NOT NULL,
  concepto         TEXT NOT NULL,
  monto            NUMERIC(14,2) NOT NULL,
  categoria        TEXT,
  evento_id        BIGINT REFERENCES eventos(id),
  comprobante_url  TEXT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS caja_movimientos (
  id                BIGSERIAL PRIMARY KEY,
  tipo              TEXT NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  monto             NUMERIC(14,2) NOT NULL,
  fecha             DATE NOT NULL,
  referencia_tipo   TEXT NOT NULL CHECK (referencia_tipo IN ('donacion', 'egreso', 'rendimiento_mp')),
  referencia_id     BIGINT NOT NULL,
  saldo_acumulado   NUMERIC(14,2) NOT NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS caja_fecha_idx ON caja_movimientos (fecha);

CREATE TABLE IF NOT EXISTS configuracion_arca (
  id                    BIGSERIAL PRIMARY KEY,
  punto_venta           INTEGER,
  cbte_tipo_default     INTEGER NOT NULL DEFAULT 11,
  certificado_path      TEXT,
  clave_privada_path    TEXT,
  certificado_content   TEXT,
  clave_privada_content TEXT,
  razon_social          TEXT DEFAULT 'FUNDACION SOI (SERVICIO ONCOLOGICO INFANTIL)',
  domicilio_comercial   TEXT DEFAULT 'ASUNCION 731 Piso:1 Dpto:3, San Miguel de Tucumán, Tucumán',
  cuit_emisor           TEXT,
  ambiente              TEXT NOT NULL DEFAULT 'mock'
                         CHECK (ambiente IN ('mock', 'homologacion', 'produccion')),
  actualizado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fila unica de configuracion (se actualiza, no se duplica).
INSERT INTO configuracion_arca (id, ambiente, punto_venta, cuit_emisor, razon_social, domicilio_comercial)
  VALUES (1, 'mock', 2, '30-71916016-2', 'FUNDACION SOI (SERVICIO ONCOLOGICO INFANTIL)', 'ASUNCION 731 Piso:1 Dpto:3, San Miguel de Tucumán, Tucumán')
  ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Usuarios del sistema (autenticacion)
-- ============================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id              BIGSERIAL PRIMARY KEY,
  nombre          TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  rol             TEXT NOT NULL DEFAULT 'admin'
                   CHECK (rol IN ('admin', 'operador', 'lectura')),
  activo          BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Sesiones (connect-pg-simple)
-- ============================================================

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey"
      PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
