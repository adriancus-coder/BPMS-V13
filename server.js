const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

console.log('API KEY:', OPENAI_API_KEY ? 'OK' : 'LIPSA');
const client = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/participant.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/participant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'participant.html')));
app.get('/moderator.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'moderator.html')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'sessions.json');

const LANGUAGES = {
  ro: 'Romanian',
  no: 'Norwegian',
  ru: 'Russian',
  uk: 'Ukrainian',
  en: 'English',
  es: 'Spanish'
};

const LANGUAGE_NAMES_RO = {
  ro: 'Română',
  no: 'Norvegiană',
  ru: 'Rusă',
  uk: 'Ucraineană',
  en: 'Engleză',
  es: 'Spaniolă'
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultDb() {
  return { events: {}, globalMemory: {}, activeEventId: null };
}

function loadDb() {
  try {
    ensureDataDir();
    if (!fs.existsSync(DB_FILE)) {
      const initialDb = defaultDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf8');
      return initialDb;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('loadDb error:', err);
    return defaultDb();
  }
}

const db = loadDb();
const speechBuffers = new Map();

const BUFFER_CONNECTORS = new Set([
  'și', 'si', 'să', 'sa', 'că', 'ca', 'dar', 'iar', 'ori', 'sau',
  'de', 'la', 'în', 'in', 'cu', 'pe', 'din', 'spre', 'pentru',
  'când', 'cand', 'care', 'ce', 'către', 'catre',
  'og', 'at', 'men', 'som', 'i', 'på', 'med', 'til', 'for'
]);

function normalizeBufferedText(text) {
  return String(text || '')
    .replace(/\s*\.\.\.\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastWord(text) {
  const parts = normalizeBufferedText(text).split(' ').filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase();
}

function wordCount(text) {
  return normalizeBufferedText(text).split(' ').filter(Boolean).length;
}

function looksComplete(text) {
  const clean = normalizeBufferedText(text);
  if (!clean) return false;

  const last = lastWord(clean);
  const words = wordCount(clean);

  if (/[.!?…:]$/.test(clean) && words >= 4) return true;
  if (words >= 12 && !BUFFER_CONNECTORS.has(last)) return true;

  return false;
}

async function emitBufferedTranscript(event, original) {
  const clean = normalizeBufferedText(original);
  if (!clean) return;

  const translationPairs = await Promise.all(
    (event.targetLangs || []).map(async (lang) => {
      const translated = await translateText(clean, lang, event);
      return [lang, translated];
    })
  );

  const entry = {
    id: randomUUID(),
    original: clean,
    sourceLang: event.sourceLang || 'ro',
    translations: Object.fromEntries(translationPairs),
    edited: false,
    createdAt: new Date().toISOString()
  };

  event.transcripts = event.transcripts || [];
  event.transcripts.push(entry);

  if (event.transcripts.length > 200) {
    event.transcripts = event.transcripts.slice(-200);
  }

  saveDb();
  io.to(`event:${event.id}`).emit('transcript_entry', entry);
}

async function flushSpeechBuffer(eventId) {
  const state = speechBuffers.get(eventId);
  if (!state) return;

  if (state.timer) clearTimeout(state.timer);
  speechBuffers.delete(eventId);

  const text = normalizeBufferedText(state.text);
  if (!text) return;

  const event = db.events[eventId];
  if (!event) return;

  await emitBufferedTranscript(event, text);
}

function queueSpeechText(eventId, incomingText) {
  const cleanIncoming = normalizeBufferedText(incomingText);
  if (!cleanIncoming) return;

  const prev = speechBuffers.get(eventId) || { text: '', timer: null };
  const merged = normalizeBufferedText([prev.text, cleanIncoming].filter(Boolean).join(' '));

  if (prev.timer) clearTimeout(prev.timer);

  const next = { text: merged, timer: null };
  speechBuffers.set(eventId, next);

  if (looksComplete(merged)) {
    flushSpeechBuffer(eventId).catch(console.error);
    return;
  }

  next.timer = setTimeout(() => {
    flushSpeechBuffer(eventId).catch(console.error);
  }, 1400);
}
function saveDb() {
  try {
    ensureDataDir();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('saveDb error:', err);
  }
}


const speechBuffers = new Map();

function summarizeEvent(event) {
  return {
    id: event.id,
    name: event.name,
    createdAt: event.createdAt || null,
    scheduledAt: event.scheduledAt || null,
    sourceLang: event.sourceLang || 'ro',
    targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
    transcriptCount: Array.isArray(event.transcripts) ? event.transcripts.length : 0,
    isActive: db.activeEventId === event.id,
    participantLink: event.participantLink || '',
    qrCodeDataUrl: event.qrCodeDataUrl || ''
  };
}

function sanitizeTranscriptText(text) {
  return String(text || '')
    .replace(/…/g, '')
    .replace(/\.\.\.+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function mergeTranscriptText(prevText, nextText) {
  const prev = sanitizeTranscriptText(prevText);
  const next = sanitizeTranscriptText(nextText);
  if (!prev) return next;
  if (!next) return prev;

  const prevNorm = normalizeChunkText(prev);
  const nextNorm = normalizeChunkText(next);

  if (!prevNorm) return next;
  if (!nextNorm) return prev;
  if (prevNorm === nextNorm) return prev;
  if (nextNorm.startsWith(prevNorm)) return next;
  if (prevNorm.startsWith(nextNorm)) return prev;
  if (prevNorm.endsWith(nextNorm)) return prev;
  if (nextNorm.endsWith(prevNorm)) return next;

  return `${prev} ${next}`.replace(/\s+/g, ' ').trim();
}

function shouldFlushBufferedText(text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return false;
  if (/[.!?]$/.test(clean)) return true;
  if (countWords(clean) >= 14) return true;
  return false;
}

async function flushSpeechBuffer(eventId, force = false) {
  const buffered = speechBuffers.get(eventId);
  if (!buffered) return null;

  if (buffered.timer) clearTimeout(buffered.timer);
  speechBuffers.delete(eventId);

  const event = db.events[eventId];
  if (!event) return null;

  const text = sanitizeTranscriptText(buffered.text);
  if (!text) return null;

  return processText(event, text, { force });
}

function queueSpeechText(eventId, text) {
  const clean = sanitizeTranscriptText(text);
  if (!clean) return;

  const prev = speechBuffers.get(eventId) || { text: '', timer: null };
  const merged = mergeTranscriptText(prev.text, clean);

  if (prev.timer) clearTimeout(prev.timer);

  const next = { text: merged, timer: null };
  speechBuffers.set(eventId, next);

  if (shouldFlushBufferedText(merged)) {
    flushSpeechBuffer(eventId, true).catch(console.error);
    return;
  }

  next.timer = setTimeout(() => {
    flushSpeechBuffer(eventId, true).catch(console.error);
  }, 1800);
}

function normalizeEvent(event) {
  return {
    id: event.id,
    name: event.name,
    sourceLang: event.sourceLang || 'ro',
    targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : ['no', 'en'],
    speed: event.speed || 'balanced',
    adminCode: event.adminCode,
    participantLink: event.participantLink,
    qrCodeDataUrl: event.qrCodeDataUrl || '',
    transcripts: Array.isArray(event.transcripts) ? event.transcripts : [],
    glossary: event.glossary || {},
    audioMuted: !!event.audioMuted,
    audioVolume: typeof event.audioVolume === 'number' ? event.audioVolume : 70,
    createdAt: event.createdAt || new Date().toISOString(),
    scheduledAt: event.scheduledAt || null,
    isActive: db.activeEventId === event.id
  };
}

async function createEvent({ name, speed, sourceLang, targetLangs, baseUrl, scheduledAt }) {
  const id = randomUUID();
  const adminCode = `BPMS-ADMIN-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const participantLink = `${baseUrl}/participant?event=${id}`;
  const qrCodeDataUrl = await QRCode.toDataURL(participantLink);

  const event = {
    id,
    name: name || 'Eveniment nou',
    sourceLang: sourceLang || 'ro',
    targetLangs: targetLangs?.length ? targetLangs : ['no', 'en'],
    speed: speed || 'balanced',
    scheduledAt: scheduledAt || null,
    adminCode,
    participantLink,
    qrCodeDataUrl,
    transcripts: [],
    glossary: {},
    audioMuted: false,
    audioVolume: 70,
    createdAt: new Date().toISOString(),
    lastTranscriptNorm: ''
  };

  db.events[id] = event;
  db.activeEventId = id;
  saveDb();
  setImmediate(() => io.emit('active_event_changed', { eventId: id }));
  return normalizeEvent(event);
}

function getGlossaryForLang(langCode, event) {
  const langMemory = {};
  for (const [key, value] of Object.entries(db.globalMemory || {})) {
    const prefix = `${langCode.toUpperCase()}::`;
    if (key.startsWith(prefix)) langMemory[key.slice(prefix.length)] = value;
  }
  return { ...langMemory, ...(event.glossary?.[langCode] || {}) };
}

function applyGlossary(text, glossary) {
  let out = text;
  for (const [key, value] of Object.entries(glossary || {})) {
    if (!key || !value) continue;
    const safe = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(safe, 'gi'), value);
  }
  return out;
}

function buildPrompt(sourceLangName, targetLangName, speed, glossary) {
  const speedRules = {
    rapid: 'Translate fast, naturally, and as spoken language.',
    balanced: 'Translate naturally, smoothly, and clearly for live listening.',
    clear: 'Translate carefully and clearly for church live listening. Keep it fluid, not rigid.'
  };

  const glossaryText = Object.entries(glossary || {})
    .filter(([a, b]) => a && b)
    .map(([a, b]) => `- ${a} => ${b}`)
    .join('\n');

  return [
    'You are a live interpreter for church services.',
    `Translate from ${sourceLangName} to ${targetLangName}.`,
    'Return only the translation.',
    'Translate naturally, smoothly, and conversationally.',
    'Do not translate too literally.',
    speedRules[speed] || speedRules.balanced,
    glossaryText ? `Use these glossary replacements exactly:\n${glossaryText}` : ''
  ].filter(Boolean).join('\n\n');
}

async function translateText(text, langCode, event) {
  const glossary = getGlossaryForLang(langCode, event);
  const prepared = applyGlossary(text, glossary);
  if (!client) return `[${langCode}] ${prepared}`;

  try {
    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: 'system',
          content: buildPrompt(
            LANGUAGES[event.sourceLang] || event.sourceLang,
            LANGUAGES[langCode] || langCode,
            event.speed,
            glossary
          )
        },
        { role: 'user', content: prepared }
      ]
    });

    return (response.output_text || '').trim() || prepared;
  } catch (err) {
    console.error(`translate error ${langCode}:`, err?.message || err);
    return `[${langCode}] ${prepared}`;
  }
}

async function transcribeAudioFile(filePath, event) {
  if (!client) return '';
  const result = await client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: OPENAI_TRANSCRIBE_MODEL,
    language: event.sourceLang || 'ro',
    response_format: 'json'
  });
  return String(result?.text || '').trim();
}

function normalizeChunkText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/g, '')
    .toLowerCase();
}

async function processText(event, cleanText, { force = false } = {}) {
  const normalized = normalizeChunkText(cleanText);
  if (!normalized || normalized.length < 2) return null;
  if (!force && normalized === event.lastTranscriptNorm) return null;

  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => [lang, await translateText(cleanText, lang, event)])
  );

  const entry = {
    id: randomUUID(),
    sourceLang: event.sourceLang,
    original: cleanText,
    translations: Object.fromEntries(translationPairs),
    createdAt: new Date().toISOString(),
    edited: false
  };

  event.lastTranscriptNorm = normalized;
  event.transcripts.push(entry);
  if (event.transcripts.length > 300) event.transcripts = event.transcripts.slice(-300);
  saveDb();
  io.to(`event:${event.id}`).emit('transcript_entry', entry);
  return entry;
}

async function retranslateEntry(event, entry) {
  const translationPairs = await Promise.all(
    event.targetLangs.map(async (lang) => [lang, await translateText(entry.original, lang, event)])
  );
  entry.translations = Object.fromEntries(translationPairs);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, openaiConfigured: !!OPENAI_API_KEY, model: OPENAI_MODEL, transcribeModel: OPENAI_TRANSCRIBE_MODEL });
});

app.post('/api/events', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const event = await createEvent({
      name: req.body.name,
      speed: req.body.speed,
      sourceLang: req.body.sourceLang || 'ro',
      targetLangs: req.body.targetLangs || ['no', 'en'],
      baseUrl,
      scheduledAt: req.body.scheduledAt || null
    });
    res.json({ ok: true, event });
  } catch (err) {
    console.error('create event error:', err);
    res.status(500).json({ ok: false, error: 'Nu am putut crea evenimentul.' });
  }
});

app.get('/api/events/active', (req, res) => {
  const activeEventId = db.activeEventId;
  const event = activeEventId ? db.events[activeEventId] : null;
  if (!event) return res.status(404).json({ ok: false, error: 'Nu există eveniment activ.' });
  res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO });
});

app.get('/api/events', (req, res) => {
  const events = Object.values(db.events || {})
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map(summarizeEvent);
  res.json({ ok: true, events, activeEventId: db.activeEventId || null, languageNames: LANGUAGE_NAMES_RO });
});

app.get('/api/events/:id', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO });
});

app.post('/api/events/:id/activate', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  db.activeEventId = event.id;
  saveDb();
  io.emit('active_event_changed', { eventId: event.id });
  res.json({ ok: true, event: normalizeEvent(event) });
});

app.delete('/api/events/:id', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });

  delete db.events[req.params.id];
  speechBuffers.delete(req.params.id);

  if (db.activeEventId === req.params.id) {
    const remaining = Object.values(db.events).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    db.activeEventId = remaining[0]?.id || null;
  }

  saveDb();
  io.emit('active_event_changed', { eventId: db.activeEventId || null });
  res.json({ ok: true, activeEventId: db.activeEventId || null });
});


app.post('/api/events/:id/glossary', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  const source = String(req.body.source || '').trim();
  const target = String(req.body.target || '').trim();
  const permanent = !!req.body.permanent;
  if (!source || !target) return res.status(400).json({ ok: false, error: 'Date lipsă.' });
  const lang = String(req.body.lang || '').trim();
  if (!lang) return res.status(400).json({ ok: false, error: 'Limbă lipsă.' });
  event.glossary[lang] = event.glossary[lang] || {};
  event.glossary[lang][source] = target;
  if (permanent) db.globalMemory[`${lang.toUpperCase()}::${source}`] = target;
  saveDb();
  io.to(`event:${event.id}`).emit('glossary_updated', { source, target, permanent });
  res.json({ ok: true });
});

app.post('/api/events/:id/audio', (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (typeof req.body.audioMuted === 'boolean') event.audioMuted = req.body.audioMuted;
  if (typeof req.body.audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, req.body.audioVolume));
  saveDb();
  io.to(`event:${event.id}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
  res.json({ ok: true, event: normalizeEvent(event) });
});

app.post('/api/events/:id/transcribe', upload.single('audio'), async (req, res) => {
  const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (String(req.body.code || '') !== String(event.adminCode || '')) {
    return res.status(403).json({ ok: false, error: 'Cod Admin invalid.' });
  }
  if (!client) return res.status(400).json({ ok: false, error: 'OpenAI nu este configurat.' });
  if (!req.file || !req.file.buffer?.length) {
    return res.status(400).json({ ok: false, error: 'Audio lipsă.' });
  }

  const mimeType = String(req.file.mimetype || 'audio/webm');
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'webm';
  const tempPath = path.join(os.tmpdir(), `bpms-${randomUUID()}.${ext}`);

  try {
    fs.writeFileSync(tempPath, req.file.buffer);
    const transcript = sanitizeTranscriptText(await transcribeAudioFile(tempPath, event));
    if (!transcript) return res.json({ ok: true, skipped: true });
    queueSpeechText(event.id, transcript);
    return res.json({ ok: true, text: transcript, buffered: true });
  } catch (err) {
    console.error('transcribe error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Nu am putut transcrie audio.' });
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
});

io.on('connection', (socket) => {
  socket.on('join_event', ({ eventId, role, code, language }) => {
    const event = db.events[eventId];
    if (!event) return socket.emit('join_error', { message: 'Evenimentul nu există.' });
    if (role === 'admin' && code !== event.adminCode) {
      return socket.emit('join_error', { message: 'Cod Admin invalid.' });
    }

    socket.data.eventId = eventId;
    socket.data.role = role || 'participant';
    socket.data.language = language || event.targetLangs[0] || 'no';
    socket.join(`event:${eventId}`);

    if (socket.data.role === 'participant') {
      socket.join(`event:${eventId}:lang:${socket.data.language}`);
    }

    socket.emit('joined_event', {
      ok: true,
      role: socket.data.role,
      event: normalizeEvent(event),
      languageNames: LANGUAGE_NAMES_RO
    });
  });

  socket.on('participant_language', ({ eventId, language }) => {
    const oldLanguage = socket.data.language;
    if (oldLanguage) socket.leave(`event:${eventId}:lang:${oldLanguage}`);
    socket.data.language = language;
    socket.join(`event:${eventId}:lang:${language}`);
  });

  socket.on('submit_text', async ({ eventId, text }) => {
    const event = db.events[eventId];
    if (!event) return socket.emit('server_error', { message: 'Eveniment inexistent.' });
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    try {
      await processText(event, cleanText);
    } catch (err) {
      console.error('submit_text error:', err);
      socket.emit('server_error', { message: 'Eroare la traducere.' });
    }
  });

  socket.on('admin_update_source', async ({ eventId, entryId, sourceText }) => {
    const event = db.events[eventId];
    if (!event) return;
    const entry = event.transcripts.find((x) => x.id === entryId);
    if (!entry) return;
    const cleanSource = String(sourceText || '').trim();
    if (!cleanSource) return;
    entry.sourceLang = event.sourceLang || 'ro';
    entry.original = cleanSource;
    entry.edited = true;
    try {
      await retranslateEntry(event, entry);
      saveDb();
      io.to(`event:${eventId}`).emit('transcript_source_updated', {
        entryId,
        sourceLang: entry.sourceLang,
        original: entry.original,
        translations: entry.translations
      });
    } catch (err) {
      console.error('admin_update_source error:', err);
    }
  });

  socket.on('set_audio_state', ({ eventId, audioMuted, audioVolume, code }) => {
    const event = db.events[eventId];
    if (!event || code !== event.adminCode) return;
    if (typeof audioMuted === 'boolean') event.audioMuted = audioMuted;
    if (typeof audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, audioVolume));
    saveDb();
    io.to(`event:${eventId}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
  });
});

server.listen(PORT, () => console.log(`BPMS app running on ${PORT}`));
