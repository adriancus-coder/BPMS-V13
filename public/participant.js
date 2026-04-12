const socket = io();
const $ = (id) => document.getElementById(id);

const langNames = {
  ro: 'Română',
  no: 'Norvegiană',
  ru: 'Rusă',
  uk: 'Ucraineană',
  en: 'Engleză',
  es: 'Spaniolă'
};

const voiceLocales = {
  ro: 'ro-RO',
  no: 'nb-NO',
  ru: 'ru-RU',
  uk: 'uk-UA',
  en: 'en-US',
  es: 'es-ES'
};

function getOrCreateParticipantId() {
  const key = 'bpms_participant_id';
  let id = localStorage.getItem(key);

  if (!id) {
    id =
      (window.crypto?.randomUUID?.() || `p_${Math.random().toString(36).slice(2)}_${Date.now()}`);
    localStorage.setItem(key, id);
  }

  return id;
}

const state = {
  fixedEventId: new URLSearchParams(window.location.search).get('event') || '',
  currentEvent: null,
  currentLanguage: 'no',
  lastLiveEntryId: null,
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false,
  languageInitialized: false,
  participantId: getOrCreateParticipantId()
};

function setStatus(text) {
  const el = $('participantStatus');
  if (el) el.textContent = text;
}

function setParticipantUpdating(show) {
  const badge = $('participantUpdatingBadge');
  if (!badge) return;
  badge.style.display = show ? 'block' : 'none';
}

function sortEntries(entries = []) {
  return [...entries].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function getEntryById(entryId) {
  return (state.currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}

function getLatestEntry() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  return entries.length ? entries[entries.length - 1] : null;
}

function getTextForEntry(entry) {
  if (!entry) return '';
  return entry.translations?.[state.currentLanguage] || entry.original || '';
}

function detectPreferredSupportedLanguage(available = []) {
  const candidates = [...(navigator.languages || []), navigator.language].filter(Boolean);

  for (const raw of candidates) {
    const code = String(raw).toLowerCase();

    if ((code.startsWith('nb') || code.startsWith('nn') || code.startsWith('no')) && available.includes('no')) return 'no';
    if (code.startsWith('ro') && available.includes('ro')) return 'ro';
    if (code.startsWith('ru') && available.includes('ru')) return 'ru';
    if (code.startsWith('uk') && available.includes('uk')) return 'uk';
    if (code.startsWith('en') && available.includes('en')) return 'en';
    if (code.startsWith('es') && available.includes('es')) return 'es';
  }

  return available[0] || 'en';
}

function syncLanguageOptions(event) {
  const select = $('languageSelect');
  if (!select) return;

  const available = Array.from(new Set(event?.targetLangs || []));

  Array.from(select.options).forEach((option) => {
    const enabled = available.includes(option.value);
    option.disabled = !enabled;
    option.hidden = !enabled;
  });

  if (!state.languageInitialized) {
    select.value = detectPreferredSupportedLanguage(available);
    state.languageInitialized = true;
  }

  if (!available.includes(select.value)) {
    const firstAvailable = Array.from(select.options).find((opt) => !opt.disabled);
    if (firstAvailable) {
      select.value = firstAvailable.value;
    }
  }

  state.currentLanguage = select.value;
}

function updateTopMeta() {
  if (!state.currentEvent) return;

  const nameEl = $('participantEventName');
  const metaEl = $('participantEventMeta');

  if (nameEl) {
    nameEl.textContent = state.currentEvent.name || 'Eveniment live';
  }

  if (metaEl) {
    const sourceName = langNames[state.currentEvent.sourceLang] || state.currentEvent.sourceLang?.toUpperCase() || '-';
    const targetName = langNames[state.currentLanguage] || state.currentLanguage.toUpperCase();
    metaEl.textContent = `Intrare: ${sourceName} · Traducere: ${targetName}`;
  }
}

function stopSpeech() {
  try {
    window.speechSynthesis?.cancel();
  } catch (_) {}
}

function getVoiceForCurrentLanguage() {
  const locale = voiceLocales[state.currentLanguage] || 'en-US';
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const voice = voices.find((v) =>
    (v.lang || '').toLowerCase().startsWith(locale.toLowerCase().split('-')[0])
  );
  return { locale, voice: voice || null };
}

function speakLatestEntry(entry) {
  if (!entry) return;
  if (!state.localAudioEnabled) return;
  if (state.serverAudioMuted) return;

  const text = String(getTextForEntry(entry) || '').trim();
  if (!text) return;

  stopSpeech();

  try {
    const utter = new SpeechSynthesisUtterance(text);
    const { locale, voice } = getVoiceForCurrentLanguage();
    utter.lang = locale;
    if (voice) utter.voice = voice;
    utter.rate = 1;
    utter.pitch = 1;
    window.speechSynthesis?.speak(utter);
  } catch (_) {}
}

function renderLiveView({ announce = false } = {}) {
  if (!state.currentEvent) return;

  const latestEntry = getLatestEntry();
  state.lastLiveEntryId = latestEntry?.id || null;

  const lastTextEl = $('lastText');
  if (lastTextEl) {
    lastTextEl.textContent = latestEntry ? getTextForEntry(latestEntry) : 'Aștept traducerea...';
  }

  updateTopMeta();

  if (announce && latestEntry && latestEntry.id !== state.lastSpokenEntryId) {
    state.lastSpokenEntryId = latestEntry.id;
    speakLatestEntry(latestEntry);
  }
}

function updateEntryInState(payload) {
  if (!state.currentEvent) return;

  const entry = getEntryById(payload.entryId);
  if (!entry) return;

  entry.sourceLang = payload.sourceLang;
  entry.original = payload.original;
  entry.translations = payload.translations || {};
  entry.edited = true;
}

function handleLanguageChange() {
  const select = $('languageSelect');
  if (!select) return;

  state.currentLanguage = select.value;

  if (state.currentEvent?.id) {
    socket.emit('participant_language', {
      eventId: state.currentEvent.id,
      language: state.currentLanguage
    });
  }

  renderLiveView({ announce: false });
}

async function resolveEventId() {
  if (state.fixedEventId) return state.fixedEventId;

  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event?.id) return data.event.id;
  } catch (_) {}

  return '';
}

async function joinParticipantEvent() {
  const eventId = await resolveEventId();
  if (!eventId) {
    setStatus('Nu există eveniment activ.');
    return;
  }

  socket.emit('join_event', {
    eventId,
    role: 'participant',
    language: $('languageSelect')?.value || state.currentLanguage,
    participantId: state.participantId
  });
}

socket.on('connect', async () => {
  setStatus('Conectare...');
  await joinParticipantEvent();
});

socket.on('disconnect', () => {
  setStatus('Reconectare...');
});

socket.on('join_error', ({ message }) => {
  setStatus(message || 'Nu mă pot conecta la eveniment.');
});

socket.on('joined_event', ({ event, role }) => {
  if (role !== 'participant') return;

  state.currentEvent = event;
  state.serverAudioMuted = !!event.audioMuted;

  syncLanguageOptions(event);
  renderLiveView({ announce: false });
  setParticipantUpdating(false);

  if (state.serverAudioMuted) {
    setStatus('Audio oprit de admin.');
  } else {
    setStatus('Conectat la eveniment.');
  }
});

socket.on('transcript_entry', (entry) => {
  if (!state.currentEvent) return;

  state.currentEvent.transcripts = state.currentEvent.transcripts || [];

  const exists = getEntryById(entry.id);
  if (!exists) {
    state.currentEvent.transcripts.push(entry);
  }

  setParticipantUpdating(false);
  renderLiveView({ announce: true });
});

socket.on('transcript_source_updated', (payload) => {
  if (!state.currentEvent) return;

  updateEntryInState(payload);
  setParticipantUpdating(false);

  if (payload.entryId === state.lastLiveEntryId) {
    renderLiveView({ announce: false });
  }
});

socket.on('entry_refreshing', ({ entryId }) => {
  if (entryId && entryId === state.lastLiveEntryId) {
    setParticipantUpdating(true);
  }
});

socket.on('entry_refresh_failed', ({ entryId }) => {
  if (entryId && entryId === state.lastLiveEntryId) {
    setParticipantUpdating(false);
  }
});

socket.on('audio_state', ({ audioMuted }) => {
  state.serverAudioMuted = !!audioMuted;

  if (state.serverAudioMuted) {
    stopSpeech();
    setStatus('Audio oprit de admin.');
  } else {
    setStatus(state.localAudioEnabled ? 'Audio activ.' : 'Audio local în pauză.');
  }
});

socket.on('active_event_changed', async () => {
  if (!state.fixedEventId) {
    await joinParticipantEvent();
  }
});

$('languageSelect')?.addEventListener('change', handleLanguageChange);

$('playAudioBtn')?.addEventListener('click', () => {
  state.localAudioEnabled = true;
  setStatus(state.serverAudioMuted ? 'Audio oprit de admin.' : 'Audio local activ.');

  const latestEntry = getLatestEntry();
  if (latestEntry) {
    speakLatestEntry(latestEntry);
  }
});

$('pauseAudioBtn')?.addEventListener('click', () => {
  state.localAudioEnabled = false;
  stopSpeech();
  setStatus('Audio local în pauză.');
});

try {
  window.speechSynthesis?.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {};
} catch (_) {}