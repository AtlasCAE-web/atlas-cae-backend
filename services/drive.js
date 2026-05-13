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

// Flags requeridos para operar en Shared Drives / Team Drives
const SHARED_DRIVE_PARAMS = {
  supportsAllDrives:  true,
  supportsTeamDrives: true,
};

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
  console.log('[Drive] Creando carpeta para:', caseId);
  const drive    = getDrive();
  const rootId   = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  const name     = empresa
    ? `${caseId} - ${nombre} - ${empresa}`
    : `${caseId} - ${nombre}`;

  try {
    const root = await drive.files.get({
      ...SHARED_DRIVE_PARAMS,
      fileId: rootId,
      fields: 'id,name,driveId',
    });
    console.log('[Drive] Root folder OK:', root.data.name, '/ id:', root.data.id, '/ driveId:', root.data.driveId);
  } catch (e) {
    console.warn('[Drive] Root folder check falló (continuando):', e.message);
  }

  const res = await drive.files.create({
    ...SHARED_DRIVE_PARAMS,
    fields:      'id,webViewLink',
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents:  [rootId],
    },
  });

  console.log('[Drive] Carpeta creada:', res.data.id, '→', name);
  return res.data;
}

async function uploadFileToDrive(buffer, filename, mimeType, folderId) {
  const drive  = getDrive();
  const stream = new PassThrough();
  stream.end(buffer);

  const res = await drive.files.create({
    ...SHARED_DRIVE_PARAMS,
    fields:      'id',
    requestBody: {
      name:    filename,
      parents: [folderId],
    },
    media: { mimeType, body: stream },
  });

  console.log('[Drive] Archivo subido:', filename, `(${Math.round(buffer.length / 1024)} KB)`);
  return res.data;
}

module.exports = { checkRootFolder, createCaseFolder, uploadFileToDrive };
