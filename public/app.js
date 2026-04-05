const socket = io();
const $ = (id) => document.getElementById(id);

let currentEvent = null;
let currentVolume = 70;
let currentMuted = false;
let selectedEntryId = null;
let sourceEditLock = false;

let audioState = {
  stream: null,
  context: null,
  source: null,
  gainNode: null,
  analyser: null,
  destination: null,
  meterFrame: null,
  recorder: null,
  running: false,
  busy: false,
  pendingBlob: null,
  chunks: [],
  chunkTimer: null,
  mimeType: ''
  monitorGainNode: null,
monitorEnabled: false,
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
  $('recognitionStatus').textContent = text;
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
  badge.textContent = event.isActive ? `Live: ${event.name || 'Eveniment'}${extra}` : `Live: alt eveniment${extra}`;
  badge.className = event.isActive ? 'status-pill active' : 'status-pill';
  if (opened) opened.textContent = `Deschis: ${event.name || 'Eveniment'}${extra}`;
}

function getEntryById(entryId) {
  return (currentEvent?.transcripts || []).find((x) => x.id === entryId) || null;
}

function sortedEntries() {
  return [...(currentEvent?.transcripts || [])].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function fillGlossaryLangs(targetLangs = []) {
  $('glossaryLang').innerHTML = '';
  targetLangs.forEach((lang) => {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = langNames[lang] || lang.toUpperCase();
    $('glossaryLang').appendChild(opt);
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

function shareWhatsApp(id) {
  const value = ($(id)?.value || '').trim();
  if (!value) return;
  const text = encodeURIComponent('Intră aici: ' + value);
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

async function copyQrImage() {
  const src = $('qrImage').src;
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
  const src = $('qrImage').src;
  if (!src) return;
  const a = document.createElement('a');
  a.href = src;
  a.download = `bpms-qr-${Date.now()}.png`;
  a.click();
}

function buildScheduledAt() {
  const date = $('eventDate').value;
  const time = $('eventTime').value;
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
  const textarea = card.querySelector('.inline-source');
  if (textarea) {
    textarea.focus();
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
  }
}

function closeInlineEditors() {
  document.querySelectorAll('.entry.active').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.inline-editor.open').forEach((el) => el.classList.remove('open'));
  selectedEntryId = null;
  sourceEditLock = false;
}

function renderEntry(entry) {
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
      <div class="orig"><b>${sourceLabel}:</b> ${escapeHtml(entry.original)}</div>
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

  $('transcriptList').prepend(div);
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
  const textarea = entry.querySelector('.inline-source');
  if (textarea) textarea.value = original;
  Object.entries(translations || {}).forEach(([lang, text]) => updateEntry({ entryId, lang, text }));

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

async function openEventById(eventId) {
  if (!eventId) return;
  try {
    const res = await fetch(`/api/events/${eventId}`);
    const data = await res.json();
    if (!data.ok) return;

    currentEvent = data.event;
    $('adminCode').textContent = currentEvent.adminCode;
    $('participantLink').value = currentEvent.participantLink;
    $('qrImage').src = currentEvent.qrCodeDataUrl;
    currentVolume = currentEvent.audioVolume;
    currentMuted = currentEvent.audioMuted;
    $('volumeRange').value = String(currentVolume);
    $('transcriptList').innerHTML = '';
    (currentEvent.transcripts || []).forEach(renderEntry);
    fillGlossaryLangs(currentEvent.targetLangs || []);
    renderActiveEventBadge(currentEvent);
    closeInlineEditors();
    socket.emit('join_event', { eventId: currentEvent.id, role: 'admin', code: currentEvent.adminCode });
    await refreshEventList();
    setStatus(`Ai deschis evenimentul: ${currentEvent.name || 'Eveniment'}.`);
    document.querySelector('.transcript-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
  }
}

async function createEvent() {
  const name = $('eventName').value.trim() || 'Eveniment nou';
  const speed = $('speed').value;
  const sourceLang = $('sourceLang').value;
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
    body: JSON.stringify({ name, speed, sourceLang, targetLangs, scheduledAt })
  });

  const data = await res.json();
  if (!data.ok) {
    alert(data.error || 'Nu am putut crea evenimentul.');
    return;
  }

  currentEvent = data.event;
  $('adminCode').textContent = currentEvent.adminCode;
  $('participantLink').value = currentEvent.participantLink;
  $('qrImage').src = currentEvent.qrCodeDataUrl;
  renderActiveEventBadge(currentEvent);
  currentVolume = currentEvent.audioVolume;
  currentMuted = currentEvent.audioMuted;
  $('volumeRange').value = String(currentVolume);
  $('transcriptList').innerHTML = '';
  fillGlossaryLangs(currentEvent.targetLangs || []);
  closeInlineEditors();
  socket.emit('join_event', { eventId: currentEvent.id, role: 'admin', code: currentEvent.adminCode });
  await refreshEventList();
  setStatus('Eveniment creat. Poți testa audio și porni traducerea.');
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
  $('participantLink').value = currentEvent.participantLink;
  $('qrImage').src = currentEvent.qrCodeDataUrl;
  setStatus('Evenimentul public a fost actualizat.');
}

async function loadAudioInputs(keepValue = true) {
  const select = $('audioInput');
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
    if (previous && inputs.some((d) => d.deviceId === previous)) select.value = previous;
  } catch (err) {
    console.error(err);
    setStatus('Nu am putut citi sursele audio.');
  }
}

async function destroyAudioPipeline() {
  if (audioState.chunkTimer) clearTimeout(audioState.chunkTimer);
  audioState.chunkTimer = null;
  audioState.chunks = [];
  audioState.mimeType = '';
  if (audioState.recorder && audioState.recorder.state !== 'inactive') audioState.recorder.stop();
  audioState.recorder = null;
  audioState.running = false;
  if (audioState.meterFrame) cancelAnimationFrame(audioState.meterFrame);
  audioState.meterFrame = null;
  if (audioState.stream) audioState.stream.getTracks().forEach((t) => t.stop());
  audioState.stream = null;
  if (audioState.context) await audioState.context.close().catch(() => {});
  audioState.context = null;
  audioState.source = null;
  audioState.gainNode = null;
  audioState.analyser = null;
  audioState.monitorGainNode = null;
audioState.monitorEnabled = false;
  audioState.destination = null;
  audioState.pendingBlob = null;
  audioState.busy = false;
  $('audioLevel').value = 0;
}

function updateInputGain() {
  const value = Number($('inputGainRange').value || 100);
  $('inputGainLabel').textContent = `${value}%`;
  if (audioState.gainNode) audioState.gainNode.gain.value = value / 100;
}
function updateMonitorGain() {
  const enabled = !!$('monitorAudioBox')?.checked;
  const value = Number($('monitorGainRange')?.value || 0);

  if ($('monitorGainLabel')) {
    $('monitorGainLabel').textContent = `${value}%`;
  }

  audioState.monitorEnabled = enabled;

  if (audioState.monitorGainNode) {
    audioState.monitorGainNode.gain.value = enabled ? (value / 100) : 0;
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
    const level = Math.min(100, Math.round(rms * 180 * (Number($('inputGainRange').value || 100) / 100)));
    $('audioLevel').value = level;
    if (level < 5) setStatus(audioState.running ? 'Fără semnal sau semnal foarte slab.' : 'Alege sursa și pornește traducerea.');
    else if (level < 70) setStatus(audioState.running ? 'Traduce din sursa selectată.' : 'Semnal audio OK.');
    else setStatus(audioState.running ? 'Traduce. Semnal puternic.' : 'Semnal puternic. Verifică gain-ul.');
    audioState.meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function createAudioPipeline() {
  const deviceId = $('audioInput').value;
  await destroyAudioPipeline();
  audioState.stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : true
  });
  audioState.context = new (window.AudioContext || window.webkitAudioContext)();
  await audioState.context.resume();
  audioState.source = audioState.context.createMediaStreamSource(audioState.stream);
  audioState.gainNode = audioState.context.createGain();
  audioState.analyser = audioState.context.createAnalyser();
  audioState.analyser.fftSize = 1024;
  audioState.destination = audioState.context.createMediaStreamDestination();
  audioState.source.connect(audioState.gainNode);
  audioState.gainNode.connect(audioState.analyser);
  audioState.gainNode.connect(audioState.destination);
  audioState.monitorGainNode = audioState.context.createGain();
audioState.monitorGainNode.gain.value = 0;

audioState.gainNode.connect(audioState.monitorGainNode);
audioState.monitorGainNode.connect(audioState.context.destination);
  updateInputGain();
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
  const res = await fetch(`/api/events/${currentEvent.id}/transcribe`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Nu am putut transcrie audio.');
}

async function processAudioBlob(blob) {
  audioState.busy = true;
  try {
    await postAudioChunk(blob);
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Eroare la trimiterea audio.');
  } finally {
    audioState.busy = false;
    if (audioState.pendingBlob) {
      const nextBlob = audioState.pendingBlob;
      audioState.pendingBlob = null;
      await processAudioBlob(nextBlob);
    }
  }
}

async function startTranslation() {
  if (!currentEvent) {
    alert('Alege sau creează întâi un eveniment.');
    return;
  }
  if (!window.MediaRecorder) {
    alert('Browserul nu suportă MediaRecorder. Folosește Chrome sau Edge pe Surface.');
    return;
  }
  await createAudioPipeline();
  const mimeType = chooseRecorderMimeType();
  if (!mimeType) {
    alert('Browserul nu suportă audio/webm. Folosește Chrome sau Edge.');
    return;
  }
  audioState.running = true;
  audioState.mimeType = mimeType;

  const startRecorderCycle = () => {
    if (!audioState.running) return;
    audioState.chunks = [];
    audioState.recorder = new MediaRecorder(audioState.destination.stream, { mimeType, audioBitsPerSecond: 128000 });
    audioState.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) audioState.chunks.push(event.data);
    };
    audioState.recorder.onstop = async () => {
      const blob = new Blob(audioState.chunks, { type: 'audio/webm' });
      audioState.chunks = [];
      if (blob.size >= 3500) {
        if (audioState.busy) audioState.pendingBlob = blob;
        else await processAudioBlob(blob);
      }
      if (audioState.running) startRecorderCycle();
    };
    audioState.recorder.start();
    audioState.chunkTimer = setTimeout(() => {
      if (audioState.recorder && audioState.recorder.state === 'recording') audioState.recorder.stop();
    }, 5200);
  };

  startRecorderCycle();
  setStatus('Traduce din sursa selectată.');
}

async function stopTranslation() {
  audioState.running = false;
  if (audioState.chunkTimer) {
    clearTimeout(audioState.chunkTimer);
    audioState.chunkTimer = null;
  }
  if (audioState.recorder && audioState.recorder.state === 'recording') {
    audioState.recorder.stop();
    return;
  }
  await destroyAudioPipeline();
  setStatus('Oprit.');
}

socket.on('joined_event', ({ event }) => {
  currentEvent = event;
  currentVolume = event.audioVolume;
  currentMuted = event.audioMuted;
  $('volumeRange').value = String(currentVolume);
  $('audioStateLabel').textContent = currentMuted ? 'Audio global oprit.' : 'Audio global activ.';
  $('transcriptList').innerHTML = '';
  (event.transcripts || []).forEach(renderEntry);
  fillGlossaryLangs(currentEvent.targetLangs || []);
  renderActiveEventBadge(currentEvent);
  closeInlineEditors();
  refreshEventList();
});

socket.on('transcript_entry', (entry) => {
  if (!currentEvent) return;
  currentEvent.transcripts = currentEvent.transcripts || [];
  currentEvent.transcripts.push(entry);
  renderEntry(entry);
});

socket.on('transcript_updated', updateEntry);
socket.on('transcript_source_updated', updateSourceEntry);

socket.on('audio_state', ({ audioMuted, audioVolume }) => {
  currentMuted = audioMuted;
  currentVolume = audioVolume;
  $('volumeRange').value = String(audioVolume);
  $('audioStateLabel').textContent = audioMuted ? 'Audio global oprit.' : 'Audio global activ.';
});
socket.on('partial_transcript', ({ text }) => {
  if ($('partialTranscript')) {
    $('partialTranscript').textContent = text || 'Aștept propoziția completă...';
  }
});

socket.on('transcript_entry', () => {
  if ($('partialTranscript')) {
    $('partialTranscript').textContent = 'Aștept propoziția completă...';
  }
});

socket.on('transcript_source_updated', () => {
  if ($('partialTranscript')) {
    $('partialTranscript').textContent = 'Aștept propoziția completă...';
  }
});
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
    }
  } catch (_) {}
});

$('createEventBtn').addEventListener('click', createEvent);
$('sendManualBtn').addEventListener('click', () => {
  if (!currentEvent) return alert('Alege sau creează întâi un eveniment.');
  const text = $('manualText').value.trim();
  if (!text) return;
  socket.emit('submit_text', { eventId: currentEvent.id, text });
  $('manualText').value = '';
});

$('saveGlossaryBtn').addEventListener('click', async () => {
  if (!currentEvent) return alert('Alege sau creează întâi un eveniment.');
  const source = $('glossarySource').value.trim();
  const target = $('glossaryTarget').value.trim();
  const lang = $('glossaryLang').value;
  const permanent = $('glossaryPermanent').checked;
  if (!source || !target) return;
  const res = await fetch(`/api/events/${currentEvent.id}/glossary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target, lang, permanent })
  });
  const data = await res.json();
  if (data.ok) {
    $('glossarySource').value = '';
    $('glossaryTarget').value = '';
    setStatus('Termen salvat în memorie.');
  }
});

$('muteGlobalBtn').addEventListener('click', () => {
  if (!currentEvent) return;
  currentMuted = !currentMuted;
  socket.emit('set_audio_state', {
    eventId: currentEvent.id,
    audioMuted: currentMuted,
    audioVolume: currentVolume,
    code: currentEvent.adminCode
  });
});

$('panicBtn').addEventListener('click', () => {
  if (!currentEvent) return;
  currentMuted = true;
  currentVolume = 0;
  $('volumeRange').value = '0';
  socket.emit('set_audio_state', {
    eventId: currentEvent.id,
    audioMuted: true,
    audioVolume: 0,
    code: currentEvent.adminCode
  });
});

$('volumeRange').addEventListener('input', () => {
  currentVolume = Number($('volumeRange').value || 70);
  if (!currentEvent) return;
  socket.emit('set_audio_state', {
    eventId: currentEvent.id,
    audioMuted: currentMuted,
    audioVolume: currentVolume,
    code: currentEvent.adminCode
  });
});

$('inputGainRange').addEventListener('input', updateInputGain);
$('monitorAudioBox')?.addEventListener('change', updateMonitorGain);
$('monitorGainRange')?.addEventListener('input', updateMonitorGain);
$('audioInput').addEventListener('change', async () => {
  if (audioState.running) await startTranslation();
  else {
    try {
      await createAudioPipeline();
      setStatus('Sursa audio a fost schimbată.');
    } catch (err) {
      console.error(err);
      setStatus('Nu am putut porni sursa selectată.');
    }
  }
});

$('startRecognitionBtn').addEventListener('click', startTranslation);
$('stopRecognitionBtn').addEventListener('click', stopTranslation);
$('copyParticipantBtn').addEventListener('click', () => copyField('participantLink', 'copyParticipantBtn'));
$('shareParticipantBtn').addEventListener('click', () => shareWhatsApp('participantLink'));
$('copyQrBtn').addEventListener('click', copyQrImage);
$('downloadQrBtn').addEventListener('click', downloadQr);
$('setActiveEventBtn').addEventListener('click', setActiveEvent);
$('refreshEventsBtn').addEventListener('click', refreshEventList);
$('jumpLiveBtn').addEventListener('click', () => {
  sourceEditLock = false;
  closeInlineEditors();
  const first = document.querySelector('#transcriptList .entry');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('eventList').addEventListener('click', async (e) => {
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
        $('adminCode').textContent = '-';
        $('participantLink').value = '';
        $('qrImage').src = '';
        $('transcriptList').innerHTML = '';
        renderActiveEventBadge(null);
      }
      await refreshEventList();
      setStatus('Evenimentul a fost șters.');
    }
  }
});

window.addEventListener('load', async () => {
  const now = new Date();
  $('eventDate').value = now.toISOString().slice(0,10);
  $('eventTime').value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_) {}
  await loadAudioInputs();
  updateInputGain();
  await refreshEventList();
  try {
    const res = await fetch('/api/events/active');
    const data = await res.json();
    if (data.ok && data.event) {
      await openEventById(data.event.id);
    }
  } catch (_) {}
  updateMonitorGain();
});
