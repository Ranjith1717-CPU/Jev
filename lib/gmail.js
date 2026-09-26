'use strict';

// Minimal Gmail OAuth + metadata client — no SDK, just fetch, matching lib/jev.js.
//
// Uses the `gmail.metadata` scope on purpose: that scope is restricted by
// Google to headers (From, Subject, Date, ...) and label/thread info. It
// cannot return message bodies even if this code asked for them. That's
// what makes "subject lines only" a real guarantee, not just good behavior.

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', '.gmail-token.json');
const SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function redirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/google/callback`;
}

function configured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(t) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2));
}

function clearTokens() {
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {
    /* already gone */
  }
}

function isConnected() {
  return Boolean(loadTokens());
}

async function exchangeCode(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'Google OAuth exchange failed');
  json.obtained_at = Date.now();
  saveTokens(json);
  return json;
}

async function refreshAccessToken(tokens) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'Google token refresh failed');
  const merged = { ...tokens, ...json, obtained_at: Date.now() };
  saveTokens(merged);
  return merged;
}

async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('Gmail is not connected.');
  const expiresAt = (tokens.obtained_at || 0) + (tokens.expires_in || 0) * 1000;
  if (Date.now() > expiresAt - 60_000) {
    if (!tokens.refresh_token) throw new Error('Gmail session expired — reconnect.');
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

async function getProfile() {
  const accessToken = await getAccessToken();
  const res = await fetch(`${API_BASE}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Failed to load Gmail profile');
  return json.emailAddress;
}

// Returns [{ id, from, subject }] — headers only, never a body.
async function listRecentSubjects(n) {
  const accessToken = await getAccessToken();
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const listRes = await fetch(
    `${API_BASE}/messages?maxResults=${encodeURIComponent(n)}&labelIds=INBOX`,
    { headers: authHeaders }
  );
  const listJson = await listRes.json();
  if (!listRes.ok) throw new Error(listJson.error?.message || 'Failed to list Gmail messages');

  const ids = (listJson.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const r = await fetch(
      `${API_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { headers: authHeaders }
    );
    const j = await r.json();
    if (!r.ok) continue;
    out.push({
      id: j.id,
      from: header(j.payload?.headers, 'From') || '(unknown sender)',
      subject: header(j.payload?.headers, 'Subject') || '(no subject)',
    });
  }
  return out;
}

module.exports = {
  configured,
  getAuthUrl,
  exchangeCode,
  isConnected,
  clearTokens,
  getProfile,
  listRecentSubjects,
};
