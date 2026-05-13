'use strict';
const { google }      = require('googleapis');
const { PassThrough } = require('stream');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function getDrive() {
  const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';

  const privateKey = rawKey.includes('\\n')
    ? rawKey.replace(/\\n/g, '\n')
    : rawKey;

  if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
    throw new Error(
      `GOOGLE_PRIVATE_KEY parece inválida. Longitud: ${rawKey.length} chars. ` +
      `¿Copiaste el valor completo incluyendo -----BEGIN PRIVATE KEY----- ?`
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

async function checkRootFolder() {
  const drive = getDrive();
  const res = await drive.files.get({
    fileId:            process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    fields:            'id,name,mimeType,driveId,webViewLink',
    supportsAllDrives: true,
  });
  return res.data;
}

async function createCaseFolder(caseId, nombre, empresa) {
  console.log('[Drive] Creando carpeta para:', caseId);
  const drive = getDrive();
  const name  = empresa
    ? `${caseId} - ${nombre} - ${empresa}`
    : `${caseId} - ${nombre}`;

  try {
    const root = await drive.files.get({
      fileId:            process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
      fields:            'id,name',
      supportsAllDrives: true,
    });
    console.log('[Drive] Root folder OK:', root.data.name, '/', root.data.id);
  } catch (e) {
    console.warn('[Drive] Root folder check falló (continuando):', e.message);
  }

  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents:  [process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID],
    },
    fields: 'id,webViewLink',
  });

  console.log('[Drive] Carpeta creada:', res.data.id, '→', name);
  return res.data;
}

async function uploadFileToDrive(buffer, filename, mimeType, folderId) {
  const drive = getDrive();

  const stream = new PassThrough();
  stream.end(buffer);

  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: { name: filename, parents: [folderId] },
    media:       { mimeType, body: stream },
    fields:      'id',
  });

  console.log('[Drive] Archivo subido:', filename, `(${Math.round(buffer.length / 1024)} KB)`);
  return res.data;
}

module.exports = { checkRootFolder, createCaseFolder, uploadFileToDrive };
