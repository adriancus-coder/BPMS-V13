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

const uiTexts = {
  ro: {
    languageLabel: 'Limba mea',
    play: 'Play audio',
    pause: 'Pause audio',
    flow: 'Flux traducere',
    liveNow: 'Live acum',
    inProgress: 'În lucru',
    updating: 'Se actualizează...',
    connecting: 'Conectare...',
    connected: 'Conectat la eveniment.',
    reconnecting: 'Reconectare...',
    noActiveEvent: 'Nu există eveniment activ.',
    cannotConnect: 'Nu mă pot conecta la eveniment.',
    audioOffByAdmin: 'Audio oprit de admin.',
    audioActive: 'Audio activ.',
    audioPaused: 'Audio local în pauză.',
    waiting: 'Aștept traducerea...',
    eventMeta: (sourceName, targetName) => `Intrare: ${sourceName} · Traducere: ${targetName}`
  },
  no: {
    languageLabel: 'Mitt språk',
    play: 'Spill av lyd',
    pause: 'Pause lyd',
    flow: 'Oversettelsesflyt',
    liveNow: 'Live nå',
    inProgress: 'Pågår',
    updating: 'Oppdateres...',
    connecting: 'Kobler til...',
    connected: 'Koblet til arrangementet.',
    reconnecting: 'Kobler til på nytt...',
    noActiveEvent: 'Ingen aktiv hendelse.',
    cannotConnect: 'Kan ikke koble til arrangementet.',
    audioOffByAdmin: 'Lyd slått av av admin.',
    audioActive: 'Lyd aktiv.',
    audioPaused: 'Lokal lyd satt på pause.',
    waiting: 'Venter på oversettelse...',
    eventMeta: (sourceName, targetName) => `Inngang: ${sourceName} · Oversettelse: ${targetName}`
  },
  en: {
    languageLabel: 'My language',
    play: 'Play audio',
    pause: 'Pause audio',
    flow: 'Translation feed',
    liveNow: 'Live now',
    inProgress: 'In progress',
    updating: 'Updating...',
    connecting: 'Connecting...',
    connected: 'Connected to the event.',
    reconnecting: 'Reconnecting...',
    noActiveEvent: 'No active event.',
    cannotConnect: 'Cannot connect to the event.',
    audioOffByAdmin: 'Audio turned off by admin.',
    audioActive: 'Audio active.',
    audioPaused: 'Local audio paused.',
    waiting: 'Waiting for translation...',
    eventMeta: (sourceName, targetName) => `Input: ${sourceName} · Translation: ${targetName}`
  },
  es: {
    languageLabel: 'Mi idioma',
    play: 'Reproducir audio',
    pause: 'Pausar audio',
    flow: 'Flujo de traducción',
    liveNow: 'En vivo ahora',
    inProgress: 'En curso',
    updating: 'Actualizando...',
    connecting: 'Conectando...',
    connected: 'Conectado al evento.',
    reconnecting: 'Reconectando...',
    noActiveEvent: 'No hay evento activo.',
    cannotConnect: 'No se puede conectar al evento.',
    audioOffByAdmin: 'Audio desactivado por el administrador.',
    audioActive: 'Audio activo.',
    audioPaused: 'Audio local en pausa.',
    waiting: 'Esperando traducción...',
    eventMeta: (sourceName, targetName) => `Entrada: ${sourceName} · Traducción: ${targetName}`
  },
  ru: {
    languageLabel: 'Мой язык',
    play: 'Включить звук',
    pause: 'Пауза',
    flow: 'Поток перевода',
    liveNow: 'Сейчас',
    inProgress: 'В процессе',
    updating: 'Обновляется...',
    connecting: 'Подключение...',
    connected: 'Подключено к событию.',
    reconnecting: 'Переподключение...',
    noActiveEvent: 'Нет активного события.',
    cannotConnect: 'Не удаётся подключиться к событию.',
    audioOffByAdmin: 'Звук отключён администратором.',
    audioActive: 'Звук включён.',
    audioPaused: 'Локальный звук на паузе.',
    waiting: 'Ожидание перевода...',
    eventMeta: (sourceName, targetName) => `Вход: ${sourceName} · Перевод: ${targetName}`
  },
  uk: {
    languageLabel: 'Моя мова',
    play: 'Увімкнути звук',
    pause: 'Пауза',
    flow: 'Потік перекладу',
    liveNow: 'Зараз наживо',
    inProgress: 'У процесі',
    updating: 'Оновлюється...',
    connecting: 'Підключення...',
    connected: 'Підключено до події.',
    reconnecting: 'Повторне підключення...',
    noActiveEvent: 'Немає активної події.',
    cannotConnect: 'Не вдається підключитися до події.',
    audioOffByAdmin: 'Звук вимкнено адміністратором.',
    audioActive: 'Звук увімкнено.',
    audioPaused: 'Локальний звук на паузі.',
    waiting: 'Очікування перекладу...',
    eventMeta: (sourceName, targetName) => `Вхід: ${sourceName} · Переклад: ${targetName}`
  }
};

const state = {
  fixedEventId: new URLSearchParams(window.location.search).get('event') || '',
  currentEvent: null,
  currentLanguage: 'no',
  historyEntryIds: [],
  liveEntryIds: [],
  lastSpokenEntryId: null,
  localAudioEnabled: true,
  serverAudioMuted: false,
  userSelectedLanguage: false,
  languageInitialized: false
};

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function t(key, ...args) {
  const lang = uiTexts[state.currentLanguage] ? state.currentLanguage : 'en';
  const value = uiTexts[lang][key];
  if (typeof value === 'function') return value(...args);
  return value || uiTexts.en[key] || key;
}

function setStatus(text) {
  $('participantStatus').textContent = text;
}

function setStatusByState() {
  if (!state.currentEvent) {
    setStatus(t('connecting'));
    return;
  }

  if (state.serverAudioMuted) {
    setStatus(t('audioOffByAdmin'));
    return;
  }

  if (!state.localAudioEnabled) {
    setStatus(t('audioPaused'));
    return;
  }

  setStatus(t('connected'));
}

function setParticipantUpdating(show) {
  const badge = $('participantUpdatingBadge');
  if (!badge) return;
  badge.textContent = t('updating');
  badge.style.display = show ? 'block' : 'none';
}

function setStaticUiTexts() {
  if ($('languageSelectLabel')) $('languageSelectLabel').textContent = t('languageLabel');
  if ($('playAudioBtn')) $('playAudioBtn').textContent = t('play');
  if ($('pauseAudioBtn')) $('pauseAudioBtn').textContent = t('pause');
  if ($('flowLabel')) $('flowLabel').textContent = t('flow');
  if ($('participantUpdatingBadge')) $('participantUpdatingBadge').textContent = t('updating');
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

function getEntryById(entryId) {
  return (state.currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
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

  $('participantEventMeta').textContent = t('eventMeta', sourceName, targetName);
}

function syncLanguageOptions(event) {
  const select = $('languageSelect');
  const available = Array.from(new Set(event?.targetLangs || []));

  Array.from(select.options).forEach((option) => {
    const enabled = available.includes(option.value);
    option.disabled = !enabled;
    option.hidden = !enabled;
  });

  if (!state.languageInitialized && !state.userSelectedLanguage) {
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
  setStaticUiTexts();
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

function rebuildFlowFromCurrentEvent() {
  const entries = sortEntries(state.currentEvent?.transcripts || []);

  state.historyEntryIds = [];
  state.liveEntryIds = [];

  if (!entries.length) return;

  if (entries.length === 1) {
    state.liveEntryIds = [entries[0].id];
    return;
  }

  state.historyEntryIds = entries.slice(0, -2).map((x) => x.id);
  state.liveEntryIds = entries.slice(-2).map((x) => x.id);
}

function renderParticipantView({ announce = false } = {}) {
  if (!state.currentEvent) return;

  const historyEl = getHistoryElement();
  const wasNearBottom = isHistoryNearBottom();
  const prevScrollTop = historyEl ? historyEl.scrollTop : 0;
  const prevScrollHeight = historyEl ? historyEl.scrollHeight : 0;

  const historyHtml = state.historyEntryIds.map((entryId) => {
    const entry = getEntryById(entryId);
    if (!entry) return '';
    return `
      <div class="history-item" data-entry-id="${entry.id}">
        <div class="history-text">${escapeHtml(getTextForEntry(entry))}</div>
      </div>
    `;
  }).join('');

  const liveHtml = state.liveEntryIds.map((entryId, index) => {
    const entry = getEntryById(entryId);
    if (!entry) return '';

    const isLatest = index === state.liveEntryIds.length - 1;
    const liveClass = isLatest ? 'live-current' : 'live-secondary';
    const liveLabel = isLatest ? t('liveNow') : t('inProgress');

    return `
      <div class="history-item ${liveClass}" data-entry-id="${entry.id}">
        <div class="history-live-label">${liveLabel}</div>
        <div class="history-text">${escapeHtml(getTextForEntry(entry))}</div>
      </div>
    `;
  }).join('');

  if (historyEl) {
    historyEl.innerHTML = `${historyHtml}${liveHtml}` || `<div class="small">${escapeHtml(t('waiting'))}</div>`;
  }

  if (historyEl) {
    if (wasNearBottom) {
      scrollHistoryToBottom();
    } else {
      const diff = historyEl.scrollHeight - prevScrollHeight;
      historyEl.scrollTop = prevScrollTop + Math.max(0, diff);
    }
  }

  setStaticUiTexts();
  updateTopMeta();
  setStatusByState();

  const latestLiveId = state.liveEntryIds.length ? state.liveEntryIds[state.liveEntryIds.length - 1] : null;
  const latestLiveEntry = latestLiveId ? getEntryById(latestLiveId) : null;

  if (announce && latestLiveEntry && latestLiveEntry.id !== state.lastSpokenEntryId) {
    state.lastSpokenEntryId = latestLiveEntry.id;
    speakLatestEntry(latestLiveEntry);
  }
}

function handleLanguageChange() {
  state.userSelectedLanguage = true;
  state.currentLanguage = $('languageSelect').value;

  if (state.currentEvent?.id) {
    socket.emit('participant_language', {
      eventId: state.currentEvent.id,
      language: state.currentLanguage
    });
  }

  setStaticUiTexts();
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
    setStaticUiTexts();
    setStatus(t('noActiveEvent'));
    return;
  }

  socket.emit('join_event', {
    eventId,
    role: 'participant',
    language: $('languageSelect').value
  });
}

socket.on('connect', async () => {
  setStaticUiTexts();
  setStatus(t('connecting'));
  await joinParticipantEvent();
});

socket.on('disconnect', () => {
  setStatus(t('reconnecting'));
});

socket.on('join_error', ({ message }) => {
  setStatus(message || t('cannotConnect'));
});

socket.on('joined_event', ({ event, role }) => {
  if (role !== 'participant') return;

  state.currentEvent = event;
  state.serverAudioMuted = !!event.audioMuted;

  syncLanguageOptions(event);
  rebuildFlowFromCurrentEvent();
  renderParticipantView({ announce: false });
  setParticipantUpdating(false);
});

socket.on('transcript_entry', (entry) => {
  if (!state.currentEvent) return;

  state.currentEvent.transcripts = state.currentEvent.transcripts || [];

  const exists = getEntryById(entry.id);
  if (!exists) {
    state.currentEvent.transcripts.push(entry);
  }

  setParticipantUpdating(false);
  rebuildFlowFromCurrentEvent();
  renderParticipantView({ announce: true });
});

socket.on('transcript_source_updated', (payload) => {
  if (!state.currentEvent) return;

  updateEntryInState(payload);
  setParticipantUpdating(false);
  rebuildFlowFromCurrentEvent();
  renderParticipantView({ announce: false });
});

socket.on('entry_refreshing', ({ entryId }) => {
  if (entryId && state.liveEntryIds.includes(entryId)) {
    setParticipantUpdating(true);
  }
});

socket.on('entry_refresh_failed', ({ entryId }) => {
  if (entryId && state.liveEntryIds.includes(entryId)) {
    setParticipantUpdating(false);
  }
});

socket.on('audio_state', ({ audioMuted }) => {
  state.serverAudioMuted = !!audioMuted;

  if (state.serverAudioMuted) {
    stopSpeech();
  }

  setStatusByState();
});

socket.on('active_event_changed', async () => {
  if (!state.fixedEventId) {
    await joinParticipantEvent();
  }
});

$('languageSelect').addEventListener('change', handleLanguageChange);

$('playAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = true;
  setStatusByState();

  const latestLiveId = state.liveEntryIds.length ? state.liveEntryIds[state.liveEntryIds.length - 1] : null;
  const latestLiveEntry = latestLiveId ? getEntryById(latestLiveId) : null;
  if (latestLiveEntry) {
    speakLatestEntry(latestLiveEntry);
  }
});

$('pauseAudioBtn').addEventListener('click', () => {
  state.localAudioEnabled = false;
  stopSpeech();
  setStatusByState();
});

try {
  window.speechSynthesis?.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {};
} catch (_) {}
