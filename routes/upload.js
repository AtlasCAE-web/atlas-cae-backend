'use strict';
const express    = require('express');
const multer     = require('multer');
const rateLimit  = require('express-rate-limit');
const { Resend } = require('resend');

const router = express.Router();

const uploadLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
});

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic']);
const MAX_SIZE    = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 15 },
  fileFilter(_req, file, cb) {
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(Object.assign(new Error('Tipo de archivo no permitido: ' + file.originalname), { status: 400 }));
  },
}).fields([
  { name: 'declaracion_responsable', maxCount: 1  },
  { name: 'facturas',                maxCount: 10 },
  { name: 'ficha_tecnica',           maxCount: 1  },
  { name: 'propiedad_antigua',       maxCount: 1  },
  { name: 'no_propiedad',            maxCount: 1  },
]);

function sanitize(v = '') {
  return String(v).replace(/[<>"'`]/g, '').trim().slice(0, 300);
}
function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}
function isValidPhone(v) {
  return !v || /^[\d\s+\-().]{6,20}$/.test(v);
}
function generateCaseId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ATLAS-${d}-${r}`;
}

router.post('/upload', uploadLimit, (req, res, next) => {
  upload(req, res, async (multerErr) => {
    if (multerErr) {
      if (multerErr instanceof multer.MulterError) {
        const msg = multerErr.code === 'LIMIT_FILE_SIZE'
          ? 'Un archivo supera el límite de 10 MB.'
          : multerErr.code === 'LIMIT_FILE_COUNT'
          ? 'Demasiados archivos adjuntos.'
          : 'Error procesando los archivos.';
        return res.status(400).json({ success: false, message: msg });
      }
      return res.status(multerErr.status || 400).json({ success: false, message: multerErr.message });
    }

    try {
      const nombre   = sanitize(req.body.nombre);
      const empresa  = sanitize(req.body.empresa);
      const email    = sanitize(req.body.email);
      const telefono = sanitize(req.body.telefono);
      const tipoCaso = sanitize(req.body.tipo_caso);

      if (!nombre)                         return res.status(400).json({ success: false, message: 'El nombre es obligatorio.' });
      if (!email || !isValidEmail(email))  return res.status(400).json({ success: false, message: 'El email no es válido.' });
      if (!isValidPhone(telefono))         return res.status(400).json({ success: false, message: 'El teléfono no es válido.' });

      const files    = req.files || {};
      const allFiles = Object.values(files).flat();
      if (!allFiles.length) {
        return res.status(400).json({ success: false, message: 'No se ha recibido ningún archivo.' });
      }

      const caseId = generateCaseId();
      const fecha  = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

      // Siempre loguear en consola como respaldo
      console.log('[Nuevo caso]', { caseId, nombre, empresa, email, telefono, tipoCaso, fecha, archivos: allFiles.map(f => f.originalname) });

      // Responder al usuario inmediatamente
      res.status(200).json({
        success: true,
        caseId,
        message: `Documentación recibida correctamente. Tu referencia: ${caseId}`,
      });

      // Emails en background (no bloquean la respuesta)
      if (!process.env.RESEND_API_KEY) {
        console.warn('[Email] RESEND_API_KEY no configurado — emails omitidos.');
        return;
      }

      const resend      = new Resend(process.env.RESEND_API_KEY);
      const emailFrom   = process.env.EMAIL_FROM || 'Atlas CAE <onboarding@resend.dev>';
      const emailTo     = process.env.EMAIL_TO   || 'equipo@atlascae.es';
      const attachments = allFiles.map(f => ({ filename: f.originalname, content: f.buffer }));

      const internalHtml = `
        <div style="font-family:sans-serif;max-width:600px;color:#1a1a1a">
          <div style="background:#0A1628;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="color:#00C49A;margin:0;font-size:20px">ATLAS CAE — Nuevo caso</h2>
          </div>
          <div style="padding:24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px">
            <table style="border-collapse:collapse;width:100%;font-size:14px">
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;width:140px;background:#f9f9f9">Referencia</td><td style="padding:8px 12px;border:1px solid #ddd;font-family:monospace;color:#00C49A;font-weight:700">${caseId}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Nombre</td><td style="padding:8px 12px;border:1px solid #ddd">${nombre}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Empresa</td><td style="padding:8px 12px;border:1px solid #ddd">${empresa || '—'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Email</td><td style="padding:8px 12px;border:1px solid #ddd">${email}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Teléfono</td><td style="padding:8px 12px;border:1px solid #ddd">${telefono || '—'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Tipo de caso</td><td style="padding:8px 12px;border:1px solid #ddd">${tipoCaso || '—'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Fecha</td><td style="padding:8px 12px;border:1px solid #ddd">${fecha}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Archivos</td><td style="padding:8px 12px;border:1px solid #ddd">${allFiles.map(f => f.originalname).join('<br>')}</td></tr>
            </table>
          </div>
        </div>`;

      const confirmHtml = `
        <div style="font-family:sans-serif;max-width:600px;color:#1a1a1a">
          <div style="background:#0A1628;padding:24px;border-radius:8px 8px 0 0;text-align:center">
            <h1 style="color:#00C49A;margin:0;font-size:24px;letter-spacing:1px">ATLAS CAE</h1>
            <p style="color:#ffffff;margin:8px 0 0;font-size:14px">Confirmación de recepción de documentos</p>
          </div>
          <div style="padding:32px 24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px">
            <p style="margin:0 0 16px">Hola <strong>${nombre}</strong>,</p>
            <p style="margin:0 0 8px">Hemos recibido tu documentación correctamente. Tu número de referencia es:</p>
            <div style="background:#f0faf7;border:2px solid #00C49A;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
              <span style="font-family:monospace;font-size:24px;font-weight:700;color:#0A1628;letter-spacing:2px">${caseId}</span>
            </div>
            <p style="margin:0 0 16px">Guarda este número — lo necesitarás si quieres consultar el estado de tu solicitud.</p>
            <p style="margin:0 0 16px">Nuestro equipo revisará tu documentación y se pondrá en contacto contigo en los próximos días hábiles.</p>
            <p style="margin:32px 0 0;font-size:13px;color:#666">ATLAS CAE · <a href="mailto:${emailTo}" style="color:#00C49A;text-decoration:none">${emailTo}</a></p>
          </div>
        </div>`;

      resend.emails.send({
        from:        emailFrom,
        to:          emailTo,
        subject:     `[ATLAS CAE] Nuevo caso ${caseId} — ${nombre}`,
        html:        internalHtml,
        attachments,
      }).catch(e => console.error('[Email interno]', e.message));

      resend.emails.send({
        from:    emailFrom,
        to:      email,
        subject: `Tu documentación ATLAS CAE — Ref. ${caseId}`,
        html:    confirmHtml,
      }).catch(e => console.error('[Email usuario]', e.message));

    } catch (err) {
      console.error('[Upload]', err);
      if (!res.headersSent) next(err);
    }
  });
});

module.exports = router;
