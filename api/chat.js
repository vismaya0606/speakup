import fs from 'fs';
import path from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────

function getDataPath() {
  // On Vercel, use /tmp (ephemeral but functional).
  // Swap this for a DB client (Supabase, Mongo, etc.) when you're ready to scale.
  const dir = process.env.DATA_DIR || '/tmp/speakup';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'conversations.json');
}

function loadConversations() {
  const file = getDataPath();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveConversation(entry) {
  const file = getDataPath();
  const all = loadConversations();
  all.push(entry);
  // Keep last 10,000 conversations max to prevent unbounded growth
  const trimmed = all.slice(-10000);
  fs.writeFileSync(file, JSON.stringify(trimmed, null, 2));
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers — lock this down to your domain in production
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured. Set ANTHROPIC_API_KEY.' });
  }

  const { messages, sessionId, userAgent } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Forward to Anthropic
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system:
          'You are SpeakUp, a patient English tutor for Tamil-speaking beginners. ' +
          'Respond only in simple English. Keep sentences short for text-to-speech. ' +
          'Use the HTML format given in the user message.',
        messages,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Anthropic API', detail: err.message });
  }

  const data = await anthropicRes.json();

  if (!anthropicRes.ok) {
    return res.status(anthropicRes.status).json(data);
  }

  // ── Persist conversation ───────────────────────────────────────────────
  try {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const aiReply = data?.content?.[0]?.text || '';

    saveConversation({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sessionId || 'anonymous',
      timestamp: new Date().toISOString(),
      userAgent: userAgent || req.headers['user-agent'] || '',
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '',
      userMessage: lastUserMsg?.content || '',
      aiReply,
      totalTurns: messages.length,
    });
  } catch (logErr) {
    // Never block the response because of a logging failure
    console.error('Conversation logging failed:', logErr.message);
  }

  return res.status(200).json(data);
}
