'use strict';
const path       = require('path');
const crypto     = require('crypto');
const express    = require('express');
const multer     = require('multer');
const rateLimit  = require('express-rate-limit');
const { Resend } = require('resend');
const { createCaseFolder, uploadFileToDrive } = require('../services/drive');

const router  = express.Router();
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Configuración de archivos permitidos ────────────────
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

// Extensiones que JAMÁS deben pasar, incluso si vinieran disfrazadas
const DANGEROUS_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.dll', '.sh', '.bash',
  '.zsh', '.ps1', '.vbs', '.js', '.mjs', '.cjs', '.jsp', '.php', '.phtml',
  '.py', '.rb', '.pl', '.jar', '.war', '.ear', '.class', '.app', '.apk',
  '.html', '.htm', '.svg', '.xml', '.xhtml', '.zip', '.rar', '.7z', '.tar',
  '.gz', '.iso', '.dmg', '.lnk', '.url', '.htaccess', '.htpasswd', '.env',
]);

const MAX_FILE_SIZE   = 10 * 1024 * 1024; // 10 MB por archivo
const MAX_FILES       = 15;
const MAX_TOTAL_SIZE  = 60 * 1024 * 1024; // 60 MB por petición
const MAX_FIELD_SIZE  = 2 * 1024;         // 2 KB por campo de texto

// ── Rate limit específico para upload ───────────────────
const uploadLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'OPTIONS',
  message: { success: false, message: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' },
});

// ── Multer: solo en memoria, límites estrictos ──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize:   MAX_FILE_SIZE,
    files:      MAX_FILES,
    fieldSize:  MAX_FIELD_SIZE,
    fields:     20,
    parts:      MAX_FILES + 20,
    headerPairs: 100,
  },
  fileFilter(_req, file, cb) {
    // basename evita path traversal vía originalname
    const safeName = path.basename(String(file.originalname || ''));
    const ext = path.extname(safeName).toLowerCase();

    if (DANGEROUS_EXT.has(ext)) {
      return cb(reject('Tipo de archivo no permitido.', 400));
    }
    // AND estricto: extensión y mimetype declarado deben estar AMBOS permitidos.
    // La validación REAL por magic bytes ocurre después del multipart parsing.
    if (!ALLOWED_EXT.has(ext) || !ALLOWED_MIME.has(file.mimetype)) {
      return cb(reject('Tipo de archivo no permitido.', 400));
    }
    cb(null, true);
  },
}).fields([
  { name: 'declaracion_responsable', maxCount: 1  },
  { name: 'facturas',                maxCount: 10 },
  { name: 'ficha_tecnica',           maxCount: 1  },
  { name: 'propiedad_antigua',       maxCount: 1  },
  { name: 'no_propiedad',            maxCount: 1  },
]);

const FIELD_PREFIX = {
  declaracion_responsable: '01',
  facturas:                '02',
  ficha_tecnica:           '03',
  propiedad_antigua:       '04',
  no_propiedad:            '05',
};

// ── Helpers ─────────────────────────────────────────────
function reject(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeText(v, maxLen = 200) {
  return String(v || '')
    .replace(/[\x00-\x1F\x7F]/g, '') // control chars
    .trim()
    .slice(0, maxLen);
}

function isValidName(v) {
  // Letras, espacios, guiones, apóstrofes, puntos. Latín extendido aceptado.
  return /^[\p{L}][\p{L}\p{M}\s'.\-]{1,99}$/u.test(v);
}
function isValidCompany(v) {
  // Opcional. Si viene, alfanumérico + símbolos comunes de empresa.
  if (!v) return true;
  return /^[\p{L}\p{N}][\p{L}\p{M}\p{N}\s&.,'\-()]{0,149}$/u.test(v);
}
function isValidEmail(v) {
  return typeof v === 'string'
      && v.length <= 254
      && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(v);
}
function isValidPhone(v) {
  if (!v) return true;
  return /^[\d\s+\-().]{6,20}$/.test(v);
}
function isValidTipoCaso(v) {
  if (!v) return true;
  return /^[\p{L}\p{N}\s_\-.,]{1,80}$/u.test(v);
}

function generateCaseId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
  return `ATLAS-${d}-${r}`;
}

// ── Detección REAL de tipo por magic bytes ─────────────
function detectActualMime(buf) {
  if (!buf || buf.length < 12) return null;

  // PDF: "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return 'image/png';
  }
  // WebP: "RIFF"...."WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  // HEIC/HEIF: bytes 4-7 = "ftyp", bytes 8-11 = brand
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString('ascii');
    const heicBrands = new Set([
      'heic','heix','hevc','heim','heis','hevm','hevs','mif1','msf1','heif',
    ]);
    if (heicBrands.has(brand)) return 'image/heic';
  }
  return null;
}

// Compat: el mime detectado debe coincidir con la familia declarada
function mimeFamilyMatch(declared, detected) {
  if (!detected) return false;
  if (declared === detected) return true;
  // HEIC y HEIF intercambiables
  if ((declared === 'image/heic' || declared === 'image/heif') && detected === 'image/heic') return true;
  return false;
}

// Nombre seguro para Drive (no afecta a la extensión de subida)
function driveFilename(fieldName, index, total, originalname) {
  const prefix = FIELD_PREFIX[fieldName] || '99';
  const base   = path.basename(String(originalname || ''));
  const ext    = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 6);
  const suffix = total > 1 ? `_${index + 1}` : '';
  return `${prefix}_${fieldName}${suffix}${ext}`;
}

// Log de PII enmascarado: solo dominio del email + iniciales
function maskEmail(e) {
  if (!e || !e.includes('@')) return '***';
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}***@${d}`;
}

// ── Endpoint ─────────────────────────────────────────────
router.post('/upload', uploadLimit, (req, res, next) => {
  upload(req, res, async (multerErr) => {
    if (multerErr) {
      // Errores controlados de multer: respuestas seguras y específicas
      if (multerErr instanceof multer.MulterError) {
        const map = {
          LIMIT_FILE_SIZE:  'Un archivo supera el límite de 10 MB.',
          LIMIT_FILE_COUNT: 'Demasiados archivos adjuntos.',
          LIMIT_PART_COUNT: 'Demasiadas partes en la petición.',
          LIMIT_FIELD_VALUE: 'Algún campo es demasiado largo.',
          LIMIT_FIELD_COUNT: 'Demasiados campos.',
          LIMIT_UNEXPECTED_FILE: 'Campo de archivo no esperado.',
        };
        console.warn('[Upload] multer:', multerErr.code);
        return res.status(400).json({ success: false, message: map[multerErr.code] || 'Error procesando los archivos.' });
      }
      console.warn('[Upload] filter:', multerErr.message);
      return res.status(multerErr.status || 400).json({ success: false, message: multerErr.message });
    }

    try {
      const files    = req.files || {};
      const allFiles = Object.values(files).flat();

      // ── Validación de campos de texto ────────────────────
      const nombre   = sanitizeText(req.body.nombre,    100);
      const empresa  = sanitizeText(req.body.empresa,   150);
      const email    = sanitizeText(req.body.email,     254).toLowerCase();
      const telefono = sanitizeText(req.body.telefono,  20);
      const tipoCaso = sanitizeText(req.body.tipo_caso, 80);

      if (!isValidName(nombre)) {
        return res.status(400).json({ success: false, message: 'El nombre no es válido.' });
      }
      if (!isValidCompany(empresa)) {
        return res.status(400).json({ success: false, message: 'El nombre de empresa no es válido.' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ success: false, message: 'El email no es válido.' });
      }
      if (!isValidPhone(telefono)) {
        return res.status(400).json({ success: false, message: 'El teléfono no es válido.' });
      }
      if (!isValidTipoCaso(tipoCaso)) {
        return res.status(400).json({ success: false, message: 'El tipo de caso no es válido.' });
      }

      // ── Validación de archivos ───────────────────────────
      if (!allFiles.length) {
        return res.status(400).json({ success: false, message: 'No se ha recibido ningún archivo.' });
      }

      const totalSize = allFiles.reduce((s, f) => s + (f.size || 0), 0);
      if (totalSize > MAX_TOTAL_SIZE) {
        return res.status(413).json({ success: false, message: 'El tamaño total de los archivos supera el límite permitido.' });
      }

      // Validación magic bytes — bloquea MIME spoofing
      for (const f of allFiles) {
        const detected = detectActualMime(f.buffer);
        if (!mimeFamilyMatch(f.mimetype, detected)) {
          console.warn('[Upload] mime mismatch — declared:', f.mimetype, 'detected:', detected);
          return res.status(400).json({ success: false, message: 'Uno de los archivos no es un PDF o imagen válida.' });
        }
      }

      // ── Verificación rápida de config de Drive ───────────
      if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID) {
        console.error('[Upload] Falta configuración de Google Drive en el servidor');
        return res.status(503).json({ success: false, message: 'Servicio temporalmente no disponible.' });
      }

      const caseId = generateCaseId();
      const fecha  = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

      console.log(`[Upload] ${caseId} · ${allFiles.length} archivos · ${Math.round(totalSize/1024)} KB · ${maskEmail(email)}`);

      // ── Crear carpeta en Drive ───────────────────────────
      let driveFolderId, driveFolderUrl;
      try {
        const folder = await createCaseFolder(caseId, nombre, empresa);
        driveFolderId  = folder.id;
        driveFolderUrl = folder.webViewLink;
      } catch (e) {
        console.error('[Upload] Drive folder create FAILED:', e.message);
        return res.status(502).json({ success: false, message: 'No se pudo crear la carpeta de almacenamiento. Inténtalo más tarde.' });
      }

      // ── Subir archivos a Drive en paralelo ───────────────
      const driveFiles = [];
      const tasks = Object.entries(files).flatMap(([fieldName, fileArray]) =>
        fileArray.map((file, index) => {
          const filename = driveFilename(fieldName, index, fileArray.length, file.originalname);
          return uploadFileToDrive(file.buffer, filename, file.mimetype, driveFolderId)
            .then(() => driveFiles.push({ filename, ok: true }))
            .catch(e => {
              console.error('[Upload] Drive upload FAILED:', filename, '·', e.message);
              driveFiles.push({ filename, ok: false });
            });
        })
      );
      await Promise.all(tasks);

      const subidosOK = driveFiles.filter(f => f.ok).length;
      console.log(`[Upload] ${caseId} · drive OK: ${subidosOK}/${driveFiles.length}`);

      // ── Responder al usuario (no esperar al email) ───────
      res.status(200).json({
        success: true,
        caseId,
        driveFolderUrl,
        message: `Documentación recibida correctamente. Tu referencia: ${caseId}`,
      });

      // ── Emails en background (PII solo en cuerpo del email, no en logs) ──
      if (!process.env.RESEND_API_KEY) {
        console.warn('[Email] RESEND_API_KEY no configurado — emails omitidos.');
        return;
      }

      const resend    = new Resend(process.env.RESEND_API_KEY);
      const emailFrom = process.env.EMAIL_FROM || 'Atlas CAE <onboarding@resend.dev>';
      const emailTo   = process.env.EMAIL_TO   || 'equipo@atlascae.es';

      // Datos escapados para HTML
      const eNombre   = escapeHtml(nombre);
      const eEmpresa  = escapeHtml(empresa);
      const eEmail    = escapeHtml(email);
      const eTelefono = escapeHtml(telefono);
      const eTipoCaso = escapeHtml(tipoCaso);
      const eFecha    = escapeHtml(fecha);
      const eCaseId   = escapeHtml(caseId);
      const eEmailTo  = escapeHtml(emailTo);
      const eFolder   = escapeHtml(driveFolderUrl || '');

      const filesListHtml = driveFiles
        .map(f => {
          const name = escapeHtml(f.filename);
          const color = f.ok ? '#1a1a1a' : '#cc0000';
          const tag   = f.ok ? '' : ' &#9888; error al subir';
          return `<li style="padding:3px 0;font-family:monospace;font-size:13px;color:${color}">${name}${tag}</li>`;
        })
        .join('');

      const internalHtml = `
        <div style="font-family:sans-serif;max-width:620px;color:#1a1a1a">
          <div style="background:#0A1628;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="color:#00C49A;margin:0;font-size:20px">ATLAS CAE — Nuevo caso</h2>
          </div>
          <div style="padding:24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px">
            <table style="border-collapse:collapse;width:100%;font-size:14px;margin-bottom:24px">
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;width:140px;background:#f9f9f9">Referencia</td><td style="padding:8px 12px;border:1px solid #ddd;font-family:monospace;color:#00C49A;font-weight:700">${eCaseId}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Nombre</td><td style="padding:8px 12px;border:1px solid #ddd">${eNombre}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Empresa</td><td style="padding:8px 12px;border:1px solid #ddd">${eEmpresa || '&mdash;'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Email</td><td style="padding:8px 12px;border:1px solid #ddd">${eEmail}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Teléfono</td><td style="padding:8px 12px;border:1px solid #ddd">${eTelefono || '&mdash;'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Tipo de caso</td><td style="padding:8px 12px;border:1px solid #ddd">${eTipoCaso || '&mdash;'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;background:#f9f9f9">Fecha</td><td style="padding:8px 12px;border:1px solid #ddd">${eFecha}</td></tr>
            </table>

            <p style="font-weight:600;margin:0 0 12px;font-size:14px">Archivos en Drive:</p>
            <ul style="margin:0 0 24px;padding-left:20px">${filesListHtml}</ul>

            <div style="text-align:center;margin:24px 0">
              <a href="${eFolder}"
                 style="display:inline-block;background:#00C49A;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.5px">
                Ver carpeta en Google Drive &rarr;
              </a>
            </div>
          </div>
        </div>`;

      const confirmHtml = `
        <div style="font-family:sans-serif;max-width:600px;color:#1a1a1a">
          <div style="background:#0A1628;padding:24px;border-radius:8px 8px 0 0;text-align:center">
            <h1 style="color:#00C49A;margin:0;font-size:24px;letter-spacing:1px">ATLAS CAE</h1>
            <p style="color:#ffffff;margin:8px 0 0;font-size:14px">Confirmación de recepción de documentos</p>
          </div>
          <div style="padding:32px 24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 8px 8px">
            <p style="margin:0 0 16px">Hola <strong>${eNombre}</strong>,</p>
            <p style="margin:0 0 8px">Hemos recibido tu documentación correctamente. Tu número de referencia es:</p>
            <div style="background:#f0faf7;border:2px solid #00C49A;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
              <span style="font-family:monospace;font-size:24px;font-weight:700;color:#0A1628;letter-spacing:2px">${eCaseId}</span>
            </div>
            <p style="margin:0 0 16px">Guarda este número &mdash; lo necesitarás si quieres consultar el estado de tu solicitud.</p>
            <p style="margin:0 0 16px">Nuestro equipo revisará tu documentación y se pondrá en contacto contigo en los próximos días hábiles.</p>
            <p style="margin:32px 0 0;font-size:13px;color:#666">ATLAS CAE &middot; <a href="mailto:${eEmailTo}" style="color:#00C49A;text-decoration:none">${eEmailTo}</a></p>
          </div>
        </div>`;

      resend.emails.send({
        from:    emailFrom,
        to:      emailTo,
        subject: `[ATLAS CAE] Nuevo caso ${caseId}`,
        html:    internalHtml,
      }).catch(e => console.error('[Email] interno FAILED:', e.message));

      resend.emails.send({
        from:    emailFrom,
        to:      email,
        subject: `Tu documentación ATLAS CAE — Ref. ${caseId}`,
        html:    confirmHtml,
      }).catch(e => console.error('[Email] confirmación FAILED:', e.message));

    } catch (err) {
      console.error('[Upload] unexpected:', err.message);
      if (!IS_PROD && err.stack) console.error(err.stack);
      if (!res.headersSent) next(err);
    }
  });
});

module.exports = router;
