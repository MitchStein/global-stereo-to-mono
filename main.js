// Stereo to Mono: DOM wiring. Connects to LUNA, follows the focused session and renders what
// logic.js computes. Every listener returned by onChange is kept so it can be released when the
// session changes.

const $ = (id) => document.getElementById(id);

let luna;
let session;
let releases = [];
let generation = 0; // invalidates a refresh() made obsolete while it was awaiting
let busy = false;
let soloModeValue = null; // LUNA's solo mode, read from the engine ('exclusive' or 'latching')
let foldMode = 'sum'; // what the "Set all stereo tracks to mono" button does
let fitted = false; // the window is fitted to its content once per page load

// Original values of the tracks set to mono, kept in this page's web storage so that "Restore"
// still works after the window is closed. Keys are prefixed with the Add On's id. Storage can be
// missing or throw (private window, cleared data): the logic tolerates it and falls back to the
// page's memory.
const STORAGE_PREFIX = 'com.example.stereo_to_mono.originals/';
const webStorage = {
  get(key) {
    const text = localStorage.getItem(STORAGE_PREFIX + key);
    return text === null ? undefined : JSON.parse(text);
  },
  set(key, value) {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  },
  delete(key) {
    localStorage.removeItem(STORAGE_PREFIX + key);
  },
};

// The global button's choices, and the per-track switch positions (in order).
const FOLD_CHOICES = [
  ['sum', 'L+R', 'Sum the two channels (the usual mono check)'],
  ['left', 'L', 'Keep the left channel only'],
  ['right', 'R', 'Keep the right channel only'],
];
const POSITIONS = [
  ['stereo', 'STEREO', 'Restore this track to stereo'],
  ['sum', 'L+R', 'Set this track to mono by summing the two channels'],
  ['left', 'L', 'Keep the left channel only'],
  ['right', 'R', 'Keep the right channel only'],
];

const fmtDb = (n) => (n === null ? '?' : `${n > 0 ? '+' : ''}${n.toFixed(1)}`);

const keep = (u) => releases.push(u);
const release = () => {
  for (const u of releases) u();
  releases = [];
};

// A change signalled by LUNA while GSM is writing (one action = many writes) must not redraw the
// list half-way: the final render() of run() shows the result.
const softRender = () => {
  if (!busy) render();
};

const say = (text) => { $('status').textContent = text; $('status').title = text; };
const plural = (n, one, many) => (n === 1 ? one : many);
const allUids = (rows) => rows.map((r) => r.uid);

function render() {
  if (!session) return;
  const rows = AddOnLogic.rows(session);
  const s = AddOnLogic.summary(rows);

  $('summary').textContent =
    rows.length === 0
      ? 'No stereo tracks in this session.'
      : `${s.total} stereo track${plural(s.total, '', 's')}: ` + (s.mono === 0 ? 'none in mono yet' : s.mono === s.total ? 'all in mono' : `${s.mono} in mono`);

  const notice = $('notice');
  notice.hidden = s.unsupported === 0;
  notice.textContent = `${s.unsupported} track${plural(s.unsupported, '', 's')} skipped: pans or level not exposed by LUNA`;
  notice.title = notice.textContent;

  $('to-mono').disabled = busy || !rows.some((r) => r.supported && (foldMode === 'sum' || r.canSplit) && r.mode !== foldMode);
  renderFold();
  renderSolo();
  $('to-stereo').disabled = busy || !rows.some((r) => r.mono);

  const root = $('tracks');
  root.innerHTML = '';
  $('cols').hidden = rows.length === 0;
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Stereo tracks will appear here.';
    root.appendChild(empty);
    return;
  }
  // The track colour as LUNA stores it (ARGB), for a soft gradient behind the name.
  const colors = new Map(AddOnLogic.stereoTracks(session).map((t) => [t.uid.value ?? t.id, Number(t.color?.value)]));
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'grid track' + (row.mono ? ' is-mono' : '');
    const argb = colors.get(row.uid);
    if (Number.isFinite(argb)) {
      const [r, g, b] = [(argb >>> 16) & 255, (argb >>> 8) & 255, argb & 255];
      line.style.background = `linear-gradient(90deg, rgba(${r},${g},${b},.42), rgba(${r},${g},${b},0) 62%)`;
    } else if (row.mono) {
      line.style.background = 'linear-gradient(90deg, rgba(247,196,73,.14), transparent 60%)';
    }
    const name = document.createElement('span');
    name.className = 'name';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = row.name;
    title.title = row.name;
    name.append(title);
    line.append(name);
    // Solo, to listen to this track alone while choosing how to fold it.
    const solo = document.createElement('button');
    solo.className = 'solo' + (row.solo ? ' on' : '');
    solo.textContent = 'S';
    solo.disabled = busy || row.solo === null;
    solo.onclick = () => run(() => AddOnLogic.setSolo(session, row.uid, !row.solo));
    line.append(solo);
    if (!row.supported) {
      const off = document.createElement('span');
      off.className = 'pill unsupported';
      off.textContent = 'unsupported';
      line.append(off);
    } else {
      // The active position is the track's state; a click on another position switches this
      // track alone (one undo step). L and R need the input trims and their Link.
      const sw = document.createElement('span');
      sw.className = 'switch';
      for (const [mode, label, hint] of POSITIONS) {
        const btn = document.createElement('button');
        const active = row.mode === mode;
        const unavailable = !['stereo', 'sum'].includes(mode) && !row.canSplit;
        btn.className = 'seg' + (active ? ' active' : '');
        btn.textContent = label;
        btn.disabled = busy || unavailable;
        btn.title = unavailable ? 'LUNA does not expose this track\'s input trims or their Link' : active ? '' : hint;
        if (!active) btn.onclick = () => (mode === 'stereo' ? toStereo([row.uid]) : toMono([row.uid], mode));
        sw.append(btn);
      }
      line.append(sw);
    }
    root.appendChild(line);
  }
}

// The "Fold with" choice of the global button, kept for next time in web storage when available.
function renderFold() {
  const box = $('fold-modes');
  box.innerHTML = '';
  for (const [mode, label, hint] of FOLD_CHOICES) {
    const btn = document.createElement('button');
    btn.className = 'seg' + (mode === foldMode ? ' active' : '');
    btn.textContent = label;
    btn.title = hint;
    btn.disabled = busy;
    if (mode !== foldMode) {
      btn.onclick = () => {
        foldMode = mode;
        try {
          localStorage.setItem(STORAGE_PREFIX + 'fold', mode);
        } catch {
          /* kept for this page only */
        }
        render();
      };
    }
    box.append(btn);
  }
}

// The SDK does not refresh its own view of `solo_mode`, so it is read from the engine: after a
// click here, when the session changes, and every second or so in case it was changed in LUNA.
async function readSoloMode() {
  if (!session) return;
  try {
    const node = await luna.raw.get(`/sessions/${session.uid}/solo_mode`);
    if (node?.value !== soloModeValue) {
      soloModeValue = node?.value ?? null;
      render();
    }
  } catch {
    /* the next poll tries again */
  }
}

// "Solo: X-OR / LATCH": LUNA's own solo mode (the switch of the Mix Workflow bar), shown and
// changed here. X-OR: a Solo click listens to that track alone. LATCH: solos add up.
function renderSolo() {
  const box = $('solo-modes');
  box.innerHTML = '';
  for (const [label, value] of Object.entries(AddOnLogic.SOLO_MODES)) {
    const btn = document.createElement('button');
    const active = soloModeValue === value;
    btn.className = 'seg' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = busy;
    if (!active) btn.onclick = () => run(async () => {
      await AddOnLogic.setSoloMode(luna, session, value);
      await readSoloMode();
    });
    box.append(btn);
  }
}

// One action at a time on the engine; any error is shown in the header.
async function run(action) {
  if (busy || !session) return;
  busy = true;
  say('');
  render();
  try {
    await action();
  } catch (e) {
    say(`Error: ${e && e.code ? e.code + ' ' : ''}${e && e.message ? e.message : String(e)}`);
  } finally {
    busy = false;
    render();
  }
}

// The level compensation is fixed: 3 dB, the pan law of LUNA.
const compensation = () => AddOnLogic.DEFAULT_COMPENSATION_DB;
// No message after an action: the diagnostic line and the list show the result. Only errors
// are written to the header (see run()).
const toMono = (uids, mode) =>
  run(async () => {
    await AddOnLogic.setMono(session, uids ?? allUids(AddOnLogic.rows(session)), compensation(), 'output', mode ?? foldMode);
  });

const toStereo = (uids) =>
  run(async () => {
    await AddOnLogic.restore(session, uids ?? allUids(AddOnLogic.rows(session)), compensation());
  });

// Opens the window at a size that fits the list: rows of about 40 points under a header of about
// 230. LUNA clamps it to the manifest limits. Only once per page load, so a size the user sets
// afterwards is respected; quietly skipped outside LUNA or on a LUNA without instances.
async function fitWindow() {
  try {
    const me = await luna.gui?.thisInstance();
    if (!me || me.target.value !== 'window') return;
    const rows = AddOnLogic.rows(session);
    const unsupported = rows.filter((r) => !r.supported).length > 0;
    await me.resize(560, 248 + rows.length * 40 + (unsupported ? 44 : 0));
  } catch {
    /* fixed size, read-only or older LUNA: the manifest size stays */
  }
}

// Reloading every track is heavy: only done when the list of tracks or a format really changes,
// not for each value LUNA reports while GSM is writing.
let trackSignature = '';
let reordering = false;
const signature = () => session.visibleTracks.map((t) => `${t.id}:${t.stemFormat.value}`).join('|') + '#' + [...AddOnLogic.hiddenUids(session)].sort().join(',');
function tracksChanged() {
  if (signature() === trackSignature) return softRender();
  return refresh();
}

// Reloads the list and resubscribes the listeners. Rerun when tracks or their format change.
async function refresh() {
  const mine = ++generation;
  release();
  // loadStrip loads the main output (pans, output Volume Trim); controls.load() loads the
  // track's own controls (input trim, the "Utility" line).
  await Promise.all(session.visibleTracks.map((t) => Promise.all([t.loadStrip(), t.controls.load()])));
  if (mine !== generation) return;
  trackSignature = signature();
  keep(session.tracks.onChange(tracksChanged));
  keep(session.context?.hiddenTracks?.onChange(tracksChanged)); // tracks checked or unchecked in LUNA's "Tracks" list
  for (const track of session.visibleTracks) {
    keep(track.name.onChange(softRender));
    keep(track.color?.onChange?.(softRender));
    keep(track.stemFormat.onChange(tracksChanged));
    for (const pan of track.main.pans) keep(pan.real.onChange(softRender));
    for (const trim of AddOnLogic.trims(track)) keep(trim.real.onChange(softRender));
    keep(AddOnLogic.outTrim(track).real.onChange(softRender));
    keep(track.controls.get('solo').real.onChange(softRender));
    keep(track.controls.get('input_trim_link').real.onChange(softRender));
  }
  render();
  if (!fitted && AddOnLogic.rows(session).length > 0) {
    fitted = true;
    await fitWindow();
  }
}

async function bindSession() {
  generation++;
  release();
  session = luna.sessions.current();
  if (!session) {
    say('no session open');
    $('tracks').innerHTML = '';
    $('cols').hidden = true;
    $('summary').textContent = '';
    $('notice').hidden = true;
    $('to-mono').disabled = true;
    $('to-stereo').disabled = true;
    return;
  }
  await session.ready();
  say('');
  await refresh();
  await readSoloMode();
}

async function connect() {
  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on localhost.
      luna = await Luna.connect();
      break;
    } catch (e) {
      say(e instanceof Luna.NotRunning ? 'waiting for LUNA...' : e.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's standard undo, redo, play and record keys.
  Luna.bindShortcuts(luna);
  AddOnLogic.useStorage(webStorage);
  try {
    const saved = localStorage.getItem(STORAGE_PREFIX + 'fold');
    if (FOLD_CHOICES.some(([m]) => m === saved)) foldMode = saved;
  } catch {
    /* default: sum */
  }

  setInterval(readSoloMode, 1200);
  // LUNA does not announce a track being moved: compare the order read now with the one shown.
  setInterval(() => {
    try {
      if (session && trackSignature && !reordering && signature() !== trackSignature) {
        reordering = true;
        Promise.resolve(tracksChanged()).finally(() => { reordering = false; });
      }
    } catch { /* session closing */ }
  }, 800);
  $('to-mono').onclick = () => toMono();
  $('to-stereo').onclick = () => toStereo();

  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') say('reconnecting...');
  });
  await bindSession();
}

connect();
