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

const state = {
  fixedEventId: new URLSearchParams(window.location.search).get('event') || '',
  currentEvent: null,
  currentLanguage: 'no',
  currentLiveEntryId: null,
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false
};

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setStatus(text) {
  $('participantStatus').textContent = text;
}

function setParticipantUpdating(show) {
  const badge = $('participantUpdatingBadge');
  if (!badge) return;
  badge.style.display = show ? 'block' : 'none';
}

function getHistoryElement() {
  return $('history');
}

function isHistoryNearBottom() {
  const el = getHistoryElement();
  if (!el) return true;
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
}

function scrollHistoryToBottom() {
  const el = getHistoryElement();
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function sortEntries(entries = []) {
  return [...entries].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function getTextForEntry(entry) {
  if (!entry) return '';
  return entry.translations?.[state.currentLanguage] || entry.original || '';
}

function getVoiceForCurrentLanguage() {
  const locale = voiceLocales[state.currentLanguage] || 'en-US';
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  const voice = voices.find((v) => (v.lang || '').toLowerCase().startsWith(locale.toLowerCase().split('-')[0]));
  return { locale, voice: voice || null };
}

function stopSpeech() {
  try {
    window.speechSynthesis?.cancel();
  } catch (_) {}
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

function updateTopMeta() {
  if (!state.currentEvent) return;

  $('participantEventName').textContent = state.currentEvent.name || 'Eveniment live';

  const sourceName = langNames[state.currentEvent.sourceLang] || state.currentEvent.sourceLang?.toUpperCase() || '-';
  const targetName = langNames[state.currentLanguage] || state.currentLanguage.toUpperCase();

  $('participantEventMeta').textContent = `Intrare: ${sourceName} · Traducere: ${targetName}`;
}

function syncLanguageOptions(event) {
  const select = $('languageSelect');
  const available = new Set(event?.targetLangs || []);

  Array.from(select.options).forEach((option) => {
    const enabled = available.has(option.value);
    option.disabled = !enabled;
    option.hidden = !enabled;
  });

  if (!available.has(select.value)) {
    const firstAvailable = Array.from(select.options).find((opt) => !opt.disabled);
    if (firstAvailable) {
      select.value = firstAvailable.value;
    }
  }

  state.currentLanguage = select.value;
}

function updateEntryInState(payload) {
  if (!state.currentEvent) return;

  const entry = (state.currentEvent.transcripts || []).find((x) => x.id === payload.entryId);
  if (!entry) return;

  entry.sourceLang = payload.sourceLang;
  entry.original = payload.original;
  entry.translations = payload.translations || {};
  entry.edited = true;
}

function renderParticipantView({ announce = false } = {}) {
  if (!state.currentEvent) return;

  const historyEl = getHistoryElement();
  const wasNearBottom = isHistoryNearBottom();
  const prevScrollTop = historyEl ? historyEl.scrollTop : 0;

  const entries = sortEntries(state.currentEvent.transcripts || []);
  const liveEntry = entries.length ? entries[entries.length - 1] : null;
  state.currentLiveEntryId = liveEntry?.id || null;

  if (historyEl) {
    historyEl.innerHTML = entries.length
      ? entries.map((entry, index) => {
          const isLive = index === entries.length - 1;
          const text = escapeHtml(getTextForEntry(entry));

          return `
            <div class="history-item${isLive ? ' live-current' : ''}" data-entry-id="${entry.id}">
              ${isLive ? '<div class="history-live-label">Live acum</div>' : ''}
              <div class="history-text">${text}</div>
            </div>
          `;
        }).join('')
      : `<div class="small">Aștept traducerea...</div>`;
  }

  if (historyEl) {
    if (wasNearBottom) {
      scrollHistoryToBottom();
    } else {
      historyEl.scrollTop = prevScrollTop;
    }
  }

  updateTopMeta();

  if (announce && liveEntry && liveEntry.id !== state.lastSpokenEntryId) {
    state.lastSpokenEntryId = liveEntry.id;
    speakLatestEntry(liveEntry);
  }
}

function handleLanguageChange() {
  state.currentLanguage = $('languageSelect').value;

  if (state.currentEvent?.id) {
    socket.emit('participant_language', {
      eventId: state.currentEvent.id,
      language: state.currentLanguage
    });
  }

  renderParticipantView({ announce: false });
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
    language: $('languageSelect').value
  });
}

socket.on('connect', async () => {
  setStatus('Conectat.');
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
  updateTopMeta();
  renderParticipantView({ announce: false });
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
  state.currentEvent.transcripts.push(entry);

  setParticipantUpdating(false);
  renderParticipantView({ announce: true });
});

socket.on('transcript_source_updated', (payload) => {
  if (!state.currentEvent) return;

  updateEntryInState(payload);
  setParticipantUpdating(false);
  renderParticipantView({ announce: false });
});

socket.on('entry_refreshing', ({ entryId }) => {
  if (entryId && entryId === state.currentLiveEntryId) {
    setParticipantUpdating(true);
  }
});

socket.on('entry_refresh_failed', ({ entryId }) => {
  if (entryId && entryId === state.currentLiveEntryId) {
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

$('languageSelect').addEventListener('change', handleLanguageChange);

$('playAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = true;
  setStatus(state.serverAudioMuted ? 'Audio oprit de admin.' : 'Audio local activ.');
  const entries = sortEntries(state.currentEvent?.transcripts || []);
  const liveEntry = entries.length ? entries[entries.length - 1] : null;
  if (liveEntry) {
    speakLatestEntry(liveEntry);
  }
});

$('pauseAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = false;
  stopSpeech();
  setStatus('Audio local în pauză.');
});

try {
  window.speechSynthesis?.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {};
} catch (_) {}
