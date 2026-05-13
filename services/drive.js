'use strict';
const { google }   = require('googleapis');
const { Readable } = require('stream');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function getDrive() {
  const rawKey     = process.env.GOOGLE_PRIVATE_KEY || '';
  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

async function createCaseFolder(caseId, nombre, empresa) {
  const drive = getDrive();
  const name  = empresa ? `${caseId} - ${nombre} - ${empresa}` : `${caseId} - ${nombre}`;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents:  [process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID],
    },
    fields: 'id,webViewLink',
  });

  return res.data; // { id, webViewLink }
}

async function uploadFileToDrive(buffer, filename, mimeType, folderId) {
  const drive  = getDrive();
  const stream = Readable.from(buffer);

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media:       { mimeType, body: stream },
    fields:      'id',
  });

  return res.data;
}

module.exports = { createCaseFolder, uploadFileToDrive };
