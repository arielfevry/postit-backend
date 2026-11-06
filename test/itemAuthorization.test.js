const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const ItemModel = require('../models/Item');
const { signAccessToken, verifyAccessToken, JwtConfigurationError } = require('../lib/jwt');
const root = path.join(__dirname, '..');
const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const member = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const unrelated = 'cccccccccccccccccccccccc';
const boardId = 'dddddddddddddddddddddddd';
const foreignBoardId = 'eeeeeeeeeeeeeeeeeeeeeeee';
const itemId = '111111111111111111111111';
const config = { JWT_SECRET: randomBytes(48).toString('hex'), JWT_EXPIRES_IN: '1h' };
function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, console: { error() {} }, require(name) { if (name in deps) return deps[name]; throw Error(name); }
  });
  return module.exports;
}
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => key === '$or' ? value.some(q => matches(row, q))
    : Array.isArray(row[key]) ? row[key].some(v => String(v) === String(value)) : String(row[key]) === String(value));
}
function fixture() {
  const boards = [{ _id: boardId, ownerId: owner, userIds: [member] }, { _id: foreignBoardId, ownerId: unrelated, userIds: [] }];
  const items = [{ _id: itemId, boardId, userId: owner, type: 'text', content: 'Original' }];
  const queries = []; const state = { error: null, beforeWrite: null, beforeBoardCheck: null, deletedUser: false };
  function record(operation, query) { queries.push({ operation, query }); if (state.error === operation) throw Error('private database details'); }
  const Board = { async exists(query) { record('board', query); state.beforeBoardCheck?.(); return boards.some(row => matches(row, query)); } };
  const Item = {
    async create(value) { record('create', value); const doc = new ItemModel(value); await doc.validate(); const row = doc.toObject(); items.push(row); return row; },
    async find(query) { record('list', query); return items.filter(row => matches(row, query)); },
    findById(id) { record('read', id); return { async select(fields) {
      assert.equal(fields, 'boardId userId'); const item = items.find(row => String(row._id) === id);
      return item ? { _id: item._id, boardId: item.boardId, userId: item.userId } : null;
    } }; },
    async findOneAndUpdate(query, update, options) {
      record('update', query); state.beforeWrite?.();
      assert.equal(options.runValidators, true); assert.equal(options.upsert, false); assert.equal(options.returnDocument, 'after');
      const item = items.find(row => matches(row, query)); if (!item) return null;
      const doc = new ItemModel({ ...item, ...update.$set }); await doc.validate(); Object.assign(item, update.$set); return item;
    },
    async findOneAndDelete(query) { record('delete', query); state.beforeWrite?.(); const index = items.findIndex(row => matches(row, query)); return index < 0 ? null : items.splice(index, 1)[0]; }
  };
  const controller = load('controllers/itemController.js', { mongoose, '../models/Item': Item, '../models/Board': Board });
  const authenticate = load('middleware/authenticate.js', { '../models/User': { async exists() { return !state.deletedUser; } },
    '../lib/jwt': { verifyAccessToken: token => verifyAccessToken(token, config), JwtConfigurationError } });
  async function call(action, { as = owner, header, body = { content: 'Updated' }, params = { id: itemId }, query = { boardId } } = {}) {
    const req = { get: () => header === undefined ? as ? 'Bearer ' + signAccessToken(as, config) : undefined : header, body, params, query };
    const res = response(); await authenticate(req, res, () => controller[action](req, res)); return res;
  }
  return { boards, items, queries, state, controller, authenticate, call };
}

test('every Item route runs shared JWT authentication before its existing CRUD handler', () => {
  const uses = []; const routes = []; const auth = () => {};
  const controller = { createItem() {}, getItems() {}, updateItem() {}, deleteItem() {} };
  const router = { use(...handlers) { uses.push(handlers); } };
  for (const method of ['post', 'get', 'put', 'delete']) router[method] = (path, handler) => {
    assert.equal(uses.length, 1); assert.equal(uses[0][0], auth); routes.push([method, path, handler]);
  };
  load('routes/items.js', { express: { Router: () => router }, '../middleware/authenticate': auth, '../controllers/itemController': controller });
  assert.deepEqual(routes.map(r => r.slice(0, 2)), [['post', '/'], ['get', '/'], ['put', '/:id'], ['delete', '/:id']]);
  assert.deepEqual(routes.map(r => r[2]), [controller.createItem, controller.getItems, controller.updateItem, controller.deleteItem]);
});

test('all Item endpoints reject missing, invalid, expired, wrong-signature and Basic tokens before Item/Board access', async () => {
  const expired = jwt.sign({ sub: owner, exp: Math.floor(Date.now() / 1000) - 5 }, config.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'postit-backend', audience: 'postit-api' });
  const wrong = signAccessToken(owner, { ...config, JWT_SECRET: randomBytes(48).toString('hex') });
  for (const action of ['createItem', 'getItems', 'updateItem', 'deleteItem']) {
    for (const header of ['', 'Basic dXNlcjpwYXNz', 'Bearer invalid', 'Bearer ' + expired, 'Bearer ' + wrong]) {
      const f = fixture(); assert.equal((await f.call(action, { header })).code, 401); assert.equal(f.queries.length, 0);
    }
    assert.equal((await fixture().call(action, { as: null })).code, 401);
  }
});

test('deleted JWT users and direct unauthenticated controller calls fail closed', async () => {
  for (const action of ['createItem', 'getItems', 'updateItem', 'deleteItem']) {
    const f = fixture(); f.state.deletedUser = true;
    assert.equal((await f.call(action)).code, 401); assert.equal(f.queries.length, 0);
    const res = response(); await f.controller[action]({}, res); assert.equal(res.code, 401);
  }
});

test('owners and members create Items with JWT-derived creator despite forged body userId', async () => {
  for (const as of [owner, member]) {
    const f = fixture(); const res = await f.call('createItem', { as, body: { boardId, userId: unrelated, content: 'Created', type: 'text' } });
    assert.equal(res.code, 201); assert.equal(res.body.message, 'Item created successfully');
    assert.equal(String(res.body.item.userId), as); assert.equal(String(res.body.item.boardId), boardId);
  }
  const res = await fixture().call('createItem', { as: member, body: { boardId, content: 'No userId required' } });
  assert.equal(res.code, 201); assert.equal(String(res.body.item.userId), member);
});

test('owners and members read all board Items, with empty accessible boards returning 200', async () => {
  for (const as of [owner, member]) {
    const f = fixture(); const res = await f.call('getItems', { as });
    assert.equal(res.code, 200); assert.equal(res.body.message, 'Items retrieved successfully'); assert.equal(res.body.items.length, 1);
    f.items.length = 0; assert.equal((await f.call('getItems', { as })).body.items.length, 0);
  }
});

test('unrelated users and missing Boards return identical 404 without listing or creating Items', async () => {
  for (const action of ['createItem', 'getItems']) {
    const f = fixture(); const denied = await f.call(action, { as: unrelated, body: { boardId, content: 'Denied' } });
    f.boards.length = 0; const missing = await f.call(action, { body: { boardId, content: 'Denied' } });
    assert.equal(denied.code, 404); assert.equal(missing.code, 404); assert.equal(denied.body.message, missing.body.message);
    assert.ok(f.queries.every(q => q.operation === 'board')); assert.equal(f.items.length, 1);
  }
});

test('owners and members update Items while preserving their original creator and response shape', async () => {
  for (const as of [owner, member]) {
    const f = fixture(); const res = await f.call('updateItem', { as, body: { content: { text: 'Edited' }, type: 'checklist' } });
    assert.equal(res.code, 200); assert.equal(res.body.message, 'Item updated successfully');
    assert.equal(res.body.item.userId, owner); assert.equal(res.body.item.type, 'checklist'); assert.equal(res.body.item.content.text, 'Edited');
    const filter = f.queries.find(q => q.operation === 'update').query;
    assert.equal(filter._id, itemId); assert.equal(filter.boardId, boardId); assert.equal(filter.userId, owner);
  }
});

test('owners and members delete Items belonging to any creator on an accessible Board', async () => {
  for (const as of [owner, member]) {
    const f = fixture(); const res = await f.call('deleteItem', { as });
    assert.equal(res.code, 200); assert.equal(res.body.message, 'Item deleted successfully'); assert.equal(res.body.item.userId, owner);
    assert.equal(f.items.length, 0); const filter = f.queries.find(q => q.operation === 'delete').query;
    assert.equal(filter._id, itemId); assert.equal(filter.boardId, boardId); assert.equal(filter.userId, owner);
  }
});

test('foreign, missing and orphaned Items return identical 404 on update/delete without writes', async () => {
  for (const action of ['updateItem', 'deleteItem']) {
    for (const kind of ['foreign', 'missing', 'orphaned', 'invalidStoredBoard']) {
      const f = fixture(); if (kind === 'missing') f.items.length = 0;
      if (kind === 'orphaned') f.boards.length = 0;
      if (kind === 'invalidStoredBoard') f.items[0].boardId = 'bad';
      const res = await f.call(action, { as: kind === 'foreign' ? unrelated : owner });
      assert.equal(res.code, 404); assert.equal(res.body.message, 'Item not found');
      assert.equal(f.queries.some(q => ['update', 'delete'].includes(q.operation)), false);
    }
  }
});

test('Item creator alone does not grant access after Board membership is removed', async () => {
  const f = fixture(); f.boards[0] = { _id: boardId, ownerId: unrelated, userIds: [] };
  for (const action of ['getItems', 'updateItem', 'deleteItem']) assert.equal((await f.call(action)).code, 404);
  assert.equal(f.items[0].content, 'Original');
});

test('malformed request IDs are rejected before Item or Board database operations', async () => {
  for (const value of [undefined, '', 'bad', ['dddddddddddddddddddddddd'], { $ne: null }, 123]) {
    const f = fixture();
    assert.equal((await f.call('createItem', { body: { boardId: value, content: 'Test' } })).code, 400);
    assert.equal((await f.call('getItems', { query: { boardId: value } })).code, 400);
    for (const action of ['updateItem', 'deleteItem']) assert.equal((await f.call(action, { params: { id: value } })).code, 400);
    assert.equal(f.queries.length, 0);
  }
});

test('invalid bodies and attempts to reassign Board/creator are rejected without database writes', async () => {
  const f = fixture();
  for (const body of [null, [], 'bad', {}, { boardId }]) assert.equal((await f.call('createItem', { body })).code, 400);
  for (const body of [null, [], 'bad', {}, { userId: member }, { boardId: foreignBoardId }, { content: null }, { type: 1 }, { content: 'Edit', userId: member }]) {
    assert.equal((await f.call('updateItem', { body })).code, 400);
  }
  assert.equal(f.queries.length, 0);
  assert.equal((await f.call('createItem', { body: { boardId, content: 'Test', type: 'invalid' } })).code, 400);
  assert.equal((await f.call('updateItem', { body: { type: 'invalid' } })).code, 400);
  assert.equal(f.items.length, 1); assert.equal(f.items[0].userId, owner);
});

test('conditional writes refuse a concurrently moved, recreated or deleted Item', async () => {
  for (const action of ['updateItem', 'deleteItem']) {
    for (const race of ['moved', 'creatorChanged', 'deleted']) {
      const f = fixture(); f.state.beforeWrite = () => {
        if (race === 'moved') f.items[0].boardId = foreignBoardId;
        if (race === 'creatorChanged') f.items[0].userId = unrelated;
        if (race === 'deleted') f.items.length = 0;
      };
      const res = await f.call(action); assert.equal(res.code, 404);
      if (f.items.length) assert.equal(f.items[0].content, 'Original');
    }
  }
});

test('membership revoked before Board authorization denies Item writes', async () => {
  for (const action of ['updateItem', 'deleteItem']) {
    const f = fixture(); f.state.beforeBoardCheck = () => { f.boards[0].userIds = []; };
    assert.equal((await f.call(action, { as: member })).code, 404);
    assert.equal(f.items[0].content, 'Original');
  }
});

test('database failures at each read/write stage produce generic 500 responses', async () => {
  for (const [action, stages] of [['createItem', ['board', 'create']], ['getItems', ['board', 'list']],
    ['updateItem', ['read', 'board', 'update']], ['deleteItem', ['read', 'board', 'delete']]]) {
    for (const stage of stages) {
      const f = fixture(); f.state.error = stage;
      const res = await f.call(action, { body: { ...(action === 'createItem' ? { boardId } : {}), content: 'Test' } });
      assert.equal(res.code, 500); assert.equal(res.body.message, 'Internal server error');
      assert.equal(JSON.stringify(res.body).includes('private'), false);
    }
  }
});

// Explicit opt-in. Neither the application DB nor the preserved live-email test DB is used.
test('Item JWT HTTP/Mongo: Board access, immutable creators, CRUD and Reminder ownership isolation', {
  skip: !process.env.ITEM_TEST_MONGO_URI, timeout: 30000
}, async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const Board = require('../models/Board');
  const Reminder = require('../models/Reminder');
  const dbName = 'codex_item_e2e_' + randomUUID().replaceAll('-', '');
  let child;
  try {
    await mongoose.connect(process.env.ITEM_TEST_MONGO_URI, { dbName, serverSelectionTimeoutMS: 3000 });
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const uri = new URL(process.env.ITEM_TEST_MONGO_URI); uri.pathname = '/' + dbName;
    const secret = randomBytes(48).toString('hex');
    child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env,
      MONGODB_URI: uri.toString(), PORT: String(port), JWT_SECRET: secret, JWT_EXPIRES_IN: '1h', JWT_ISSUER: 'postit-backend', JWT_AUDIENCE: 'postit-api',
      REMINDER_WORKER_ENABLED: 'false', REMINDER_DELIVERY_MODE: 'mock', SENDGRID_API_KEY: '', SENDGRID_FROM_EMAIL: '',
      TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM_PHONE: '' } });
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await (await fetch(base + '/api/ping')).json()).db === 'connected') { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'isolated Item API ready');
    let httpChecks = 0;
    async function request(method, endpoint, token, body, expected = 200) {
      const res = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, expected, method + ' ' + endpoint); httpChecks++;
      return res.status === 204 ? null : res.json();
    }
    async function register(email) {
      const credentials = { name: 'Item test', email, password: 'isolated-test-password' };
      await request('POST', '/api/register', null, credentials, 201);
      return request('POST', '/api/login', null, credentials);
    }
    const ownerUser = await register('owner@example.com'); const memberUser = await register('member@example.com'); const stranger = await register('stranger@example.com');
    const board = (await request('POST', '/api/boards', ownerUser.token, { title: 'Accessible Items' }, 201)).board;
    await Board.updateOne({ _id: board._id }, { $addToSet: { userIds: memberUser.user.id } });
    const privateBoard = (await request('POST', '/api/boards', stranger.token, { title: 'Private Items' }, 201)).board;
    const created = await request('POST', '/api/items', ownerUser.token, { boardId: board._id, userId: stranger.user.id, type: 'text', content: 'Original' }, 201);
    assert.equal(created.item.userId, ownerUser.user.id); assert.equal(created.message, 'Item created successfully');
    const itemPath = '/api/items/' + created.item._id; const listPath = '/api/items?boardId=' + board._id;
    const expired = jwt.sign({ sub: ownerUser.user.id, exp: Math.floor(Date.now() / 1000) - 10 }, secret,
      { algorithm: 'HS256', issuer: 'postit-backend', audience: 'postit-api' });
    for (const token of [null, 'invalid', expired]) {
      await request('POST', '/api/items', token, { boardId: board._id, content: 'Denied' }, 401);
      await request('GET', listPath, token, undefined, 401);
      await request('PUT', itemPath, token, { content: 'Denied' }, 401);
      await request('DELETE', itemPath, token, undefined, 401);
    }
    for (const user of [ownerUser, memberUser]) {
      assert.equal((await request('GET', listPath, user.token)).items.length, 1);
      const updated = await request('PUT', itemPath, user.token, { content: 'Edited', type: 'checklist' });
      assert.equal(updated.item.userId, ownerUser.user.id); assert.equal(updated.message, 'Item updated successfully');
    }
    const memberItem = await request('POST', '/api/items', memberUser.token, { boardId: board._id, content: 'Member created' }, 201);
    assert.equal(memberItem.item.userId, memberUser.user.id);
    await request('GET', listPath, stranger.token, undefined, 404);
    await request('POST', '/api/items', stranger.token, { boardId: board._id, content: 'Denied' }, 404);
    await request('PUT', itemPath, stranger.token, { content: 'Denied' }, 404);
    await request('DELETE', itemPath, stranger.token, undefined, 404);
    await request('GET', '/api/items?boardId=' + privateBoard._id, ownerUser.token, undefined, 404);
    const missingBoard = new mongoose.Types.ObjectId().toString();
    await request('GET', '/api/items?boardId=' + missingBoard, ownerUser.token, undefined, 404);
    await request('POST', '/api/items', ownerUser.token, { boardId: missingBoard, content: 'Denied' }, 404);
    for (const method of ['PUT', 'DELETE']) await request(method, '/api/items/' + new mongoose.Types.ObjectId(), ownerUser.token,
      method === 'PUT' ? { content: 'Missing' } : undefined, 404);
    await request('GET', '/api/items?boardId=bad', ownerUser.token, undefined, 400);
    await request('GET', listPath + '&boardId=' + privateBoard._id, ownerUser.token, undefined, 400);
    await request('POST', '/api/items', ownerUser.token, { boardId: { $ne: null }, content: 'Bad ID' }, 400);
    for (const method of ['PUT', 'DELETE']) await request(method, '/api/items/bad', ownerUser.token, method === 'PUT' ? { content: 'Bad' } : undefined, 400);
    for (const body of [{ userId: memberUser.user.id }, { boardId: privateBoard._id }, { content: null }, { type: 'invalid' }, {}]) {
      await request('PUT', itemPath, memberUser.token, body, 400);
    }
    await request('POST', '/api/items', memberUser.token, { boardId: board._id, content: 'Bad', type: 'invalid' }, 400);
    const reminderBody = { itemId: created.item._id, channel: 'email', recipient: 'test@example.com', remindAt: new Date(Date.now() + 3600000).toISOString(), message: 'No delivery' };
    const reminder = await request('POST', '/api/reminders', ownerUser.token, reminderBody, 201);
    // Board membership permits Item editing, not claiming another creator's Reminder.
    await request('POST', '/api/reminders', memberUser.token, reminderBody, 404);
    const reminderPath = '/api/reminders/' + reminder.reminder._id;
    for (const method of ['GET', 'DELETE']) await request(method, reminderPath, memberUser.token, undefined, 404);
    assert.equal((await request('GET', '/api/reminders', memberUser.token)).reminders.length, 0);
    const ownReminder = await request('POST', '/api/reminders', memberUser.token, { ...reminderBody, itemId: memberItem.item._id }, 201);
    await request('GET', '/api/reminders/' + ownReminder.reminder._id, memberUser.token);
    const deleted = await request('DELETE', itemPath, memberUser.token);
    assert.equal(deleted.message, 'Item deleted successfully'); assert.equal(deleted.item.userId, ownerUser.user.id);
    await request('DELETE', '/api/items/' + memberItem.item._id, ownerUser.token);
    assert.equal((await request('GET', listPath, memberUser.token)).items.length, 0);
    await request('DELETE', itemPath, memberUser.token, undefined, 404);
    // Removing membership removes access even to that user's own Item.
    const revoked = await request('POST', '/api/items', memberUser.token, { boardId: board._id, content: 'Membership revoked' }, 201);
    await Board.updateOne({ _id: board._id }, { $pull: { userIds: memberUser.user.id } });
    await request('GET', listPath, memberUser.token, undefined, 404);
    await request('PUT', '/api/items/' + revoked.item._id, memberUser.token, { content: 'Denied' }, 404);
    await request('DELETE', '/api/items/' + revoked.item._id, memberUser.token, undefined, 404);
    await request('POST', '/api/items', memberUser.token, { boardId: board._id, content: 'Denied' }, 404);
    // A deleted Board cannot authorize access to orphaned Items.
    await Board.deleteOne({ _id: board._id });
    await request('PUT', '/api/items/' + revoked.item._id, ownerUser.token, { content: 'Denied' }, 404);
    await request('DELETE', '/api/items/' + revoked.item._id, ownerUser.token, undefined, 404);
    assert.equal((await ItemModel.findById(revoked.item._id)).content, 'Membership revoked');
    assert.equal(await Reminder.countDocuments({ attempts: { $gt: 0 } }), 0);
    console.log('Item isolated HTTP/Mongo checks passed: ' + httpChecks);
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    if (mongoose.connection.readyState === 1) { assert.equal(mongoose.connection.name, dbName); await mongoose.connection.dropDatabase(); }
    await mongoose.disconnect();
  }
});
