require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dayjs = require('dayjs');

const pool = require('./db/pool');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const donacionesRoutes = require('./routes/donaciones');
const egresosRoutes = require('./routes/egresos');
const eventosRoutes = require('./routes/eventos');
const cajaRoutes = require('./routes/caja');
const configuracionRoutes = require('./routes/configuracion');
const exportarRoutes = require('./routes/exportar');

const app = express();

// Confiar en el reverse proxy de Render (necesario para cookies seguras por HTTPS)
app.set('trust proxy', 1);

// --- Seguridad ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

// --- Rate limiting en login (solo para intentos de envio POST) ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // limite amplio para pruebas y uso normal
  message: 'Demasiados intentos de login. Intentá de nuevo en unos minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Vistas ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helpers disponibles en todas las vistas EJS sin repetir imports.
app.locals.moneda = (n) =>
  '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
app.locals.fecha = (d) => (d ? dayjs(d).format('DD/MM/YYYY') : '—');

// --- Body parsers y archivos estaticos ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', process.env.UPLOADS_DIR || 'uploads')));

// --- Sesiones con PostgreSQL ---
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'fundacion-soy-dev-secret-cambiar-en-produccion',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 horas
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
  },
}));

// --- Rutas publicas (login) ---
app.post('/login', loginLimiter);
app.use('/', authRoutes);

// --- Middleware de autenticacion (protege todo lo demas) ---
app.use(requireAuth);

// --- Rutas protegidas ---
app.use('/', dashboardRoutes);
app.use('/donaciones', donacionesRoutes);
app.use('/egresos', egresosRoutes);
app.use('/eventos', eventosRoutes);
app.use('/caja', cajaRoutes);
app.use('/configuracion', configuracionRoutes);
app.use('/exportar', exportarRoutes);

// --- 404 ---
app.use((req, res) => {
  res.status(404).render('error', { mensaje: 'Esa pagina no existe.', activeNav: null });
});

// --- Error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { mensaje: err.message, activeNav: null });
});

module.exports = app;
