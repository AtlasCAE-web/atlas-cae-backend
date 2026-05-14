'use strict';
const { google }      = require('googleapis');
const { PassThrough } = require('stream');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Flags requeridos para operar en Shared Drives / Team Drives
const SHARED_DRIVE_PARAMS = {
  supportsAllDrives:  true,
  supportsTeamDrives: true,
};

// Cache del cliente Drive — se inicializa una vez por proceso
let _drive = null;

function getDrive() {
  if (_drive) return _drive;

  const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('GOOGLE_PRIVATE_KEY inválida o ausente.');
  }
  if (!process.env.GOOGLE_CLIENT_EMAIL) {
    throw new Error('GOOGLE_CLIENT_EMAIL ausente.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  _drive = google.drive({ version: 'v3', auth, timeout: 30_000 });
  return _drive;
}

// Sanea el nombre de carpeta antes de mandarlo a Drive
function safeFolderName(s, maxLen = 120) {
  return String(s || '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[\\/]/g, '-')
    .trim()
    .slice(0, maxLen);
}

async function checkRootFolder() {
  const drive = getDrive();
  const res = await drive.files.get({
    ...SHARED_DRIVE_PARAMS,
    fileId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    fields: 'id,name,mimeType,driveId,webViewLink',
  });
  return res.data;
}

async function createCaseFolder(caseId, nombre, empresa) {
  const drive  = getDrive();
  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  const safeNombre  = safeFolderName(nombre, 80);
  const safeEmpresa = safeFolderName(empresa, 80);
  const name = safeEmpresa
    ? `${caseId} - ${safeNombre} - ${safeEmpresa}`
    : `${caseId} - ${safeNombre}`;

  const res = await drive.files.create({
    ...SHARED_DRIVE_PARAMS,
    fields: 'id,webViewLink',
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents:  [rootId],
    },
  });

  return res.data;
}

async function uploadFileToDrive(buffer, filename, mimeType, folderId) {
  const drive  = getDrive();
  const stream = new PassThrough();
  stream.end(buffer);

  const res = await drive.files.create({
    ...SHARED_DRIVE_PARAMS,
    fields: 'id',
    requestBody: {
      name:    filename,
      parents: [folderId],
    },
    media: { mimeType, body: stream },
  });

  return res.data;
}

module.exports = { checkRootFolder, createCaseFolder, uploadFileToDrive };
