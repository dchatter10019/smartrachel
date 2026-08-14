// mcp-auth.js
// API key issuance and verification for Rachel MCP (port 3600).
//
// Problem this solves: Rachel MCP previously had ONE shared bearer token for
// every caller, and every tool trusted whatever `email` the caller supplied in
// the request body — meaning any caller could look up or act as ANY customer
// just by putting their email in the request. This module gives every caller
// their own API key, permanently bound to exactly one email address that they
// have proven ownership of via a one-time verification code sent to that inbox.
// Tool handlers should resolve the caller's email from their API key (see
// resolveEmailForKey below) and NEVER trust a caller-supplied `email` field for
// anything security-sensitive (session lookups, personalization, order
// attribution).

const fs = require('fs');
const crypto = require('crypto');

const KEYS_PATH = '/home/ubuntu/config/mcp-api-keys.json';
const PENDING_PATH = '/home/ubuntu/config/mcp-pending-verifications.json';
const CODE_EXPIRY_MS = 15 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

function loadJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadKeys() { return loadJson(KEYS_PATH, {}); }
function saveKeys(keys) { saveJson(KEYS_PATH, keys); }
function loadPending() { return loadJson(PENDING_PATH, {}); }
function savePending(pending) { saveJson(PENDING_PATH, pending); }

function generateApiKey() {
  return 'rmcp_' + crypto.randomBytes(24).toString('hex');
}

function generateVerificationCode() {
  return String(crypto.randomInt(100000, 999999));
}

const rateLimitState = {};

function isRateLimited(email) {
  const now = Date.now();
  const key = email.toLowerCase();
  const timestamps = (rateLimitState[key] || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitState[key] = timestamps;
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) return true;
  timestamps.push(now);
  rateLimitState[key] = timestamps;
  return false;
}

async function requestKey(email) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { success: false, error: 'Valid email required' };
  }
  if (isRateLimited(normalizedEmail)) {
    return { success: false, error: 'Too many requests for this email — please wait a minute and try again' };
  }

  const code = generateVerificationCode();
  const pending = loadPending();
  pending[normalizedEmail] = { code, expiresAt: Date.now() + CODE_EXPIRY_MS };
  savePending(pending);

  const { sendEmail } = require('./email-utils.js');
  await sendEmail(
    [normalizedEmail],
    'Your Rachel MCP verification code',
    `Your verification code is: ${code}\n\nThis code expires in 15 minutes. Enter it wherever you requested API access to confirm you own this email address.\n\nIf you didn't request this, you can safely ignore this email.`
  );

  return { success: true, message: 'Verification code sent — check your email' };
}

function verifyCode(email, code) {
  const normalizedEmail = (email || '').trim().toLowerCase();
  const pending = loadPending();
  const entry = pending[normalizedEmail];

  if (!entry) return { success: false, error: 'No pending verification for this email — request a code first' };
  if (Date.now() > entry.expiresAt) {
    delete pending[normalizedEmail];
    savePending(pending);
    return { success: false, error: 'Verification code expired — request a new one' };
  }
  if (String(code).trim() !== entry.code) {
    return { success: false, error: 'Incorrect code' };
  }

  delete pending[normalizedEmail];
  savePending(pending);

  const keys = loadKeys();
  let existingKey = null;
  for (const [k, v] of Object.entries(keys)) {
    if (v.email === normalizedEmail) { existingKey = k; break; }
  }
  if (existingKey) {
    return { success: true, api_key: existingKey, email: normalizedEmail, reused: true };
  }

  const newKey = generateApiKey();
  keys[newKey] = { email: normalizedEmail, verified: true, createdAt: new Date().toISOString() };
  saveKeys(keys);
  return { success: true, api_key: newKey, email: normalizedEmail, reused: false };
}

function resolveEmailForKey(apiKey) {
  if (!apiKey) return null;
  const keys = loadKeys();
  const entry = keys[apiKey];
  return entry ? entry.email : null;
}

module.exports = { requestKey, verifyCode, resolveEmailForKey };
