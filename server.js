'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const uploadRouter      = require('./routes/upload');
const { checkRootFolder } = require('./services/drive');

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

const rawOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());
console.log('[CORS] Orígenes permitidos:', rawOrigins);

app.use(cors({
  origin(origin, cb) {
    // Peticiones sin origin (Postman, server-to-server, health checks)
    if (!origin) return cb(null, true);
    const ok = rawOrigins.some(allowed => {
      if (allowed.includes('*')) {
        const re = new RegExp('^' + allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return re.test(origin);
      }
      return allowed === origin;
    });
    if (!ok) {
      console.warn('[CORS] Origen RECHAZADO:', origin);
      console.warn('[CORS] Añade este origen a ALLOWED_ORIGINS en Render');
    }
    cb(ok ? null : new Error('Origen no permitido por CORS: ' + origin), ok);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Health check ──────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Debug config — confirmar que las env vars llegaron a Render ──
app.get('/api/debug-config', (_req, res) => {
  res.json({
    ok:              true,
    resend:          !!process.env.RESEND_API_KEY,
    driveClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    drivePrivateKey:  !!(process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_PRIVATE_KEY.length > 100),
    driveRootFolder:  !!process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    allowedOrigins:   process.env.ALLOWED_ORIGINS || '(no definido — solo localhost:3000)',
    nodeEnv:          process.env.NODE_ENV || 'development',
  });
});

// ── Test acceso a carpeta raíz de Drive ───────────────────
app.get('/api/test-drive-folder', async (_req, res) => {
  try {
    const folder = await checkRootFolder();
    console.log('[test-drive-folder] OK:', folder);
    res.json({ ok: true, folder });
  } catch (e) {
    console.error('[test-drive-folder] ERROR:', e.stack || e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use('/api', uploadRouter);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  const status  = err.status || 500;
  // En producción NO ocultar el mensaje — necesitamos verlo para depurar
  const message = err.message;
  console.error('[Error handler]', err.stack || err.message);
  res.status(status).json({ success: false, message });
});

app.listen(PORT, () => {
  console.log(`\nATLAS CAE backend · puerto ${PORT} · ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health:       GET /health`);
  console.log(`Debug config: GET /api/debug-config`);
  console.log(`Test Drive:   GET /api/test-drive-folder`);
  console.log(`Upload:       POST /api/upload\n`);
});
