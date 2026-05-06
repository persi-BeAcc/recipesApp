// lib/storage.js
//
// Provider-agnostic storage adapter. Every API handler imports from here
// instead of lib/dropbox.js directly. The provider is determined by the
// `x-storage-provider` header sent by the client ('dropbox' | 'gdrive').
// Defaults to 'dropbox' for backward compatibility.
//
// Usage in API handlers:
//   import { getProvider, ops } from '../lib/storage.js';
//   const provider = getProvider(req);
//   const { readJson, writeJson, listFolder, ... } = ops(provider);
//   const data = await readJson(token, '/recipe-abc.json');

import {
  getAccessToken as dbxGetAccessToken,
  buildAuthorizeUrl as dbxBuildAuthorizeUrl,
  exchangeAuthCode as dbxExchangeAuthCode,
  revokeRefreshToken as dbxRevokeRefreshToken,
  getCurrentAccount as dbxGetCurrentAccount,
  dbxApi,
  dbxDownloadText,
  dbxReadJson,
  dbxWriteJson,
  dbxUpload,
  dbxDelete,
  dbxListFolder,
  dbxTempLink,
  dbxSharedLink,
} from './dropbox.js';

import {
  getAccessToken as gdriveGetAccessToken,
  buildAuthorizeUrl as gdriveBuildAuthorizeUrl,
  exchangeAuthCode as gdriveExchangeAuthCode,
  revokeRefreshToken as gdriveRevokeRefreshToken,
  getCurrentAccount as gdriveGetCurrentAccount,
  gdriveDownloadText,
  gdriveReadJson,
  gdriveWriteJson,
  gdriveUpload,
  gdriveDelete,
  gdriveListFolder,
  gdriveTempLink,
  gdriveSharedLink,
} from './gdrive.js';

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export function getProvider(req) {
  const header = (req.headers['x-storage-provider'] || '').toLowerCase();
  if (header === 'gdrive') return 'gdrive';
  return 'dropbox';
}

// Get the storage token from the request. Checks x-dropbox-token first
// (backward compat), then x-storage-token, then Authorization: Bearer.
export function getToken(req) {
  return req.headers['x-dropbox-token']
    || req.headers['x-storage-token']
    || (() => {
         const auth = req.headers['authorization'] || '';
         const m = auth.match(/^Bearer\s+(\S.*)$/i);
         return m ? m[1].trim() : '';
       })()
    || '';
}

// ---------------------------------------------------------------------------
// Operations — unified interface across providers
// ---------------------------------------------------------------------------

const dropboxOps = {
  readJson:        dbxReadJson,
  writeJson:       dbxWriteJson,
  upload:          dbxUpload,
  remove:          dbxDelete,
  listFolder:      dbxListFolder,
  downloadText:    dbxDownloadText,
  tempLink:        dbxTempLink,
  sharedLink:      dbxSharedLink,
  getAccessToken:  dbxGetAccessToken,
  getCurrentAccount: dbxGetCurrentAccount,
  revokeToken:     dbxRevokeRefreshToken,
  buildAuthorizeUrl: dbxBuildAuthorizeUrl,
  exchangeAuthCode:  dbxExchangeAuthCode,
};

const gdriveOps = {
  readJson:        gdriveReadJson,
  writeJson:       gdriveWriteJson,
  upload:          gdriveUpload,
  remove:          gdriveDelete,
  listFolder:      gdriveListFolder,
  downloadText:    gdriveDownloadText,
  tempLink:        gdriveTempLink,
  sharedLink:      gdriveSharedLink,
  getAccessToken:  gdriveGetAccessToken,
  getCurrentAccount: gdriveGetCurrentAccount,
  revokeToken:     gdriveRevokeRefreshToken,
  buildAuthorizeUrl: gdriveBuildAuthorizeUrl,
  exchangeAuthCode:  gdriveExchangeAuthCode,
};

export function ops(provider) {
  if (provider === 'gdrive') return gdriveOps;
  return dropboxOps;
}
