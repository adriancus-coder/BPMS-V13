const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let eventId = params.get('event') || '';
let staticMode = !eventId;
let currentEvent = null;
let currentAudioState = { audioMuted: false, audioVolume: 70 };
let audioEnabled = localStorage.getItem('bpms_audio_enabled') === '1';

const names = {
  no: 'Norvegiană',
  ru: 'Rusă',
  uk: 'Ucraineană',
  en: 'Engleză',
  es: 'Spaniolă'
};

function setStatus(text) {
  $('participantStatus').textContent = text;
}

function persistParticipantState() {
  if (!staticMode && eventId) localStorage.setItem('bpms_event_id', eventId);
  const lang = $('languageSelect')?.value || '';
  if (lang) localStorage.setItem('bpms_participant_lang', lang);
  localStorage.setItem('bpms_audio_enabled', audioEnabled ? '1' : '0');
}

function detectPreferredLanguage(available = []) {
  const saved = localStorage.getItem('bpms_participant_lang') || '';
  if (saved && available.includes(saved)) return saved;

  const locales = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language || ''];
  const map = {
    no: ['no', 'nb', 'nn'],
    ru: ['ru'],
    uk: ['uk', 'ua'],
    en: ['en'],
    es: ['es']
  };

  for (const locale of locales) {
    const normalized = String(locale || '').toLowerCase();
    for (const [lang, prefixes] of Object.entries(map)) {
      if (available.includes(lang) && prefixes.some((prefix) => normalized.startsWith(prefix))) {
        return lang;
      }
    }
  }

  return available[0] || 'no';
}

function pickVoice(lang) {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  const pref = {
    no: ['nb-NO', 'no-NO', 'nn-NO', 'no'],
    ru: ['ru-RU', 'ru'],
    uk: ['uk-UA', 'uk'],
    en: ['en-US', 'en-GB', 'en'],
    es: ['es-ES', 'es-MX', 'es']
  }[lang] || [lang];

  return voices.find((v) =>
    pref.some((code) => (v.lang || '').toLowerCase().startsWith(code.toLowerCase()))
  ) || null;
}

function speak(text) {
  if (!audioEnabled || currentAudioState.audioMuted || !('speechSynthesis' in window)) return;
  const lang = $('languageSelect').value;
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.volume = Math.max(0, Math.min(1, currentAudioState.audioVolume / 100));

  const voice = pickVoice(lang);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  speechSynthesis.speak(utterance);
}

function addHistory(text) {
  const item = document.createElement('div');
  item.className = 'history-item';
  item.textContent = text;
  $('history').prepend(item);
}

function renderTranscript(entry, shouldSpeak = true) {
  const lang = $('languageSelect').value;
  const text = entry.translations?.[lang] || entry.original || '';

  $('lastText').textContent = text || 'Aștept traducerea...';
  if (text) addHistory(text);
  if (shouldSpeak && text) speak(text);
}

function renderEvent(event, keepCurrentLanguage = true) {
  currentEvent = event;
  eventId = event.id || eventId;
  $('participantEventName').textContent = event.name || 'Eveniment live';
  $('participantEventMeta').textContent = event.scheduledAt
    ? `Programat: ${new Date(event.scheduledAt).toLocaleString()}`
    : (event.isActive ? 'Eveniment live acum' : 'Eveniment dedicat');
  currentAudioState.audioMuted = !!event.audioMuted;
  currentAudioState.audioVolume = typeof event.audioVolume === 'number' ? event.audioVolume : 70;

  const langs = event.targetLangs || ['no', 'en'];
  const previousLang = keepCurrentLanguage ? ($('languageSelect').value || '') : '';
  const preferredLang = (previousLang && langs.includes(previousLang))
    ? previousLang
    : detectPreferredLanguage(langs);

  $('languageSelect').innerHTML = '';
  langs.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = names[lang] || lang.toUpperCase();
    $('languageSelect').appendChild(opt);
  });

  $('languageSelect').value = preferredLang;
  $('history').innerHTML = '';
  $('lastText').textContent = 'Aștept traducerea...';
  (event.transcripts || []).forEach((entry) => renderTranscript(entry, false));

  if (currentAudioState.audioMuted) {
    setStatus('Admin a oprit audio global. Textul merge în continuare.');
  } else if (audioEnabled) {
    setStatus('Audio local activ.');
  } else {
    setStatus('Conectat. Dacă vrei sunet, apasă Play audio.');
  }

  persistParticipantState();
}

async function rejoinParticipant() {
  persistParticipantState();

  try {
    const endpoint = staticMode ? '/api/events/active' : `/api/events/${eventId}`;
    const res = await fetch(endpoint);
    const data = await res.json();

    if (!data.ok || !data.event) {
      $('participantEventName').textContent = 'Niciun eveniment activ';
      $('participantEventMeta').textContent = 'Revino mai târziu sau verifică linkul primit.';
      setStatus(staticMode ? 'Nu există eveniment activ acum.' : 'Evenimentul din link nu există.');
      return;
    }

    renderEvent(data.event);
    eventId = data.event.id;
  } catch (err) {
    console.error('reload event failed', err);
    setStatus('Nu m-am putut reconecta.');
    return;
  }

  socket.emit('join_event', {
    eventId,
    role: 'participant',
    language: $('languageSelect').value || detectPreferredLanguage(currentEvent?.targetLangs || ['no'])
  });
}


socket.on('joined_event', ({ event }) => {
  renderEvent(event);
  socket.emit('participant_language', { eventId, language: $('languageSelect').value });
});

socket.on('join_error', ({ message }) => {
  setStatus(message || 'Nu m-am putut conecta.');
});

socket.on('transcript_entry', (entry) => renderTranscript(entry, true));

socket.on('transcript_updated', ({ lang, text }) => {
  if (lang !== $('languageSelect').value) return;
  $('lastText').textContent = text;
  addHistory(text);
  speak(text);
});

socket.on('transcript_source_updated', ({ translations }) => {
  const lang = $('languageSelect').value;
  const text = translations?.[lang];
  if (!text) return;
  $('lastText').textContent = text;
  addHistory(text);
  speak(text);
});

socket.on('audio_state', (state) => {
  currentAudioState = state;
  if (state.audioMuted) setStatus('Admin a oprit audio global. Textul merge în continuare.');
  else setStatus(audioEnabled ? 'Audio local activ.' : 'Text activ. Apasă Play audio dacă vrei sunet.');
});

socket.on('connect', async () => {
  await rejoinParticipant();
});


socket.on('active_event_changed', async () => {
  if (staticMode) {
    await rejoinParticipant();
  }
});

$('languageSelect').addEventListener('change', () => {
  persistParticipantState();
  if (currentEvent) {
    $('history').innerHTML = '';
    $('lastText').textContent = 'Aștept traducerea...';
    (currentEvent.transcripts || []).forEach((entry) => renderTranscript(entry, false));
  }

  socket.emit('participant_language', { eventId, language: $('languageSelect').value });
  setStatus(audioEnabled ? 'Limba schimbată. Audio local activ.' : 'Limba schimbată.');
});

$('playAudioBtn').addEventListener('click', () => {
  audioEnabled = true;
  persistParticipantState();
  speak('Audio activat');
  setStatus('Audio local activ.');
});

$('pauseAudioBtn').addEventListener('click', () => {
  audioEnabled = false;
  persistParticipantState();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  setStatus('Audio local oprit. Textul rămâne activ.');
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') await rejoinParticipant();
});
window.addEventListener('focus', async () => { await rejoinParticipant(); });
window.addEventListener('pageshow', async () => { await rejoinParticipant(); });
window.addEventListener('load', async () => { await rejoinParticipant(); });
