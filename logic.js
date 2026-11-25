// Stereo to Mono: DOM-free logic, exercised by the tests against Luna.MockEngine.
//
// A stereo track in LUNA has two pans on its main output, `pan_left` (100L by default) and
// `pan_right` (100R), from -1 to +1. Setting both to 0 sends both channels to the center: the
// track's output is mono, and the audio itself is not touched. Nothing is converted or
// rendered; it is fully reversible.
//
// Level compensation: with a 3 dB pan law (stated by the user), each channel loses 3 dB at the
// center, then the two add up. For identical channels the result is +3 dB, for unrelated
// channels 0 dB. The default compensation, -3 dB, keeps the level of centered sources; it can be
// adjusted. These figures are calculated, not measured in LUNA.
//
// Where the compensation is written is a choice (`target`), because the two places differ and
// which one is better was not established when this was written:
//   - 'output': the output Volume Trim (`gain_trim` on the main output, next to the fader and
//     the pans). LUNA does not display it. Its place in the signal chain relative to inserts and
//     sends has NOT been measured.
//   - 'input': the track's input trim (`input_trim_left` and `input_trim_right`, LUNA's
//     "Utility" line), which LUNA displays. The user found it affects compressor settings and
//     sends, since it sits before the inserts.
// Both trims are always remembered, so "Restore" brings back the right one whichever target
// was used.

const CENTER = 0;
const DEFAULT_LEFT = -1;
const DEFAULT_RIGHT = 1;
const DEFAULT_COMPENSATION_DB = -3;
const TARGETS = ['output', 'input'];
const DEFAULT_TARGET = 'output';
const EPS = 0.001;
// Fold modes: 'sum' (L+R centered), 'left' / 'right' (one channel only, the other cut at -144 dB
// on its input trim, which is zero in LUNA's taper). A single channel is boosted by
// 6 dB over 'sum' so that a signal identical on both sides keeps the same level (calculated from
// the 3 dB pan law, not measured in LUNA).
const MODES = ['sum', 'left', 'right'];
const CUT_DB = -144;
const SINGLE_CHANNEL_BOOST_DB = 6;
// A control's value as LUNA's engine holds it. The SDK's own `real.value` changes at once when
// something is written, and inside a transaction LUNA's confirmation is held until the commit, so
// it cannot tell when a write has really taken effect. Falls back to the SDK value if the engine
// cannot be asked.
const engineReal = async (session, control) => {
  try {
    const node = await session.client.raw.get(control.path);
    const v = node?.properties?.real_value?.value;
    if (v !== undefined) return v;
  } catch {
    /* use the SDK's value */
  }
  return control.real.value;
};
// Waits (up to `ms`) until the engine's value of `control` is `wanted`.
const untilEngine = async (session, control, wanted, ms) => {
  const start = Date.now();
  while ((await engineReal(session, control)) !== wanted) {
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};
// A trim this low is a cut channel (LUNA can store a little above the -144 that was written).
const isCut = (v) => typeof v === 'number' && v <= -100;
// A cut channel is never an "original" value: remembered or restored, it goes back to 0 dB.
const sane = (v) => (isCut(v) ? 0 : v);

// A track's original values ({ left, right, trims, out }) before `setMono`, kept for "Restore".
// They live in memory and, if the page provides one (`useStorage`), in durable storage that
// survives closing the window, per session and per track. With nothing kept, restoring goes back
// to 100L / 100R and removes the current compensation from the input trim and from the output
// Volume Trim, wherever it exactly sits.
const originals = new Map();
let storage = null;

const keyOf = (session, uid) => `${session.uid}/${uid}`;

function remember(session, uid, values) {
  const key = keyOf(session, uid);
  originals.set(key, values);
  try {
    storage?.set(key, values);
  } catch {
    /* storage unavailable: the page's memory is enough while it stays open */
  }
}

function recall(session, uid) {
  const key = keyOf(session, uid);
  if (originals.has(key)) return originals.get(key);
  try {
    const stored = storage?.get(key);
    // `out` is optional: entries kept by an earlier version have none, and then the output
    // Volume Trim is left alone on restore.
    const valid =
      stored &&
      typeof stored.left === 'number' &&
      typeof stored.right === 'number' &&
      Array.isArray(stored.trims) &&
      stored.trims.every((v) => typeof v === 'number' || v === null) &&
      (stored.out === undefined || typeof stored.out === 'number') &&
      (stored.link === undefined || stored.link === null || typeof stored.link === 'boolean') &&
      (stored.inv === undefined || (Array.isArray(stored.inv) && stored.inv.every((v) => typeof v === 'boolean' || v === null)));
    if (valid) return stored;
  } catch {
    /* unreadable: treated as if nothing was kept */
  }
  return undefined;
}

function forget(session, uid) {
  const key = keyOf(session, uid);
  originals.delete(key);
  try {
    storage?.delete(key);
  } catch {
    /* nothing to do */
  }
}

const AddOnLogic = {
  CENTER,
  DEFAULT_COMPENSATION_DB,
  TARGETS,
  DEFAULT_TARGET,
  MODES,
  /** How long (ms) a write waits for the engine to confirm the Link is open, then for it to really act (settle); 0 = do not wait. */
  wait: { link: 1500, settle: 250 },

  /**
   * True for a stereo audio or instrument track (the click, the count-in, buses and mono tracks
   * are left alone). An instrument track has a stereo output like an audio track, but whether
   * LUNA exposes its pans is not verified: a track that does not is listed as unsupported.
   */
  isStereo(track) {
    return track.stemFormat.value === 'stereo' && ['audio', 'instrument'].includes(track.trackType.value);
  },

  /** Uids of the tracks the user unchecked in LUNA's "Tracks" list (hidden in the Mixer and the timeline). */
  hiddenUids(session) {
    const ids = session.context?.hiddenTracks?.value;
    return new Set(Array.isArray(ids) ? ids : []);
  },

  /** The session's stereo tracks that are shown in LUNA (not unchecked in "Tracks"), in LUNA's order. */
  stereoTracks(session) {
    const hidden = AddOnLogic.hiddenUids(session);
    return session.visibleTracks.filter((t) => AddOnLogic.isStereo(t) && !hidden.has(t.uid?.value ?? t.id));
  },

  /** [pan_left, pan_right] of a stereo track, or null if LUNA does not expose them. */
  pans(track) {
    const [left, right] = track.main.pans;
    return left && right ? [left, right] : null;
  },

  /**
   * [input_trim_left, input_trim_right]: the input trim (LUNA's "Utility" line), in dB. A track
   * may have none (an instrument track has no audio input): the values are then not numbers.
   */
  trims(track) {
    return [track.controls.get('input_trim_left'), track.controls.get('input_trim_right')];
  },

  /** The output Volume Trim (`gain_trim` on the main output), in dB. LUNA does not display it. */
  outTrim(track) {
    return track.main.controls.get('gain_trim');
  },

  /**
   * The input trims' Link and the two polarity switches, as { link, inv: [left, right] }: a
   * boolean each, or null where LUNA does not expose the control.
   */
  extras(track) {
    const read = (id) => {
      const v = track.controls.get(id)?.real.value;
      return typeof v === 'boolean' ? v : null;
    };
    return { link: read('input_trim_link'), inv: [read('input_trim_invert_left'), read('input_trim_invert_right')] };
  },

  /** A valid compensation: a finite number of dB, from -12 to +12. */
  validCompensation(db) {
    return typeof db === 'number' && Number.isFinite(db) && db >= -12 && db <= 12;
  },

  /** A valid compensation target: 'output' (Volume Trim) or 'input' (Utility Trim). */
  validTarget(target) {
    return TARGETS.includes(target);
  },

  /**
   * Plugs in durable storage for the original values: an object { get(key), set(key, v),
   * delete(key) }, or null to go without. It may throw; that is tolerated.
   */
  useStorage(adapter) {
    storage = adapter;
  },

  /** Empties the page's memory only, as when the window is closed (useful for tests). */
  dropMemory() {
    originals.clear();
  },

  /** Forgets everything: memory and any plugged-in storage (useful for tests). */
  forgetOriginals() {
    originals.clear();
    storage = null;
  },

  /** One row of the list. */
  trackRow(track, session) {
    const name = track.name.value ?? track.id;
    const pans = AddOnLogic.pans(track);
    const [l, r] = pans ? pans.map((p) => p.real.value) : [undefined, undefined];
    const [inL, inR] = AddOnLogic.trims(track).map((c) => c.real.value);
    const out = AddOnLogic.outTrim(track).real.value;
    const known = [l, r, out].every((v) => typeof v === 'number') && pans !== null;
    const uid = track.uid.value ?? track.id;
    const mono = known && Math.abs(l - CENTER) < EPS && Math.abs(r - CENTER) < EPS;
    const ex = AddOnLogic.extras(track);
    const inNums = [inL, inR].every((v) => typeof v === 'number');
    let mode = 'stereo';
    if (mono) {
      mode = isCut(inR) && !isCut(inL) ? 'left' : isCut(inL) && !isCut(inR) ? 'right' : 'sum';
    }
    return {
      id: track.id,
      uid,
      name,
      supported: known,
      mono,
      // 'stereo', or how a centered track is folded: 'sum', 'left' or 'right'.
      mode,
      // The track's Solo (to listen to it alone while choosing a mode): true or false, or null
      // when LUNA does not expose it.
      solo: typeof track.controls.get('solo')?.real.value === 'boolean' ? track.controls.get('solo').real.value : null,
      // Whether the single-channel modes can be used: both input trims and the Link must be exposed.
      canSplit: known && inNums && ex.link !== null,
      left: pans ? pans[0].display.value ?? '' : '',
      right: pans ? pans[1].display.value ?? '' : '',
      // Current trims in dB, for display: the output Volume Trim and the input (Utility) trims.
      outTrim: typeof out === 'number' ? out : null,
      inTrims: [typeof inL === 'number' ? inL : null, typeof inR === 'number' ? inR : null],
    };
  },

  /** The rows for all stereo tracks. */
  rows(session) {
    return AddOnLogic.stereoTracks(session).map((t) => AddOnLogic.trackRow(t, session));
  },

  /** Totals for the header. */
  summary(rows) {
    return {
      total: rows.length,
      mono: rows.filter((r) => r.mono).length,
      unsupported: rows.filter((r) => !r.supported).length,
    };
  },

  /**
   * Turns the Solo of one stereo track on or off (outside any undo step: it is a listening
   * aid, not an edit of the mix). Whether the other Solos go off is LUNA's own setting
   * (`solo_mode`, see `setSoloMode`): LUNA applies it itself, in one go. Returns false if the
   * track is unknown or has no Solo.
   */
  async setSolo(session, uid, on) {
    const track = AddOnLogic.stereoTracks(session).find((t) => (t.uid.value ?? t.id) === uid);
    const solo = track?.controls.get('solo');
    if (!solo || typeof solo.real.value !== 'boolean') return false;
    if (solo.real.value !== !!on) await solo.real.set(!!on);
    return true;
  },

  /** LUNA's two solo modes, as the Mix Workflow bar names and orders them, and as `solo_mode` holds them. */
  SOLO_MODES: { LATCH: 'latching', 'X-OR': 'exclusive' },

  /** Sets LUNA's solo mode (the same setting as the X-OR / LATCH switch of the Mix Workflow bar). */
  async setSoloMode(luna, session, value) {
    if (!Object.values(AddOnLogic.SOLO_MODES).includes(value)) throw new RangeError(`Unknown solo mode: ${value}`);
    await luna.raw.set(`/sessions/${session.uid}/solo_mode`, value);
  },

  /**
   * Centers (mono) the stereo tracks whose uid is given and folds them as `mode`: 'sum' (L+R),
   * 'left' or 'right' (one channel only), as a single undo step. The compensation `compensationDb` goes to the chosen trim (`target`: the
   * output Volume Trim, or the left and right input trims); a single channel gets 6 dB more.
   * Keeps the original values for `restore`. A track already centered in another mode is switched
   * to `mode` from its original values. Skips tracks already in that mode, tracks whose controls
   * LUNA does not expose (the modes other than 'sum' need both input trims and the Link), and any uid that is not a stereo track. Modes other than 'sum' only work
   * with the 'output' target. Returns { changed: names, skipped: skipped uids }.
   */
  async setMono(session, uids, compensationDb = DEFAULT_COMPENSATION_DB, target = DEFAULT_TARGET, mode = 'sum') {
    if (!AddOnLogic.validCompensation(compensationDb)) throw new RangeError(`Invalid compensation: ${compensationDb} (from -12 to +12 dB)`);
    if (!AddOnLogic.validTarget(target)) throw new RangeError(`Invalid compensation target: ${target} (output or input)`);
    if (!MODES.includes(mode)) throw new RangeError(`Invalid fold mode: ${mode} (${MODES.join(', ')})`);
    if (mode !== 'sum' && target !== 'output') throw new RangeError(`The ${mode} mode needs the output target`);
    const single = mode === 'left' || mode === 'right';
    const outDelta = target === 'output' ? compensationDb + (single ? SINGLE_CHANNEL_BOOST_DB : 0) : 0;
    const stereo = new Map(AddOnLogic.stereoTracks(session).map((t) => [t.uid.value ?? t.id, t]));
    const todo = [];
    const skipped = [];
    for (const uid of new Set(uids)) {
      const track = stereo.get(uid);
      const row = track ? AddOnLogic.trackRow(track, session) : null;
      if (!track || !row.supported || (mode !== 'sum' && !row.canSplit)) skipped.push(uid);
      else if (!row.mono || row.mode !== mode) todo.push({ uid, track, row, pans: AddOnLogic.pans(track), trims: AddOnLogic.trims(track), out: AddOnLogic.outTrim(track), link: track.controls.get('input_trim_link'), invs: [track.controls.get('input_trim_invert_left'), track.controls.get('input_trim_invert_right')] });
    }
    if (todo.length > 0) {
      await session.transaction('Stereo tracks to center (mono)', async () => {
        // All the tracks at once, so that they change together rather than one after the other.
        await Promise.all(todo.map(async ({ uid, track, row, pans, trims, out, link, invs }) => {
          const ex = AddOnLogic.extras(track);
          let before;
          if (!row.mono) {
            // An input trim the track does not have is kept as null and left alone.
            before = { left: pans[0].real.value, right: pans[1].real.value, trims: trims.map((c) => (typeof c.real.value === 'number' ? sane(c.real.value) : null)), out: out.real.value, link: ex.link, inv: ex.inv };
            remember(session, uid, before);
          } else {
            before = recall(session, uid);
            if (before) before = { ...before, trims: before.trims.map((v) => (v === null ? null : sane(v))) };
            if (!before) {
              // Centered without anything kept: rebuild the original from the current state.
              const comp = row.mode === 'left' || row.mode === 'right' ? compensationDb + SINGLE_CHANNEL_BOOST_DB : compensationDb;
              before = {
                left: DEFAULT_LEFT,
                right: DEFAULT_RIGHT,
                trims: trims.map((c) => (typeof c.real.value === 'number' ? (isCut(c.real.value) ? 0 : c.real.value) : null)),
                out: comp !== 0 && Math.abs(out.real.value - comp) < EPS ? 0 : out.real.value,
                link: row.mode === 'left' || row.mode === 'right' ? true : ex.link,
                inv: ex.inv,
              };
              remember(session, uid, before);
            }
          }
          const baseLink = before.link ?? ex.link;
          const baseInv = before.inv ?? ex.inv;
          const trimGoal = single
            ? mode === 'left' ? [before.trims[0], CUT_DB] : [CUT_DB, before.trims[1]]
            : before.trims.map((v) => (target === 'input' && v !== null && compensationDb !== 0 ? v + compensationDb : v));
          const invGoal = baseInv; // polarities are only ever put back as they were
          const splitting = mode !== 'sum' || row.mono;
          // The input trims' Link would move both sides together: open it before anything else
          // changes, so that nothing is heard while it settles. The engine announces the Link open
          // a little before it really acts on it, hence the short extra wait: writing a trim in
          // between would cut both channels.
          if (splitting && ex.link === true) {
            await link.real.set(false);
            await untilEngine(session, link, false, AddOnLogic.wait.link);
            await new Promise((resolve) => setTimeout(resolve, AddOnLogic.wait.settle));
          }
          await pans[0].real.set(CENTER);
          await pans[1].real.set(CENTER);
          for (const [i, c] of trims.entries()) {
            const current = c.real.value;
            if (trimGoal[i] !== null && typeof current === 'number' && Math.abs(trimGoal[i] - current) > EPS) await c.real.set(trimGoal[i]);
          }
          // Each trim must end where it was meant to: if the engine moved one along with the other,
          // set it again.
          for (const [i, c] of trims.entries()) {
            if (trimGoal[i] === null || typeof c.real.value !== 'number') continue;
            const now = await engineReal(session, c);
            if (typeof now === 'number' && Math.abs(now - trimGoal[i]) > EPS) await c.real.set(trimGoal[i]);
          }
          for (const [i, c] of invs.entries()) if (invGoal[i] !== null && ex.inv[i] !== null && invGoal[i] !== c.real.value) await c.real.set(invGoal[i]);
          if (outDelta !== 0 || row.mono) {
            const goal = before.out + outDelta;
            if (Math.abs(goal - out.real.value) > EPS) await out.real.set(goal);
          }
          const linkGoal = single ? false : baseLink;
          if (linkGoal !== null && ex.link !== null && link.real.value !== linkGoal) await link.real.set(linkGoal);
        }));
      });
    }
    return { changed: todo.map((t) => t.track.name.value ?? t.uid), skipped };
  },

  /**
   * Restores the given tracks that are centered: pans, both trims, the Link and the polarities
   * from before `setMono` if they are kept, whichever target and mode were used. Otherwise 100L /
   * 100R, and the compensation `compensationDb` (or that plus 6 dB, for one channel only) is
   * removed from the input trims and from the output Volume Trim where it sits exactly (any other
   * value is left as it is); a cut channel goes back to 0 dB. Returns { changed: names, fromMemory }.
   */
  async restore(session, uids, compensationDb = DEFAULT_COMPENSATION_DB) {
    if (!AddOnLogic.validCompensation(compensationDb)) throw new RangeError(`Invalid compensation: ${compensationDb} (from -12 to +12 dB)`);
    const stereo = new Map(AddOnLogic.stereoTracks(session).map((t) => [t.uid.value ?? t.id, t]));
    const todo = [];
    for (const uid of new Set(uids)) {
      const track = stereo.get(uid);
      if (track && AddOnLogic.trackRow(track, session).mono) {
        todo.push({ uid, track, pans: AddOnLogic.pans(track), trims: AddOnLogic.trims(track), out: AddOnLogic.outTrim(track), link: track.controls.get('input_trim_link'), invs: [track.controls.get('input_trim_invert_left'), track.controls.get('input_trim_invert_right')] });
      }
    }
    // Where the compensation sits when nothing was kept: 0 if it equals the compensation exactly.
    const withoutComp = (current) => {
      for (const c of [compensationDb, compensationDb + SINGLE_CHANNEL_BOOST_DB]) if (c !== 0 && Math.abs(current - c) < EPS) return 0;
      return current;
    };
    let fromMemory = 0;
    if (todo.length > 0) {
      await session.transaction('Stereo tracks restored', async () => {
        await Promise.all(todo.map(async ({ uid, track, pans, trims, out, link, invs }) => {
          const saved = recall(session, uid);
          if (saved) fromMemory++;
          const ex = AddOnLogic.extras(track);
          const cutBefore = trims.some((c) => isCut(c.real.value));
          const trimTargets = trims.map((c, i) => (saved ? (saved.trims[i] === null ? null : sane(saved.trims[i])) : isCut(c.real.value) ? 0 : withoutComp(c.real.value)));
          const outTarget = saved ? (typeof saved.out === 'number' ? saved.out : out.real.value) : withoutComp(out.real.value);
          await pans[0].real.set(saved ? saved.left : DEFAULT_LEFT);
          await pans[1].real.set(saved ? saved.right : DEFAULT_RIGHT);
          for (const [i, c] of trims.entries()) {
            const current = c.real.value;
            if (typeof trimTargets[i] === 'number' && typeof current === 'number' && Math.abs(trimTargets[i] - current) > EPS) await c.real.set(trimTargets[i]);
          }
          if (saved?.inv) for (const [i, c] of invs.entries()) if (saved.inv[i] !== null && ex.inv[i] !== null && saved.inv[i] !== c.real.value) await c.real.set(saved.inv[i]);
          if (Math.abs(outTarget - out.real.value) > EPS) await out.real.set(outTarget);
          const linkTarget = saved ? saved.link : cutBefore ? true : null;
          if (typeof linkTarget === 'boolean' && ex.link !== null && link.real.value !== linkTarget) await link.real.set(linkTarget);
          forget(session, uid);
        }));
      });
    }
    return { changed: todo.map((t) => t.track.name.value ?? t.uid), fromMemory };
  },
};

globalThis.AddOnLogic = AddOnLogic;
