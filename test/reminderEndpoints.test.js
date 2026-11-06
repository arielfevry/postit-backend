const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateReminder, isId } = require('../lib/reminderValidation');
const { createReminderWorker, workerConfig } = require('../workers/reminderWorker');
const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const itemId = 'cccccccccccccccccccccccc';
const id = n => n.toString(16).padStart(24, '0');
function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, Date, require(name) { if (name in deps) return deps[name]; throw Error(name); }, console: { error() {} }
  });
  return module.exports;
}
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every(q => matches(row, q));
    if (key === '$or') return value.some(q => matches(row, q));
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, b]) => {
      if (op === '$lt') return actual < b;
      if (op === '$lte') return actual != null && actual <= b;
      if (op === '$gt') return actual > b;
      if (op === '$gte') return actual >= b;
      if (op === '$ne') return b === null ? actual != null : actual !== b;
      if (op === '$exists') return (actual !== undefined) === b;
      throw Error(op);
    });
    return value === null ? actual == null : actual === value;
  });
}
function fixture(overrides = []) {
  const rows = overrides.map((patch, index) => ({ _id: id(index + 1), userId: owner, itemId,
    channel: 'email', recipient: 'test@example.com', message: 'Test', remindAt: new Date('2029-01-01'),
    status: 'pending', attempts: 0, deliveryAuthorized: true, deliveryMode: null,
    claimToken: 'private', leaseUntil: null, nextAttemptAt: null, ...patch }));
  const queries = [];
  function query(values) {
    let sort; let skip = 0; let limit = Infinity;
    return { select(projection) { assert.equal(projection, '-claimToken -leaseUntil'); return this; },
      sort(value) { sort = value; return this; }, skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
      async lean() {
        if (!Array.isArray(values)) return values && structuredClone(values);
        const ordered = [...values];
        if (sort) ordered.sort((a, b) => +a.remindAt - +b.remindAt || a._id.localeCompare(b._id));
        return structuredClone(ordered.slice(skip, skip + limit));
      }, then(resolve, reject) { return this.lean().then(resolve, reject); }
    };
  }
  function apply(row, update) { Object.assign(row, update.$set); for (const [key, value] of Object.entries(update.$inc || {})) row[key] += value; }
  const Reminder = {
    find(q) { queries.push(q); return query(rows.filter(row => matches(row, q))); },
    findOne(q) { queries.push(q); return query(rows.find(row => matches(row, q)) || null); },
    findOneAndUpdate(q, update) {
      queries.push(q); const row = rows.find(row => matches(row, q));
      if (row) apply(row, update);
      return query(row ? structuredClone(row) : null);
    },
    async updateMany(q, update) { rows.filter(row => matches(row, q)).forEach(row => apply(row, update)); },
    async updateOne(q, update) { const row = rows.find(row => matches(row, q)); if (row) apply(row, update); return { matchedCount: row ? 1 : 0 }; }
  };
  const controller = load('controllers/reminderController.js', { '../models/Reminder': Reminder,
    '../models/Item': {}, '../lib/reminderValidation': { validateReminder, isId } });
  async function call(method, { user = owner, params = { id: id(1) }, query = {} } = {}) {
    const res = response(); await controller[method]({ user: user ? { id: user } : undefined, params, query }, res); return res;
  }
  return { rows, Reminder, queries, call };
}
function privateFieldsAbsent(value) { assert.equal(Object.hasOwn(value, 'claimToken'), false); assert.equal(Object.hasOwn(value, 'leaseUntil'), false); }

test('all new routes use existing shared authentication middleware', () => {
  const registered = []; const authenticate = () => {}; const handlers = { createReminder() {}, getReminders() {}, getReminder() {}, cancelReminder() {} };
  const router = Object.fromEntries(['post', 'get', 'delete'].map(method => [method, (...args) => registered.push({ method, args })]));
  load('routes/reminders.js', { express: { Router: () => router }, '../middleware/authenticate': authenticate, '../controllers/reminderController': handlers });
  assert.deepEqual(registered.map(r => [r.method, r.args[0]]), [['post', '/'], ['get', '/'], ['get', '/:id'], ['delete', '/:id']]);
  for (const route of registered) assert.equal(route.args[1], authenticate);
});
test('GET and DELETE controllers fail closed without authenticated identity', async () => {
  const f = fixture([{}]);
  for (const method of ['getReminders', 'getReminder', 'cancelReminder']) assert.equal((await f.call(method, { user: null })).code, 401);
  assert.equal(f.queries.length, 0);
});
test('list isolates owners and legacy rows, filters, paginates ties stably, and omits coordination state', async () => {
  const f = fixture([{}, {}, {}, { userId: other }, { userId: null }, { userId: undefined }, { status: 'sent' }, { itemId: other }]);
  let res = await f.call('getReminders', { query: { itemId, status: 'pending', limit: '2' } });
  assert.equal(res.code, 200); assert.deepEqual(res.body.reminders.map(r => r._id), [id(1), id(2)]);
  assert.equal(res.body.pagination.hasMore, true); res.body.reminders.forEach(privateFieldsAbsent);
  res = await f.call('getReminders', { query: { itemId, status: 'pending', limit: '2', page: '2' } });
  assert.deepEqual(res.body.reminders.map(r => r._id), [id(3)]); assert.equal(res.body.pagination.hasMore, false);
  res = await f.call('getReminders', { query: { page: '10000' } }); assert.equal(res.body.reminders.length, 0);
  res = await f.call('getReminders'); assert.equal(res.body.pagination.limit, 20); assert.equal(res.body.pagination.page, 1);
});
test('invalid IDs and query values return 400 before database access', async () => {
  const f = fixture([{}]);
  for (const value of ['bad', '', ['a'], { $ne: null }]) {
    for (const method of ['getReminder', 'cancelReminder']) assert.equal((await f.call(method, { params: { id: value } })).code, 400);
    assert.equal((await f.call('getReminders', { query: { itemId: value } })).code, 400);
  }
  for (const query of [{ status: 'bad' }, { status: ['pending'] }, { userId: other }, { limit: '101' }, { limit: '0' }, { limit: '2.5' }, { page: '-1' }, { page: '10001' }, { page: ['1'] }, { limit: { $gt: 0 } }]) {
    assert.equal((await f.call('getReminders', { query })).code, 400);
  }
  assert.equal(f.queries.length, 0);
});
test('individual GET and cancellation conceal other owners, missing and legacy reminders', async () => {
  for (const patch of [{ userId: other }, { userId: null }, { userId: undefined }]) {
    const f = fixture([patch]);
    for (const method of ['getReminder', 'cancelReminder']) assert.equal((await f.call(method)).code, 404);
    assert.equal(f.rows[0].status, 'pending');
  }
  const f = fixture([]);
  for (const method of ['getReminder', 'cancelReminder']) assert.equal((await f.call(method)).code, 404);
  const owned = await fixture([{}]).call('getReminder'); assert.equal(owned.code, 200); privateFieldsAbsent(owned.body.reminder);
});
test('pending retry cancellation is atomic, preserves history and is idempotent', async () => {
  const f = fixture([{ attempts: 2, nextAttemptAt: new Date('2099-01-01') }]);
  const first = await f.call('cancelReminder'); assert.equal(first.code, 200); privateFieldsAbsent(first.body.reminder);
  assert.equal(f.rows[0].status, 'cancelled'); assert.ok(f.rows[0].cancelledAt instanceof Date);
  assert.equal(f.rows[0].attempts, 2); assert.equal(f.rows[0].nextAttemptAt, null); assert.equal(f.rows[0].claimToken, null); assert.equal(f.rows[0].leaseUntil, null);
  assert.equal(f.queries[0].status, 'pending'); assert.equal(f.queries[0].userId, owner);
  const second = await f.call('cancelReminder'); assert.equal(second.code, 200); assert.equal(+second.body.reminder.cancelledAt, +first.body.reminder.cancelledAt);
});
test('processing, sent and failed cannot be cancelled or lose delivery history', async () => {
  for (const status of ['processing', 'sent', 'failed']) {
    const f = fixture([{ status, providerId: 'accepted' }]); const res = await f.call('cancelReminder');
    assert.equal(res.code, 409); assert.equal(f.rows[0].status, status); assert.equal(f.rows[0].providerId, 'accepted');
  }
});
test('cancellation wins worker race: no provider invocation', async () => {
  const f = fixture([{}]); let sends = 0;
  const worker = createReminderWorker({ Reminder: f.Reminder, Item: { async exists() { return true; } },
    config: workerConfig({ REMINDER_DELIVERY_MODE: 'mock' }), now: () => new Date('2030-01-01'),
    async sendEmail() { sends++; }, async sendSms() { sends++; } });
  const [cancelled, claimed] = await Promise.all([f.call('cancelReminder'), worker.processOne()]);
  assert.equal(cancelled.code, 200); assert.equal(claimed, false); assert.equal(sends, 0); assert.equal(f.rows[0].status, 'cancelled');
});
test('worker wins race: in-flight cancellation returns 409 and acceptance is recorded', async () => {
  const f = fixture([{}]); let entered; let release;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const worker = createReminderWorker({ Reminder: f.Reminder, Item: { async exists() { return true; } },
    config: workerConfig({ REMINDER_DELIVERY_MODE: 'mock' }), now: () => new Date('2030-01-01'),
    async sendEmail() { entered(); await gate; return 'mock-accepted'; } });
  const processing = worker.processOne(); await started;
  try { assert.equal((await f.call('cancelReminder')).code, 409); } finally { release(); await processing; }
  assert.equal(f.rows[0].status, 'sent'); assert.equal(f.rows[0].providerId, 'mock-accepted');
});
test('database failures return generic 500 responses', async () => {
  const controller = load('controllers/reminderController.js', {
    '../models/Reminder': { find() { throw Error('private'); }, findOne() { throw Error('private'); }, findOneAndUpdate() { throw Error('private'); } },
    '../models/Item': {}, '../lib/reminderValidation': { isId, validateReminder }
  });
  for (const method of ['getReminders', 'getReminder', 'cancelReminder']) {
    const res = response(); await controller[method]({ user: { id: owner }, params: { id: id(1) }, query: {} }, res);
    assert.equal(res.code, 500); assert.equal(res.body.message, 'Internal server error');
  }
});

test('simultaneous DELETE requests both succeed with one cancellation timestamp', async () => {
  const f = fixture([{}]);
  const results = await Promise.all([f.call('cancelReminder'), f.call('cancelReminder')]);
  assert.ok(results.every(res => res.code === 200));
  assert.equal(+results[0].body.reminder.cancelledAt, +results[1].body.reminder.cancelledAt);
  assert.equal(f.rows[0].attempts, 0);
});

test('POST keeps its response shape while hiding worker coordination fields', async () => {
  const controller = load('controllers/reminderController.js', {
    '../models/Reminder': { async create(value) { return { ...value, status: 'pending', claimToken: 'private', leaseUntil: new Date() }; } },
    '../models/Item': { async findOne() { return {}; } }, '../lib/reminderValidation': { validateReminder, isId }
  });
  const res = response();
  await controller.createReminder({ user: { id: owner }, body: { itemId, channel: 'email', recipient: 'test@example.com', message: 'Test', remindAt: '2099-01-01T00:00:00Z' } }, res);
  assert.equal(res.code, 201); assert.equal(res.body.message, 'Reminder created successfully');
  assert.equal(res.body.reminder.status, 'pending'); privateFieldsAbsent(res.body.reminder);
});
