'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const uploadRouter = require('./routes/upload');

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

const rawOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = rawOrigins.some(allowed => {
      if (allowed.includes('*')) {
        const re = new RegExp('^' + allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return re.test(origin);
      }
      return allowed === origin;
    });
    cb(ok ? null : new Error('Origen no permitido: ' + origin), ok);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/api', uploadRouter);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Ruta no encontrada.' }));

app.use((err, _req, res, _next) => {
  const status  = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status >= 500
    ? 'Error interno del servidor. Inténtalo de nuevo.'
    : err.message;
  console.error('[Error]', err.message);
  res.status(status).json({ success: false, message });
});

app.listen(PORT, () => console.log(`ATLAS CAE backend · puerto ${PORT}`));
