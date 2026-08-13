// webchat-video/server.js
//
// Video-chat prototype for Rachel. Architecture:
//   1. Browser captures mic audio, transcribes it client-side (Web Speech API for now).
//   2. Transcribed text is POSTed here to /api/chat-bridge.
//   3. This server forwards it to Rachel's EXISTING /chat endpoint (unchanged) —
//      same state machine, same order/proposal flows, same everything built to date.
//   4. Rachel's text reply is sent back to the browser.
//   5. The browser hands that reply text to the HeyGen LiveAvatar SDK, which
//      synthesizes speech + lip-syncs it (HeyGen's own TTS — we don't build our own).
//
// This file also proxies HeyGen's session-token creation so the API key never
// reaches the browser.
//
// NOTE: the exact HeyGen LiveAvatar REST endpoints/params below are based on
// current public docs (POST /v1/sessions/token, POST /v1/sessions/start) — verify
// against the installed @heygen/liveavatar-web-sdk's own docs/type defs once
// `npm install` has run, since this is a very new, fast-moving API surface.

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8600;
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
const RACHEL_URL = process.env.RACHEL_URL || 'http://127.0.0.1:3500';
const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '';
const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

if (!OPENAI_API_KEY) {
  console.warn('[webchat-video] WARNING: OPENAI_API_KEY not set — /api/tts will fail.');
}

if (!HEYGEN_API_KEY) {
  console.warn('[webchat-video] WARNING: HEYGEN_API_KEY not set in .env — token endpoint will fail.');
}

const sessions = {}; // sessionId -> { createdAt }

app.post('/api/heygen-token', async (req, res) => {
  if (!HEYGEN_AVATAR_ID || !HEYGEN_VOICE_ID) {
    return res.status(400).json({
      error: 'HEYGEN_AVATAR_ID and HEYGEN_VOICE_ID must be set in .env before a session can start. Pick an avatar and voice from the LiveAvatar dashboard (app.liveavatar.com) first.'
    });
  }
  try {
    // Correct API domain is api.liveavatar.com, NOT api.heygen.com — LiveAvatar
    // is a separate product/API surface from HeyGen's other endpoints.
    const tokenRes = await fetch('https://api.liveavatar.com/v1/sessions/token', {
      method: 'POST',
      headers: {
        'X-API-KEY': HEYGEN_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mode: 'LITE',
        avatar_id: HEYGEN_AVATAR_ID,
        avatar_persona: {
          voice_id: HEYGEN_VOICE_ID,
          language: 'en'
        },
        is_sandbox: process.env.HEYGEN_SANDBOX !== 'false' // default to sandbox (no credit usage) unless explicitly disabled
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('[webchat-video] HeyGen token error:', JSON.stringify(tokenData).slice(0, 300));
      return res.status(502).json({ error: 'Failed to create HeyGen session token', detail: tokenData });
    }
    // Response shape is { data: { session_token: "..." } }
    res.json({
      token: tokenData.data?.session_token,
      avatar_id: HEYGEN_AVATAR_ID,
      voice_id: HEYGEN_VOICE_ID
    });
  } catch (e) {
    console.error('[webchat-video] token proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat-bridge', async (req, res) => {
  const { text, session_id, user_email } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!session_id) return res.status(400).json({ error: 'session_id required' });

  if (!sessions[session_id]) sessions[session_id] = { createdAt: Date.now() };

  try {
    const rachelRes = await fetch(`${RACHEL_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        session_id: `video-${session_id}`,
        format: 'plain',
        context: {
          user_email: user_email || ''
        }
      })
    });
    const rachelData = await rachelRes.json();
    if (!rachelRes.ok) {
      console.error('[webchat-video] Rachel /chat error:', JSON.stringify(rachelData).slice(0, 300));
      return res.status(502).json({ error: 'Rachel backend error', detail: rachelData });
    }
    res.json({ reply: rachelData.text || rachelData.response || '' });
  } catch (e) {
    console.error('[webchat-video] chat-bridge error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/greeting', async (req, res) => {
  const { session_id, user_email } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  if (!sessions[session_id]) sessions[session_id] = { createdAt: Date.now() };

  try {
    const rachelRes = await fetch(`${RACHEL_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '__greeting__',
        session_id: `video-${session_id}`,
        format: 'plain',
        context: { user_email: user_email || '' }
      })
    });
    const rachelData = await rachelRes.json();
    res.json({ reply: rachelData.text || rachelData.response || '' });
  } catch (e) {
    console.error('[webchat-video] greeting error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Text-to-speech ───────────────────────────────────────────────────────────
// LiveAvatar's LITE mode explicitly blocks the AVATAR_SPEAK_TEXT/AVATAR_SPEAK_RESPONSE
// commands (confirmed by inspecting the SDK bundle directly) — only AVATAR_SPEAK_AUDIO
// is permitted, meaning we must synthesize speech ourselves and hand the avatar raw
// audio (repeatAudio), not text (repeat/message). OpenAI's TTS API with
// response_format=pcm outputs exactly the 24kHz raw PCM the avatar SDK expects.
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: 'nova',
        input: text,
        response_format: 'pcm' // 24kHz, 16-bit, mono, raw PCM — matches LiveAvatar's expected input
      })
    });
    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      console.error('[webchat-video] OpenAI TTS error:', errText.slice(0, 300));
      return res.status(502).json({ error: 'TTS generation failed', detail: errText.slice(0, 300) });
    }
    const audioBuffer = await ttsRes.buffer();
    const base64Audio = audioBuffer.toString('base64');
    res.json({ audio: base64Audio });
  } catch (e) {
    console.error('[webchat-video] tts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`[webchat-video] listening on http://127.0.0.1:${PORT}`);
  console.log(`[webchat-video] bridging to Rachel at ${RACHEL_URL}`);
});

// HTTPS listener — required for microphone access in the browser (mic APIs are
// blocked on plain HTTP except localhost). Self-signed cert for prototype testing;
// browsers will show a one-time trust warning to click through.
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
  https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
    console.log(`[webchat-video] HTTPS listening on https://0.0.0.0:${HTTPS_PORT} (self-signed cert)`);
  });
} else {
  console.warn('[webchat-video] No cert found at certs/cert.pem — HTTPS listener not started.');
}
