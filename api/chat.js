import fs from 'fs';
import path from 'path';

const SYSTEM_PROMPT =
  'You are SpeakUp, a patient English tutor for Tamil-speaking beginners. ' +
  'Your name is SpeakUp. If asked your name, introduce yourself as SpeakUp. ' +
  'Respond only in simple English. Keep sentences short for text-to-speech. ' +
  'Use the HTML format given in the user message.';

// ── Storage helpers ────────────────────────────────────────────────────────

function getDataPath() {
  const dir = process.env.DATA_DIR || '/tmp/speakup';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'conversations.json');
}

function loadConversations() {
  const file = getDataPath();
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function saveConversation(entry) {
  const file = getDataPath();
  const all = loadConversations();
  all.push(entry);
  fs.writeFileSync(file, JSON.stringify(all.slice(-10000), null, 2));
}

// ── Gemini format helpers ──────────────────────────────────────────────────

// Convert [{role:'user',content:'...'}, ...] → Gemini contents array
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

// ── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured. Set GEMINI_API_KEY.' });
  }

  const { messages, sessionId } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: toGeminiContents(messages),
        generationConfig: { maxOutputTokens: 1000 },
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Gemini API', detail: err.message });
  }

  const data = await geminiRes.json();

  if (!geminiRes.ok) {
    const errMsg = data?.error?.message || 'Gemini API error';
    // Surface quota/rate-limit errors with retry guidance
    if (geminiRes.status === 429) {
      const retryMatch = errMsg.match(/retry in ([0-9.]+)s/i);
      const retryAfter = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;
      return res.status(429).json({ error: 'API quota exceeded.', retryAfter });
    }
    return res.status(geminiRes.status).json({ error: errMsg });
  }

  // Extract text from Gemini response
  const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // ── Persist conversation ─────────────────────────────────────────────────
  try {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    saveConversation({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sessionId || 'anonymous',
      timestamp: new Date().toISOString(),
      userAgent: req.headers['user-agent'] || '',
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '',
      userMessage: lastUserMsg?.content || '',
      aiReply,
      totalTurns: messages.length,
    });
  } catch (logErr) {
    console.error('Conversation logging failed:', logErr.message);
  }

  // Return in a consistent shape the frontend already understands
  return res.status(200).json({ content: [{ text: aiReply }] });
}
