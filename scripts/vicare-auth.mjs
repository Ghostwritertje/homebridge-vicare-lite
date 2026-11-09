#!/usr/bin/env node
// One-time ViCare OAuth login (PKCE). Stores the refresh token for the plugin; never prints tokens.
//
//   node scripts/vicare-auth.mjs            -> prints a login URL, waits for the redirect on :4200
//   node scripts/vicare-auth.mjs --features -> uses the stored token to list the device's features (read-only)
//
// Client ID: ~/.homebridge/vicare-client-id (one line). Token: ~/.homebridge/persist/vicare-token.json (0600).
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HB = process.env.HOMEBRIDGE_STORAGE || join(homedir(), '.homebridge');
const CLIENT_ID_FILE = join(HB, 'vicare-client-id');
const TOKEN_FILE = join(HB, 'persist', 'vicare-token.json');
const REDIRECT_URI = process.env.VICARE_REDIRECT_URI || 'http://192.168.178.99:4200/';
const IAM = 'https://iam.viessmann-climatesolutions.com/idp/v3';
const API = 'https://api.viessmann-climatesolutions.com/iot/v2';

const clientId = readFileSync(CLIENT_ID_FILE, 'utf8').trim();
const b64url = (buf) => buf.toString('base64url');

function saveToken(refreshToken) {
  writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken, savedAt: new Date().toISOString() }, null, 2));
  chmodSync(TOKEN_FILE, 0o600);
}

async function tokenRequest(params) {
  const res = await fetch(`${IAM}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${body.error ?? ''} ${body.error_description ?? ''}`);
  return body;
}

async function login() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const url = `${IAM}/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'IoT User offline_access',
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  })}`;
  console.log(`Open this URL and log in with your ViCare account:\n\n${url}\n\nWaiting on ${REDIRECT_URI} (10 min) ...`);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('timed out')); }, 600_000);
    const server = createServer(async (req, res) => {
      const q = new URL(req.url, REDIRECT_URI).searchParams;
      if (!q.get('code') && !q.get('error')) { res.writeHead(404).end(); return; }
      try {
        if (q.get('error')) throw new Error(`authorize: ${q.get('error')} ${q.get('error_description') ?? ''}`);
        if (q.get('state') !== state) throw new Error('state mismatch');
        const tok = await tokenRequest({
          grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code_verifier: verifier, code: q.get('code'),
        });
        if (!tok.refresh_token) throw new Error('no refresh_token in response (offline_access scope?)');
        saveToken(tok.refresh_token);
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ViCare login OK. You can close this tab.');
        console.log(`Login OK. Refresh token saved to ${TOKEN_FILE}`);
        clearTimeout(timer); server.close(); resolve();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Login failed: ${e.message}`);
        clearTimeout(timer); server.close(); reject(e);
      }
    });
    server.listen(4200, '0.0.0.0');
  });
}

async function accessToken() {
  const { refreshToken } = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (tok.refresh_token && tok.refresh_token !== refreshToken) saveToken(tok.refresh_token);
  return tok.access_token;
}

async function features() {
  const at = await accessToken();
  const get = async (path) => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${at}` } });
    const body = await res.json();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
    return body.data;
  };
  for (const inst of await get('/equipment/installations')) {
    for (const gw of await get(`/equipment/installations/${inst.id}/gateways`)) {
      console.log(`\n# gateway type=${gw.gatewayType} version=${gw.version}`);
      for (const dev of await get(`/equipment/installations/${inst.id}/gateways/${gw.serial}/devices`)) {
        console.log(`\n## device id=${dev.id} type=${dev.deviceType} model=${dev.modelId} status=${dev.status}`);
        if (dev.deviceType === 'vitoconnect' || dev.id === 'gateway') continue;
        const feats = await get(
          `/features/installations/${inst.id}/gateways/${gw.serial}/devices/${dev.id}/features`);
        for (const f of feats.filter((f) => f.isEnabled)) {
          const props = Object.entries(f.properties ?? {})
            .map(([k, v]) => `${k}=${typeof v.value === 'object' ? JSON.stringify(v.value) : v.value}${v.unit ? ' ' + v.unit : ''}`)
            .join(', ');
          const cmds = Object.entries(f.commands ?? {}).map(([k, c]) => `${k}${c.isExecutable ? '' : '(n/a)'}`).join(',');
          console.log(`${f.feature}${props ? '  ' + props : ''}${cmds ? '  [cmd: ' + cmds + ']' : ''}`);
        }
      }
    }
  }
}

(process.argv.includes('--features') ? features() : login()).catch((e) => { console.error(e.message); process.exit(1); });
