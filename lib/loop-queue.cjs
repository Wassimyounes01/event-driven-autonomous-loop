'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** @type {object | null | undefined} */
let _core;
/** @type {object | null} */
let _state = null;
/** @type {string | null} */
let _statePathOverride = process.env.CONTINUOUS_LOOP_STATE_PATH || null;
/** Serializes assertNextOrRefill so concurrent wakes cannot double-refill. */
let _assertChain = Promise.resolve();

function getCore() {
  if (_core !== undefined) return _core;
  try {
    _core = require('./core.cjs');
  } catch {
    _core = null;
  }
  return _core;
}

function getStatePath() {
  if (_statePathOverride) return _statePathOverride;
  const core = getCore();
  if (core?.paths?.memory) {
    return path.join(core.paths.memory, 'continuous-loop-state.json');
  }
  return path.join(__dirname, '..', 'memory', 'continuous-loop-state.json');
}

/** @returns {{ loop: string, goal: string, in_flight: object|null, queue: object[], done: object[], history: object[], updated_at: string|null }} */
function emptyState(loop = '') {
  return { loop, goal: '', in_flight: null, queue: [], done: [], history: [], updated_at: null };
}

function shapeState(obj) {
  if (!obj || typeof obj !== 'object') return emptyState();
  return {
    loop: typeof obj.loop === 'string' ? obj.loop : '',
    goal: typeof obj.goal === 'string' ? obj.goal : '',
    in_flight: obj.in_flight && typeof obj.in_flight === 'object' ? obj.in_flight : null,
    queue: Array.isArray(obj.queue) ? obj.queue : [],
    done: Array.isArray(obj.done) ? obj.done.slice(-200) : [],
    history: Array.isArray(obj.history) ? obj.history.slice(-200) : [],
    updated_at: obj.updated_at ?? null,
  };
}

function readState() {
  try {
    return shapeState(JSON.parse(fs.readFileSync(getStatePath(), 'utf8')));
  } catch {
    return emptyState();
  }
}

function atomicWrite(data, updatedAt) {
  const filePath = getStatePath();
  const state = { ...data, updated_at: updatedAt ?? data.updated_at ?? null };
  let json;
  try {
    json = JSON.stringify(state, null, 2);
  } catch {
    return state;
  }
  const core = getCore();
  if (core?.saveJSON) {
    try {
      core.saveJSON(filePath, state);
      return state;
    } catch { /* fall through to paired write */ }
  }
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fail-open */ }
  const tmp = `${filePath}.tmp.${process.pid}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, filePath);
      return state;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* */ }
      if (err?.code === 'ENOENT' && attempt < 4) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* */ }
        continue;
      }
      if (attempt === 4) return state;
    }
  }
  return state;
}

function ensureState() {
  if (!_state) _state = readState();
  return _state;
}

function persist(updatedAt) {
  _state = atomicWrite(_state, updatedAt);
  return _state;
}

/** @param {object|null} u */
function cloneUnit(u) {
  return u && typeof u === 'object' ? { ...u } : u;
}

/** @param {object} s */
function cloneState(s) {
  return {
    loop: s.loop,
    goal: s.goal,
    in_flight: s.in_flight
      ? { ...s.in_flight, unit: cloneUnit(s.in_flight.unit) }
      : null,
    queue: s.queue.map(cloneUnit),
    done: s.done.map(cloneUnit),
    history: s.history.map((h) => ({ ...h })),
    updated_at: s.updated_at,
  };
}

function knownIds(state) {
  const ids = new Set();
  for (const u of state.queue) {
    if (u?.id != null) {
      const id = String(u.id).trim();
      if (id) ids.add(id);
    }
  }
  if (state.in_flight?.unit?.id != null) {
    const id = String(state.in_flight.unit.id).trim();
    if (id) ids.add(id);
  }
  for (const u of state.done) {
    if (u?.id != null) {
      const id = String(u.id).trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}

function normalizeUnit(u) {
  if (!u || typeof u !== 'object') return null;
  const id = u.id != null ? String(u.id).trim() : '';
  const title = typeof u.title === 'string' ? u.title.trim() : '';
  if (!id || !title) return null;
  return { ...u, id, title };
}

function normalizeTaskId(taskId) {
  return String(taskId ?? '').trim();
}

function pushHistory(state, event, unitId, ts) {
  state.history.push({ ts: ts ?? '', event, unit_id: unitId != null ? String(unitId) : '' });
  if (state.history.length > 200) state.history = state.history.slice(-200);
}

function trimDone(state) {
  if (state.done.length > 200) state.done = state.done.slice(-200);
}

function acceptUnits(list, ids) {
  const out = [];
  const src = Array.isArray(list) ? list : [];
  for (let i = 0; i < src.length; i++) {
    const u = normalizeUnit(src[i]);
    if (!u || ids.has(u.id)) continue;
    out.push(u);
    ids.add(u.id);
  }
  return out;
}

/** @returns {object} */
function load() {
  _state = readState();
  return cloneState(_state);
}

/**
 * @param {string} loop
 * @param {string} goal
 * @param {object[]} [units]
 * @param {{ updated_at?: string }} [opts]
 * @returns {object}
 */
function start(loop, goal, units = [], opts = {}) {
  const prev = ensureState();
  const loopName = typeof loop === 'string' ? loop : String(loop ?? '');
  const goalStr = typeof goal === 'string' ? goal : String(goal ?? '');
  if (prev.loop === loopName && prev.in_flight !== null) {
    prev.goal = goalStr;
    const ids = knownIds(prev);
    const added = acceptUnits(units, ids);
    for (let i = 0; i < added.length; i++) prev.queue.push(added[i]);
    persist(opts.updated_at);
    return cloneState(_state);
  }
  const ids = new Set();
  _state = {
    loop: loopName,
    goal: goalStr,
    in_flight: null,
    queue: acceptUnits(units, ids),
    done: [],
    history: prev.loop === loopName ? prev.history.slice(-200) : [],
    updated_at: null,
  };
  persist(opts.updated_at);
  return cloneState(_state);
}

/**
 * @param {object|object[]} units
 * @param {{ updated_at?: string }} [opts]
 * @returns {number}
 */
function enqueue(units, opts = {}) {
  const state = ensureState();
  const list = Array.isArray(units) ? units : [units];
  const ids = knownIds(state);
  const added = acceptUnits(list, ids);
  for (let i = 0; i < added.length; i++) state.queue.push(added[i]);
  if (added.length) persist(opts.updated_at);
  return added.length;
}

/** @returns {object|null} */
function peek() {
  const q = ensureState().queue;
  return q.length ? cloneUnit(q[0]) : null;
}

/**
 * @param {object} unit
 * @param {string|number} taskId
 * @param {{ launched_at?: string, ts?: string, updated_at?: string }} [opts]
 * @returns {object}
 */
function launch(unit, taskId, opts = {}) {
  const state = ensureState();
  const norm = normalizeUnit(unit);
  const stored = cloneUnit(norm || (unit && typeof unit === 'object' ? unit : { id: '', title: '' }));
  const record = {
    unit: stored,
    task_id: normalizeTaskId(taskId),
    launched_at: opts.launched_at ?? '',
  };
  state.in_flight = record;
  const uidKey = stored?.id != null ? String(stored.id).trim() : '';
  if (uidKey) {
    state.queue = state.queue.filter((u) => String(u?.id ?? '').trim() !== uidKey);
  }
  pushHistory(state, 'launch', stored?.id, opts.ts);
  persist(opts.updated_at);
  return { ...record, unit: cloneUnit(record.unit) };
}

/**
 * @param {string|number} taskId
 * @param {*} result
 * @param {{ completed_at?: string, ts?: string, updated_at?: string }} [opts]
 * @returns {object|null}
 */
function complete(taskId, result, opts = {}) {
  const state = ensureState();
  const want = normalizeTaskId(taskId);
  if (!state.in_flight || normalizeTaskId(state.in_flight.task_id) !== want) return null;
  const completed = {
    ...state.in_flight.unit,
    result,
    completed_at: opts.completed_at ?? '',
  };
  state.done.push(completed);
  trimDone(state);
  pushHistory(state, 'complete', state.in_flight.unit?.id, opts.ts);
  state.in_flight = null;
  persist(opts.updated_at);
  return cloneUnit(completed);
}

/** @returns {{ loop: string, goal: string, in_flight: object|null, next: object|null, queue_len: number, done_len: number, idle: boolean }} */
function status() {
  const s = ensureState();
  return {
    loop: s.loop,
    goal: s.goal,
    in_flight: s.in_flight
      ? { ...s.in_flight, unit: cloneUnit(s.in_flight.unit) }
      : null,
    next: peek(),
    queue_len: s.queue.length,
    done_len: s.done.length,
    idle: s.in_flight === null && s.queue.length === 0,
  };
}

/**
 * Never-idle core: wait | launch | stop (only after genuine empty refill).
 * @param {() => object[]|Promise<object[]>} [refill]
 * @returns {Promise<object>}
 */
async function assertNextOrRefill(refill) {
  const run = _assertChain.then(() => _assertNextOrRefillBody(refill));
  _assertChain = run.then(() => undefined, () => undefined);
  return run;
}

async function _assertNextOrRefillBody(refill) {
  let state = ensureState();
  if (state.in_flight) {
    return { action: 'wait', in_flight: { ...state.in_flight, unit: cloneUnit(state.in_flight.unit) } };
  }
  if (state.queue.length) return { action: 'launch', unit: peek() };

  let units = [];
  try {
    const raw = typeof refill === 'function' ? await refill() : [];
    units = Array.isArray(raw) ? raw : [];
  } catch {
    units = [];
  }

  if (units.length) enqueue(units);

  state = ensureState();
  if (state.in_flight) {
    return { action: 'wait', in_flight: { ...state.in_flight, unit: cloneUnit(state.in_flight.unit) } };
  }
  if (state.queue.length) return { action: 'launch', unit: peek() };
  return { action: 'stop', reason: 'no work after refill' };
}

/**
 * @param {string} [loop]
 * @param {{ updated_at?: string }} [opts]
 * @returns {object}
 */
function reset(loop = '', opts = {}) {
  _state = emptyState(typeof loop === 'string' ? loop : String(loop ?? ''));
  persist(opts.updated_at);
  return cloneState(_state);
}

function runSelfTest() {
  const tmp = path.join(os.tmpdir(), `continuous-loop-selftest-${process.pid}.json`);
  _statePathOverride = tmp;
  _state = null;
  _assertChain = Promise.resolve();
  try { fs.unlinkSync(tmp); } catch { /* */ }

  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`FAIL: ${msg}`);
      process.exit(1);
    }
  };

  const u1 = { id: 'u1', title: 'one' };
  const u2 = { id: 'u2', title: 'two' };
  start('test-loop', 'goal', [u1, u2]);
  assert(status().idle === false, 'idle after start');

  launch(u1, 't1');
  assert(status().in_flight?.task_id === 't1', 'in_flight task_id');
  assert(status().queue_len === 1, 'queue_len after launch');

  return assertNextOrRefill()
    .then((r1) => {
      assert(r1.action === 'wait', 'wait while in flight');
      complete('t1', { ok: true });
      assert(status().done_len === 1, 'done_len');
      assert(status().in_flight === null, 'in_flight cleared');
      return assertNextOrRefill();
    })
    .then((r2) => {
      assert(r2.action === 'launch' && r2.unit?.id === 'u2', 'launch u2');
      launch(u2, 't2');
      complete('t2', { ok: true });
      return assertNextOrRefill(() => []);
    })
    .then((r3) => {
      assert(r3.action === 'stop', 'stop after empty refill');
      return assertNextOrRefill(() => [{ id: 'u3', title: 'x' }]);
    })
    .then((r4) => {
      assert(r4.action === 'launch' && r4.unit?.id === 'u3', 'launch after refill');
      assert(enqueue({ id: 'u3', title: 'x' }) === 0, 'dedupe enqueue');
      try { fs.unlinkSync(tmp); } catch { /* */ }
      console.log('continuous-loop OK');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

function runCli() {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log([
      'loop-queue — durable never-idle work queue for autonomous agent sessions.',
      '',
      'Usage:',
      '  node lib/loop-queue.cjs            print the current queue status',
      '  node lib/loop-queue.cjs reset [name]   clear the queue (optionally name the loop)',
      '  node lib/loop-queue.cjs --self-test    run the built-in invariants check',
      '  node lib/loop-queue.cjs --help         show this message',
      '',
      'As a library it exports: load, start, enqueue, peek, launch, complete,',
      'status, assertNextOrRefill, reset. The core call assertNextOrRefill(refill)',
      'returns exactly one of { action: "wait" | "launch" | "stop" } — never a',
      'fourth idle state. State persists to CONTINUOUS_LOOP_STATE_PATH',
      '(default ./memory/continuous-loop-state.json). See examples/demo.cjs.',
    ].join('\n'));
    process.exit(0);
    return;
  }
  if (arg === '--self-test') {
    runSelfTest();
    return;
  }
  if (arg === 'reset') {
    reset(process.argv[3] || '');
    process.exit(0);
    return;
  }
  const s = status();
  console.log(`loop: ${s.loop || '(none)'}`);
  if (s.in_flight) {
    console.log(`in_flight: ${s.in_flight.task_id} — ${s.in_flight.unit?.title || ''}`);
  } else {
    console.log('in_flight: (none)');
  }
  console.log(`next: ${s.next?.title || '(none)'}`);
  console.log(`queue_len: ${s.queue_len}`);
  console.log(`idle: ${s.idle}`);
  process.exit(0);
}

module.exports = {
  load,
  start,
  enqueue,
  peek,
  launch,
  complete,
  status,
  assertNextOrRefill,
  reset,
};

if (require.main === module) {
  runCli();
}
