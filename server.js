'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const uploadRouter        = require('./routes/upload');
const { checkRootFolder } = require('./services/drive');

const app  = express();
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';

// Render terminates TLS upstream — exactly 1 proxy hop
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── CORS ─────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const wildcardMatchers = ALLOWED_ORIGINS
  .filter(o => o.includes('*'))
  .map(o => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));

const exactOrigins = new Set(ALLOWED_ORIGINS.filter(o => !o.includes('*')));

function isAllowedOrigin(origin) {
  if (exactOrigins.has(origin)) return true;
  return wildcardMatchers.some(re => re.test(origin));
}

const corsOptions = {
  origin(origin, cb) {
    // Sin Origin: permitir solo fuera de producción (dev tools, server-to-server local).
    // En producción, solo browsers con Origin son aceptados.
    if (!origin) return cb(null, !IS_PROD);
    // No throw → no 500 en preflight. Browser bloqueará por ausencia de header ACAO.
    return cb(null, isAllowedOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Cabeceras seguras ───────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,        // API JSON, no servimos HTML
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: IS_PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '64kb' }));

// ── Rate limit global (skip OPTIONS para no romper preflights) ──
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'OPTIONS',
  message: { success: false, message: 'Demasiadas peticiones. Inténtalo más tarde.' },
}));

// ── Health check (público, mínimo) ──────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Endpoints de diagnóstico (protegidos por ADMIN_TOKEN) ──
// Solo se exponen si ADMIN_TOKEN está definido en el entorno.
// Si la env no existe, devuelven 404 (no se anuncian).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ success: false, message: 'Ruta no encontrada.' });
  const provided = req.get('x-admin-token') || '';
  if (provided.length !== ADMIN_TOKEN.length || provided !== ADMIN_TOKEN) {
    return res.status(404).json({ success: false, message: 'Ruta no encontrada.' });
  }
  return next();
}

app.get('/api/debug-config', requireAdmin, (_req, res) => {
  res.json({
    ok:               true,
    nodeEnv:          process.env.NODE_ENV || 'development',
    resend:           !!process.env.RESEND_API_KEY,
    driveClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    drivePrivateKey:  !!(process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_PRIVATE_KEY.length > 100),
    driveRootFolder:  !!process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    allowedOriginsCount: ALLOWED_ORIGINS.length,
  });
});

app.get('/api/test-drive-folder', requireAdmin, async (_req, res) => {
  try {
    const folder = await checkRootFolder();
    res.json({ ok: true, folder: { id: folder.id, name: folder.name, driveId: folder.driveId } });
  } catch (e) {
    console.error('[test-drive-folder] error:', e.message);
    res.status(500).json({ ok: false, error: 'Drive check failed' });
  }
});

app.use('/api', uploadRouter);

// 404
app.use((_req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada.' }));

// Error handler — no filtra detalles internos en producción
app.use((err, _req, res, _next) => {
  const status = err.status || 500;

  // CORS rechazado (defensa: por si algún path lanza Error en lugar de cb(null,false))
  if (err && /CORS/i.test(err.message || '')) {
    return res.status(403).json({ success: false, message: 'Origen no permitido.' });
  }

  // Log completo solo en servidor
  console.error('[Error]', status, err.message);
  if (!IS_PROD && err.stack) console.error(err.stack);

  // Respuesta al cliente: mensaje seguro
  if (status >= 500) {
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
  res.status(status).json({ success: false, message: err.message || 'Petición inválida.' });
});

app.listen(PORT, () => {
  console.log(`ATLAS CAE backend · puerto ${PORT} · ${process.env.NODE_ENV || 'development'}`);
  console.log(`Orígenes CORS permitidos: ${ALLOWED_ORIGINS.length}`);
});
