import fs from 'fs';
import path from 'path';

// Simple admin endpoint to view / export stored conversations.
// Protect this with a secret token in production.

function getDataPath() {
  const dir = process.env.DATA_DIR || '/tmp/speakup';
  return path.join(dir, 'conversations.json');
}

export default function handler(req, res) {
  // Auth check — set ADMIN_SECRET in your Vercel env vars
  const adminSecret = process.env.ADMIN_SECRET;
  const provided = req.headers['x-admin-secret'] || req.query.secret;

  if (adminSecret && provided !== adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const file = getDataPath();

  if (!fs.existsSync(file)) {
    return res.status(200).json({ total: 0, conversations: [] });
  }

  let all = [];
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return res.status(500).json({ error: 'Could not read data file' });
  }

  // Optional filters via query params: ?sessionId=xxx&from=2024-01-01&limit=100
  const { sessionId, from, limit } = req.query;

  let filtered = all;

  if (sessionId) {
    filtered = filtered.filter((c) => c.sessionId === sessionId);
  }

  if (from) {
    const fromDate = new Date(from);
    filtered = filtered.filter((c) => new Date(c.timestamp) >= fromDate);
  }

  const maxLimit = Math.min(parseInt(limit) || 500, 1000);
  const page = filtered.slice(-maxLimit);

  return res.status(200).json({
    total: all.length,
    returned: page.length,
    conversations: page,
  });
}
