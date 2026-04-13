const socket = io();
const $ = (id) => document.getElementById(id);

let currentEvent = null;
let currentVolume = 70;
let currentMuted = false;
let selectedEntryId = null;
let sourceEditLock = false;
let activeTab = 'live';
let lastManualEnterAt = 0;
let screenWakeLock = null;
window.isRecognitionRunning = false;

let audioState = {
  stream: null,
  context: null,
  source: null,
  gainNode: null,
  preampNode: null,
  analyser: null,
  destination: null,
  meterFrame: null,
  recorder: null,
  running: false,
  busy: false,
  uploadQueue: [],
  chunks: [],
  chunkTimer: null,
  mimeType: '',
  monitorGainNode: null,
  monitorEnabled: false
};

const langNames = {
  ro: 'Română',
  no: 'Norvegiană',
  ru: 'Rusă',
  uk: 'Ucraineană',
  en: 'Engleză',
  es: 'Spaniolă'
};

function selectedLangs() {
  return Array.from(document.querySelectorAll('input[type="checkbox"][value]:checked')).map((i) => i.value);
}

function setStatus(text) {
  const el = $('recognitionStatus');
  if (el) el.textContent = text;
}

function setOnAirState(isOn) {
  const badge = $('onAirBadge');
  if (!badge) return;
  badge.textContent = isOn ? 'On-Air' : 'Off-Air';
  badge.className = isOn ? 'status-pill active' : 'status-pill';
}

async function enableScreenWakeLock() {
  try {
    if (!('wakeLock' in navigator)) {
      console.log('Wake Lock nu este suportat pe acest browser');
      return;
    }

    if (document.visibilityState !== 'visible') return;
    if (screenWakeLock) return;

    screenWakeLock = await navigator.wakeLock.request('screen');

    screenWakeLock.addEventListener('release', () => {
      console.log('Wake Lock eliberat');
      screenWakeLock = null;
    });

    console.log('Wake Lock activ');
  } catch (err) {
    console.error('Wake Lock error:', err?.name || err, err?.message || '');
  }
}

async function disableScreenWakeLock() {
  try {
    if (screenWakeLock) {
      await screenWakeLock.release();
      screenWakeLock = null;
    }
  } catch (err) {
    console.error('Wake Lock release error:', err?.name || err, err?.message || '');
  }
}

function switchTab(tabName) {
  activeTab = tabName;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  switchTab('live');
}

function updateGlossaryMode() {
  const mode = $('glossaryMode')?.value || 'translation';
  if ($('translationGlossaryFields')) {
    $('translationGlossaryFields').style.display = mode === 'translation' ? 'block' : 'none';
  }
  if ($('sourceCorrectionFields')) {
    $('sourceCorrectionFields').style.display = mode === 'source' ? 'block' : 'none';
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function renderActiveEventBadge(event) {
  const badge = $('activeEventBadge');
  const opened = $('openedEventBadge');
  if (!badge) return;

  if (!event) {
    badge.textContent = 'Niciun eveniment activ';
    badge.className = 'status-pill';
    if (opened) opened.textContent = 'Niciun eveniment deschis';
    return;
  }

  const extra = event.scheduledAt ? ` · ${formatDateTime(event.scheduledAt)}` : '';
  badge.textContent = event.isActive
    ? `Live: ${event.name || 'Eveniment'}${extra}`
    : `Live: alt eveniment${extra}`;
  badge.className = event.isActive ? 'status-pill active' : 'status-pill';

  if (opened) {
    opened.textContent = `Deschis: ${event.name || 'Eveniment'}${extra}`;
  }
}

function renderParticipantStats(stats = {}) {
  const summaryEl = $('participantStatsSummary');
  const listEl = $('participantStatsList');
  const singleLineEl = $('participantStats');

  const uniqueCount = Number(stats.uniqueCount || stats.total || 0);
  const languages = Array.isArray(stats.languages)
    ? stats.languages
    : Object.entries(stats.byLanguage || {}).map(([lang, count]) => ({ lang, count }));

  const sorted = [...languages].sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
  const inlineText = sorted
    .map((item) => `${langNames[item.lang] || String(item.lang).toUpperCase()}: ${item.count}`)
    .join(' · ');

  if (summaryEl) {
    summaryEl.textContent = uniqueCount === 1 ? '1 participant unic' : `${uniqueCount} participanți unici`;
  }

  if (listEl) {
    if (!sorted.length) {
      listEl.innerHTML = '<div class="small">Niciun participant conectat.</div>';
    } else {
      listEl.innerHTML = sorted
        .map((item) => {
          const label = langNames[item.lang] || String(item.lang).toUpperCase();
          return `<div class="history-item">${escapeHtml(label)}: ${item.count}</div>`;
        })
        .join('');
    }
  }

  if (singleLineEl) {
    singleLineEl.textContent = inlineText
      ? `Participanți unici: ${uniqueCount} · ${inlineText}`
      : `Participanți unici: ${uniqueCount}`;
  }
}

function resetParticipantStats() {
  renderParticipantStats({ uniqueCount: 0, languages: [] });
}

function getEntryById(entryId) {
  return (currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}

function fillGlossaryLangs(targetLangs = []) {
  const select = $('glossaryLang');
  if (!select) return;

  select.innerHTML = '';
  targetLangs.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = langNames[lang] || lang.toUpperCase();
    select.appendChild(opt);
  });
}

function copyField(id, buttonId) {
  const value = ($(id)?.value || '').trim();
  if (!value) return;

  navigator.clipboard.writeText(value).then(() => {
    const btn = $(buttonId);
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = old), 1200);
  }).catch(() => setStatus('Nu am putut copia linkul.'));
}

async function copyTextQuick(text, button) {
  const clean = String(text || '').trim();
  if (!clean) return;

  try {
    await navigator.clipboard.writeText(clean);
    if (!button) return;
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = old;
    }, 1200);
  } catch {
    setStatus('Nu am putut copia textul.');
  }
}

function shareWhatsApp(id) {
  const value = ($(id)?.value || '').trim();
  if (!value) return;
  const text = encodeURIComponent('Intră aici: ' + value);
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

async function copyQrImage() {
  const src = $('qrImage')?.src;
  if (!src) return;

  try {
    if (!navigator.clipboard || !window.ClipboardItem) {
      setStatus('Clipboard image nu este suportat aici. Folosește Descarcă QR.');
      return;
    }

    const blob = await (await fetch(src)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    setStatus('QR copiat în clipboard.');
  } catch {
    setStatus('Nu am putut copia QR-ul. Folosește Descarcă QR.');
  }
}

function downloadQr() {
  const src = $('qrImage')?.src;
  if (!src) return;
  const a = document.createElement('a');
  a.href = src;
  a.download = `bpms-qr-${Date.now()}.png`;
  a.click();
}

function buildScheduledAt() {
  const date = $('eventDate')?.value;
  const time = $('eventTime')?.value;
  if (!date) return null;
  return time ? `${date}T${time}:00` : `${date}T00:00:00`;
}

function openInlineEditor(entryId) {
  selectedEntryId = entryId;
  sourceEditLock = true;

  document.querySelectorAll('.entry.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.inline-editor.open').forEach((el) => el.classList.remove('open'));

  const card = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!card) return;

  card.classList.add('active');
  const editor = card.querySelector('.inline-editor');
  if (editor) editor.classList.add('open');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const textarea = card.querySelector('.inline-source');
      if (!textarea) return;

      try {
        textarea.focus({ preventScroll: true });
      } catch {
        textarea.focus();
      }

      textarea.selectionStart = textarea.value.length;
      textarea.selectionEnd = textarea.value.length;

      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

function closeInlineEditors() {
  document.querySelectorAll('.entry.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.inline-editor.open').forEach((el) => el.classList.remove('open'));
  selectedEntryId = null;
  sourceEditLock = false;
}

function renderEntry(entry) {
  const list = $('transcriptList');
  if (!list) return;

  const div = document.createElement('div');
  div.className = 'entry';
  div.dataset.entryId = entry.id;

  const editedBadge = entry.edited ? '<div class="small badge-inline">Corectat</div>' : '';
  const sourceLabel = langNames[entry.sourceLang] || entry.sourceLang?.toUpperCase() || 'Origine';
  const translations = Object.entries(entry.translations || {})
    .map(([lang, text]) => `<div class="trans" data-lang="${lang}"><b>${lang.toUpperCase()}:</b> ${escapeHtml(text)}</div>`)
    .join('');

  div.innerHTML = `
    <div class="entry-meta">${formatDateTime(entry.createdAt)}</div>
    <div class="entry-head row space-between">
      <div class="transcript-source-row">
        <div class="orig"><b>${sourceLabel}:</b> ${escapeHtml(entry.original)}</div>
        <button class="entry-copy-btn" type="button">Copy fraza</button>
      </div>
      ${editedBadge}
    </div>
    ${translations}
    <div class="inline-editor">
      <div class="small">Corectează româna și retradu toate limbile</div>
      <textarea class="inline-source">${escapeHtml(entry.original)}</textarea>
      <div class="inline-actions">
        <button class="btn-green inline-save" type="button">Retradu toate</button>
        <button class="btn-dark inline-close" type="button">Închide</button>
      </div>
    </div>
  `;

  div.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('textarea')) return;
    openInlineEditor(entry.id);
  });

  div.querySelector('.entry-copy-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    copyTextQuick(entry.original, e.currentTarget);
  });

  div.querySelector('.inline-save')?.addEventListener('click', (e) => {
    e.stopPropagation();
    saveInlineSource(entry.id);
  });

  div.querySelector('.inline-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeInlineEditors();
  });

  div.querySelector('.inline-source')?.addEventListener('input', (e) => {
    e.stopPropagation();
    selectedEntryId = entry.id;
    sourceEditLock = true;
  });

  div.querySelector('.inline-source')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveInlineSource(entry.id);
    }
  });

  list.prepend(div);
}

function updateEntry({ entryId, lang, text }) {
  const entry = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!entry) return;

  let line = entry.querySelector(`.trans[data-lang="${lang}"]`);
  if (!line) {
    line = document.createElement('div');
    line.className = 'trans';
    line.dataset.lang = lang;
    entry.insertBefore(line, entry.querySelector('.inline-editor'));
  }

  line.innerHTML = `<b>${lang.toUpperCase()}:</b> ${escapeHtml(text)}`;
}

function updateSourceEntry({ entryId, sourceLang, original, translations }) {
  const entry = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (!entry) return;

  const orig = entry.querySelector('.orig');
  if (orig) {
    const sourceLabel = langNames[sourceLang] || sourceLang?.toUpperCase() || 'Origine';
    orig.innerHTML = `<b>${sourceLabel}:</b> ${escapeHtml(original)}`;
  }

  const copyBtn = entry.querySelector('.entry-copy-btn');
  if (copyBtn) {
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      copyTextQuick(original, copyBtn);
    };
  }

  const textarea = entry.querySelector('.inline-source');
  if (textarea) textarea.value = original;

  Object.entries(translations || {}).forEach(([lang, text]) => {
    updateEntry({ entryId, lang, text });
  });

  const actual = getEntryById(entryId);
  if (actual) {
    actual.sourceLang = sourceLang;
    actual.original = original;
    actual.translations = translations;
    actual.edited = true;
  }
}

function saveInlineSource(entryId) {
  if (!currentEvent) return;

  const card = document.querySelector(`[data-entry-id="${entryId}"]`);
  const textarea = card?.querySelector('.inline-source');
  if (!textarea) return;

  const text = textarea.value.trim();
  if (!text) return;

  selectedEntryId = entryId;
  sourceEditLock = false;

  socket.emit('admin_update_source', {
    eventId: currentEvent.id,
    entryId,
    sourceText: text
  });

  closeInlineEditors();
}

function renderEventList(events = [], activeEventId = null, openedEventId = null) {
  const box = $('eventList');
  if (!box) return;
  box.innerHTML = '';

  if (!events.length) {
    box.innerHTML = '<div class="small">Nu există încă evenimente.</div>';
    return;
  }

  events.forEach((event) => {
    const card = document.createElement('div');
    card.className = `event-card${event.id === activeEventId ? ' active' : ''}${event.id === openedEventId ? ' opened' : ''}`;
    const langs = (event.targetLangs || []).map((lang) => langNames[lang] || lang.toUpperCase()).join(', ');

    card.innerHTML = `
      <div class="name">${escapeHtml(event.name || 'Eveniment nou')}</div>
      ${event.isActive ? '<div class="badge">Live acum</div>' : ''}
      <div class="meta">Programat: ${escapeHtml(formatDateTime(event.scheduledAt || event.createdAt))}</div>
      <div class="meta">Limbi: ${escapeHtml(langs || '-')}</div>
      <div class="meta">Texte: ${event.transcriptCount || 0}</div>
      <div class="actions">
        <button class="btn-dark" data-action="open" data-id="${event.id}">Deschide</button>
        <button class="btn-blue" data-action="activate" data-id="${event.id}">Pune live</button>
        <button data-action="delete" data-id="${event.id}">Șterge</button>
      </div>
    `;

    box.appendChild(card);
  });
}

async function refreshEventList() {
  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    if (!data.ok) return;
    renderEventList(data.events || [], data.activeEventId || null, currentEvent?.id || null);
  } catch (err) {
    console.error(err);
  }
}

async function syncSpeedToEvent() {
  if (!currentEvent) return;
  const speed = $('speed')?.value || 'balanced';

  try {
    const res = await fetch(`/api/events/${currentEvent.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed })
    });

    const data = await res.json();
    if (!data.ok) return;

    currentEvent = data.event;
    setStatus(`Mod traducere: ${speed}`);
  } catch (err) {
    console.error(err);
  }
}

async function openEventById(eventId) {
  if (!eventId) return;

  try {
    const res = await fetch(`/api/events/${eventId}`);
    const data = await res.json();
    if (!data.ok) return;

    currentEvent = data.event;
    if ($('adminCode')) $('adminCode').textContent = currentEvent.adminCode;
    if ($('participantLink')) $('participantLink').value = currentEvent.participantLink;
    if ($('qrImage')) $('qrImage').src = currentEvent.qrCodeDataUrl;
    if ($('speed')) $('speed').value = currentEvent.speed || 'balanced';
    currentVolume = currentEvent.audioVolume;
    currentMuted = currentEvent.audioMuted;
    if ($('volumeRange')) $('volumeRange').value = String(currentVolume);
    if ($('transcriptList')) $('transcriptList').innerHTML = '';
    (currentEvent.transcripts || []).forEach(renderEntry);
    fillGlossaryLangs(currentEvent.targetLangs || []);
    renderActiveEventBadge(currentEvent);
    closeInlineEditors();

    if ($('partialTranscript')) {
      $('partialTranscript').textContent = 'Aștept propoziția completă...';
    }

    socket.emit('join_event', {
      eventId: currentEvent.id,
      role: 'admin',
      code: currentEvent.adminCode
    });

    await refreshEventList();
    setStatus(`Ai deschis evenimentul: ${currentEvent.name || 'Eveniment'}.`);
    switchTab('live');
  } catch (err) {
    console.error(err);
  }
}

async function createEvent() {
  const name = $('eventName')?.value.trim() || 'Eveniment nou';
  const sourceLang = $('sourceLang')?.value;
  const targetLangs = selectedLangs();
  const scheduledAt = buildScheduledAt();

  if (!targetLangs.length) {
    alert('Alege cel puțin o limbă.');
    return;
  }

  if (targetLangs.includes(sourceLang)) {
    alert('Scoate limba de origine din lista limbilor traduse.');
    return;
  }

  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      speed: $('speed')?.value || 'balanced',
      sourceLang,
      targetLangs,
      scheduledAt
    })
  });

  const data = await res.json();
  if (!data.ok) {
    alert(data.error || 'Nu am putut crea evenimentul.');
    return;
  }

  currentEvent = data.event;
  if ($('adminCode')) $('adminCode').textContent = currentEvent.adminCode;
  if ($('participantLink')) $('participantLink').value = currentEvent.participantLink;
  if ($('qrImage')) $('qrImage').src = currentEvent.qrCodeDataUrl;
  if ($('speed')) $('speed').value = currentEvent.speed || 'balanced';
  renderActiveEventBadge(currentEvent);
  currentVolume = currentEvent.audioVolume;
  currentMuted = currentEvent.audioMuted;
  if ($('volumeRange')) $('volumeRange').value = String(currentVolume);
  if ($('transcriptList')) $('transcriptList').innerHTML = '';
  fillGlossaryLangs(currentEvent.targetLangs || []);
  closeInlineEditors();

  if ($('partialTranscript')) {
    $('partialTranscript').textContent = 'Aștept propoziția completă...';
  }

  socket.emit('join_event', {
    eventId: currentEvent.id,
    role: 'admin',
    code: currentEvent.adminCode
  });

  await refreshEventList();
  setStatus('Eveniment creat. Poți testa audio și porni traducerea.');
  switchTab('live');
}

async function setActiveEvent() {
  if (!currentEvent) return;

  const res = await fetch(`/api/events/${currentEvent.id}/activate`, { method: 'POST' });
  const data = await res.json();
  if (!data.ok) {
    alert(data.error || 'Nu am putut seta evenimentul activ.');
    return;
  }

  currentEvent = data.event;
  renderActiveEventBadge(currentEvent);
  if ($('participantLink')) $('participantLink').value = currentEvent.participantLink;
  if ($('qrImage')) $('qrImage').src = currentEvent.qrCodeDataUrl;
  setStatus('Evenimentul public a fost actualizat.');
}

async function loadAudioInputs(keepValue = true) {
  const select = $('audioInput');
  if (!select) return;

  const previous = keepValue ? select.value : '';
  select.innerHTML = '';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');

    if (!inputs.length) {
      const o = document.createElement('option');
      o.textContent = 'Niciun input audio';
      o.value = '';
      select.appendChild(o);
      return;
    }

    inputs.forEach((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || 'Input audio';
      select.appendChild(o);
    });

    if (previous && inputs.some((d) => d.deviceId === previous)) {
      select.value = previous;
    }
  } catch (err) {
    console.error(err);
    setStatus('Nu am putut citi sursele audio.');
  }
}

async function destroyAudioPipeline() {
  audioState.running = false;

  if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
  audioState.chunkTimer = null;
  audioState.chunks = [];
  audioState.mimeType = '';

  if (audioState.recorder && audioState.recorder.state !== 'inactive') {
    try {
      audioState.recorder.stop();
    } catch (_) {}
  }
  audioState.recorder = null;

  if (audioState.meterFrame) cancelAnimationFrame(audioState.meterFrame);
  audioState.meterFrame = null;

  if (audioState.stream) {
    audioState.stream.getTracks().forEach((t) => t.stop());
  }
  audioState.stream = null;

  if (audioState.context) {
    await audioState.context.close().catch(() => {});
  }

  audioState.context = null;
  audioState.source = null;
  audioState.gainNode = null;
  audioState.preampNode = null;
  audioState.analyser = null;
  audioState.monitorGainNode = null;
  audioState.monitorEnabled = false;
  audioState.destination = null;
  audioState.busy = false;
  audioState.uploadQueue = [];

  if ($('audioLevel')) $('audioLevel').value = 0;
  setOnAirState(false);
}

function sliderToGain(value) {
  const v = Math.max(0, Number(value || 100));
  return Math.pow(v / 100, 2);
}

function updateInputGain() {
  const range = $('inputGainRange');
  const label = $('inputGainLabel');
  if (!range || !label) return;

  const value = Number(range.value || 100);
  const gain = sliderToGain(value);

  label.textContent = `${value}% · ${gain.toFixed(1)}x`;

  if (audioState.preampNode) {
    audioState.preampNode.gain.value = gain;
  }
}

function updateMonitorGain() {
  const enabled = !!$('monitorAudioBox')?.checked;
  const value = Number($('monitorGainRange')?.value || 0);
  const gain = enabled ? sliderToGain(value) : 0;

  if ($('monitorGainLabel')) {
    $('monitorGainLabel').textContent = `${value}% · ${gain.toFixed(1)}x`;
  }

  audioState.monitorEnabled = enabled;

  if (audioState.monitorGainNode) {
    audioState.monitorGainNode.gain.value = gain;
  }
}

function startMeterLoop() {
  if (!audioState.analyser) return;

  const data = new Uint8Array(audioState.analyser.fftSize);

  const draw = () => {
    if (!audioState.analyser) return;

    audioState.analyser.getByteTimeDomainData(data);

    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }

    const rms = Math.sqrt(sumSquares / data.length);
    const db = 20 * Math.log10(Math.max(rms, 0.00001));
    const level = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));

    if ($('audioLevel')) $('audioLevel').value = level;

    if (level < 8) {
      setStatus(audioState.running ? 'Fără semnal sau semnal foarte slab.' : 'Alege sursa și pornește traducerea.');
    } else if (level < 65) {
      setStatus(audioState.running ? 'Traduce din sursa selectată.' : 'Semnal audio OK.');
    } else if (level < 90) {
      setStatus(audioState.running ? 'Traduce. Semnal bun.' : 'Semnal bun.');
    } else {
      setStatus(audioState.running ? 'Traduce. Semnal foarte puternic.' : 'Semnal foarte puternic.');
    }

    audioState.meterFrame = requestAnimationFrame(draw);
  };

  draw();
}

async function createAudioPipeline() {
  const deviceId = $('audioInput')?.value;
  await destroyAudioPipeline();

  audioState.stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId
      ? {
          deviceId: { exact: deviceId },
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      : {
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
  });

  audioState.context = new (window.AudioContext || window.webkitAudioContext)();
  await audioState.context.resume();

  audioState.source = audioState.context.createMediaStreamSource(audioState.stream);
  audioState.gainNode = audioState.context.createGain();
  audioState.preampNode = audioState.context.createGain();
  audioState.analyser = audioState.context.createAnalyser();
  audioState.analyser.fftSize = 2048;
  audioState.destination = audioState.context.createMediaStreamDestination();

  audioState.source.connect(audioState.gainNode);
  audioState.gainNode.connect(audioState.preampNode);
  audioState.preampNode.connect(audioState.analyser);
  audioState.preampNode.connect(audioState.destination);

  audioState.monitorGainNode = audioState.context.createGain();
  audioState.monitorGainNode.gain.value = 0;
  audioState.preampNode.connect(audioState.monitorGainNode);
  audioState.monitorGainNode.connect(audioState.context.destination);

  if (audioState.gainNode) {
    audioState.gainNode.gain.value = 1;
  }

  updateInputGain();
  updateMonitorGain();
  startMeterLoop();
}

function chooseRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function postAudioChunk(blob) {
  if (!currentEvent || !blob || blob.size < 3500) return;

  const form = new FormData();
  form.append('code', currentEvent.adminCode);
  form.append('audio', new File([blob], 'chunk.webm', { type: 'audio/webm' }));

  const res = await fetch(`/api/events/${currentEvent.id}/transcribe`, {
    method: 'POST',
    body: form
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.error || 'Nu am putut transcrie audio.');
  }
}

function enqueueAudioBlob(blob) {
  if (!blob || blob.size < 3500) return;
  audioState.uploadQueue.push(blob);

  if (!audioState.busy) {
    drainAudioUploadQueue().catch(console.error);
  }
}

async function drainAudioUploadQueue() {
  if (audioState.busy) return;
  audioState.busy = true;

  try {
    while (audioState.uploadQueue.length) {
      const blob = audioState.uploadQueue.shift();
      try {
        await postAudioChunk(blob);
      } catch (err) {
        console.error(err);
        setStatus(err.message || 'Eroare la trimiterea audio.');
      }
    }
  } finally {
    audioState.busy = false;
  }
}

async function startTranslation() {
  if (!currentEvent) {
    alert('Alege sau creează întâi un eveniment.');
    return;
  }

  await syncSpeedToEvent();

  if (!window.MediaRecorder) {
    alert('Browserul nu suportă MediaRecorder. Folosește Chrome sau Edge pe Surface.');
    return;
  }

  try {
    await createAudioPipeline();
  } catch (err) {
    console.error(err);
    setStatus('Nu am putut porni audio. Verifică sursa audio și permisiunea de microfon.');
    return;
  }

  const mimeType = chooseRecorderMimeType();
  if (!mimeType) {
    alert('Browserul nu suportă audio/webm. Folosește Chrome sau Edge.');
    return;
  }

  audioState.running = true;
  audioState.mimeType = mimeType;
  window.isRecognitionRunning = true;
  switchTab('live');
  setOnAirState(true);
  await enableScreenWakeLock();

  audioState.recorder = new MediaRecorder(audioState.destination.stream, {
    mimeType,
    audioBitsPerSecond: 128000
  });

  audioState.recorder.ondataavailable = (event) => {
    if (!audioState.running) return;
    if (event.data && event.data.size >= 3500) {
      enqueueAudioBlob(event.data);
    }
  };

  audioState.recorder.onstop = () => {
    audioState.recorder = null;
  };

  audioState.recorder.start(4500);
  setStatus('On-Air. Traduce din sursa selectată.');
}

async function stopTranslation() {
  audioState.running = false;
  window.isRecognitionRunning = false;

  if (audioState.chunkTimer) {
    clearTimeout(audioState.chunkTimer);
    audioState.chunkTimer = null;
  }

  setOnAirState(false);
  await disableScreenWakeLock();

  if (audioState.recorder && audioState.recorder.state === 'recording') {
    audioState.recorder.stop();
    setTimeout(() => {
      destroyAudioPipeline().catch(console.error);
    }, 100);
    return;
  }

  await destroyAudioPipeline();
  setStatus('Oprit.');
}

function sendManualText() {
  if (!currentEvent) return alert('Alege sau creează întâi un eveniment.');

  const text = $('manualText')?.value.trim();
  if (!text) return;

  socket.emit('submit_text', { eventId: currentEvent.id, text });
  if ($('manualText')) $('manualText').value = '';
  lastManualEnterAt = 0;
}

socket.on('joined_event', ({ event, role }) => {
  if (role !== 'admin') return;

  currentEvent = event;
  if ($('speed')) $('speed').value = event.speed || 'balanced';
  currentVolume = event.audioVolume;
  currentMuted = event.audioMuted;

  if ($('volumeRange')) $('volumeRange').value = String(currentVolume);
  if ($('audioStateLabel')) {
    $('audioStateLabel').textContent = currentMuted ? 'Audio global oprit.' : 'Audio global activ.';
  }

  if ($('transcriptList')) $('transcriptList').innerHTML = '';
  (event.transcripts || []).forEach(renderEntry);
  fillGlossaryLangs(currentEvent.targetLangs || []);
  renderActiveEventBadge(currentEvent);
  closeInlineEditors();
  refreshEventList();

  if ($('partialTranscript')) {
    $('partialTranscript').textContent = 'Aștept propoziția completă...';
  }
});

socket.on('transcript_entry', (entry) => {
  if (!currentEvent) return;

  currentEvent.transcripts = currentEvent.transcripts || [];
  const exists = getEntryById(entry.id);
  if (!exists) {
    currentEvent.transcripts.push(entry);
  }

  renderEntry(entry);

  if ($('partialTranscript')) {
    $('partialTranscript').textContent = 'Aștept propoziția completă...';
  }
});

socket.on('transcript_updated', updateEntry);

socket.on('transcript_source_updated', (payload) => {
  updateSourceEntry(payload);
  if ($('partialTranscript')) {
    $('partialTranscript').textContent = 'Aștept propoziția completă...';
  }
});

socket.on('audio_state', ({ audioMuted, audioVolume }) => {
  currentMuted = audioMuted;
  currentVolume = audioVolume;
  if ($('volumeRange')) $('volumeRange').value = String(audioVolume);
  if ($('audioStateLabel')) {
    $('audioStateLabel').textContent = audioMuted ? 'Audio global oprit.' : 'Audio global activ.';
  }
});

socket.on('partial_transcript', ({ text }) => {
  if ($('partialTranscript')) {
    $('partialTranscript').textContent = text || 'Aștept propoziția completă...';
  }
});

socket.on('participant_stats', renderParticipantStats);

socket.on('server_error', ({ message }) => {
  setStatus(message || 'Eroare server.');
});

socket.on('active_event_changed', async ({ eventId }) => {
  if (currentEvent) {
    currentEvent.isActive = currentEvent.id === eventId;
    renderActiveEventBadge(currentEvent);
  }

  await refreshEventList();

  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event) {
      await openEventById(data.event.id);
    } else {
      resetParticipantStats();
    }
  } catch (_) {}
});

$('createEventBtn')?.addEventListener('click', createEvent);
$('sendManualBtn')?.addEventListener('click', sendManualText);
$('speed')?.addEventListener('change', syncSpeedToEvent);
$('openTranscriptTabBtn')?.addEventListener('click', () => switchTab('transcript'));

$('manualText')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;

  const now = Date.now();

  if (now - lastManualEnterAt < 600) {
    e.preventDefault();
    sendManualText();
    return;
  }

  lastManualEnterAt = now;
});

$('saveGlossaryBtn')?.addEventListener('click', async () => {
  if (!currentEvent) return alert('Alege sau creează întâi un eveniment.');

  const source = $('glossarySource')?.value.trim();
  const target = $('glossaryTarget')?.value.trim();
  const lang = $('glossaryLang')?.value;
  const permanent = !!$('glossaryPermanent')?.checked;
  if (!source || !target) return;

  const res = await fetch(`/api/events/${currentEvent.id}/glossary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target, lang, permanent })
  });

  const data = await res.json();
  if (data.ok) {
    if ($('glossarySource')) $('glossarySource').value = '';
    if ($('glossaryTarget')) $('glossaryTarget').value = '';
    setStatus('Traducerea a fost salvată în glosar.');
  }
});

$('saveSourceCorrectionBtn')?.addEventListener('click', async () => {
  if (!currentEvent) return alert('Alege sau creează întâi un eveniment.');

  const heard = $('sourceWrong')?.value.trim();
  const correct = $('sourceCorrect')?.value.trim();
  const permanent = !!$('sourceCorrectionPermanent')?.checked;

  if (!heard || !correct) return;

  const res = await fetch(`/api/events/${currentEvent.id}/source-corrections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ heard, correct, permanent })
  });

  const data = await res.json();
  if (data.ok) {
    if ($('sourceWrong')) $('sourceWrong').value = '';
    if ($('sourceCorrect')) $('sourceCorrect').value = '';
    setStatus('Corecția de recunoaștere a fost salvată.');
  }
});

$('glossaryMode')?.addEventListener('change', updateGlossaryMode);

$('muteGlobalBtn')?.addEventListener('click', () => {
  if (!currentEvent) return;

  currentMuted = !currentMuted;
  socket.emit('set_audio_state', {
    eventId: currentEvent.id,
    audioMuted: currentMuted,
    audioVolume: currentVolume,
    code: currentEvent.adminCode
  });
});

$('panicBtn')?.addEventListener('click', () => {
  if (!currentEvent) return;

  currentMuted = true;
  currentVolume = 0;
  if ($('volumeRange')) $('volumeRange').value = '0';

  socket.emit('set_audio_state', {
    eventId: currentEvent.id,
    audioMuted: true,
    audioVolume: 0,
    code: currentEvent.adminCode
  });
});

$('volumeRange')?.addEventListener('input', () => {
  currentVolume = Number($('volumeRange')?.value || 70);
  if (!currentEvent) return;

  socket.emit('set_audio_state', {
    eventId: currentEvent.id,
    audioMuted: currentMuted,
    audioVolume: currentVolume,
    code: currentEvent.adminCode
  });
});

$('inputGainRange')?.addEventListener('input', updateInputGain);
$('monitorAudioBox')?.addEventListener('change', updateMonitorGain);
$('monitorGainRange')?.addEventListener('input', updateMonitorGain);

$('audioInput')?.addEventListener('change', async () => {
  if (audioState.running) {
    await startTranslation();
  } else {
    try {
      await createAudioPipeline();
      setStatus('Sursa audio a fost schimbată.');
    } catch (err) {
      console.error(err);
      setStatus('Nu am putut porni sursa selectată.');
    }
  }
});

$('startRecognitionBtn')?.addEventListener('click', startTranslation);
$('stopRecognitionBtn')?.addEventListener('click', stopTranslation);
$('copyParticipantBtn')?.addEventListener('click', () => copyField('participantLink', 'copyParticipantBtn'));
$('shareParticipantBtn')?.addEventListener('click', () => shareWhatsApp('participantLink'));
$('copyQrBtn')?.addEventListener('click', copyQrImage);
$('downloadQrBtn')?.addEventListener('click', downloadQr);
$('setActiveEventBtn')?.addEventListener('click', setActiveEvent);
$('refreshEventsBtn')?.addEventListener('click', refreshEventList);

$('jumpLiveBtn')?.addEventListener('click', () => {
  sourceEditLock = false;
  closeInlineEditors();
  switchTab('transcript');
  const first = document.querySelector('#transcriptList .entry');
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

$('eventList')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;

  const id = btn.getAttribute('data-id');
  const action = btn.getAttribute('data-action');
  if (!id || !action) return;

  if (action === 'open') {
    await openEventById(id);
    return;
  }

  if (action === 'activate') {
    const res = await fetch(`/api/events/${id}/activate`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (currentEvent && currentEvent.id === id) {
        currentEvent = data.event;
        renderActiveEventBadge(currentEvent);
      }
      await refreshEventList();
      setStatus('Evenimentul ales este acum live pentru participanți.');
    }
    return;
  }

  if (action === 'delete') {
    const ok = confirm('Ștergi definitiv acest eveniment?');
    if (!ok) return;

    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.ok) {
      if (currentEvent?.id === id) {
        currentEvent = null;
        if ($('adminCode')) $('adminCode').textContent = '-';
        if ($('participantLink')) $('participantLink').value = '';
        if ($('qrImage')) $('qrImage').src = '';
        if ($('transcriptList')) $('transcriptList').innerHTML = '';
        renderActiveEventBadge(null);
        resetParticipantStats();

        if ($('partialTranscript')) {
          $('partialTranscript').textContent = 'Aștept propoziția completă...';
        }
      }

      await refreshEventList();
      setStatus('Evenimentul a fost șters.');
    }
  }
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && window.isRecognitionRunning && !screenWakeLock) {
    await enableScreenWakeLock();
  }
});

window.addEventListener('beforeunload', async () => {
  await disableScreenWakeLock();
});

window.addEventListener('load', async () => {
  const now = new Date();
  if ($('eventDate')) $('eventDate').value = now.toISOString().slice(0, 10);
  if ($('eventTime')) {
    $('eventTime').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {}

  await loadAudioInputs();
  initTabs();
  updateGlossaryMode();
  updateInputGain();
  updateMonitorGain();
  setOnAirState(false);
  resetParticipantStats();
  await refreshEventList();

  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event) {
      await openEventById(data.event.id);
    }
  } catch (_) {}
}); 