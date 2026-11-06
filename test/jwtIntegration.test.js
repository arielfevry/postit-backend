const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserModel = require('../models/User');
const BoardModel = require('../models/Board');
const { signAccessToken, verifyAccessToken, JwtConfigurationError } = require('../lib/jwt');
const { validateReminder } = require('../lib/reminderValidation');
const root = path.join(__dirname, '..');
const ownerId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const otherId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const config = { JWT_SECRET: randomBytes(48).toString('hex'), JWT_EXPIRES_IN: '1h' };

function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, Buffer, console: { error() {} }, require(name) {
      if (name in dependencies) return dependencies[name];
      throw Error('Unexpected dependency: ' + name);
    }
  });
  return module.exports;
}
function response() {
  return { code: 200, headers: {}, locals: {}, status(code) { this.code = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    location(value) { return this.set('Location', value); },
    json(body) { this.body = body; return this; }, end() { this.ended = true; return this; } };
}
async function dispatch(stack, req, res = response()) {
  async function step(index) {
    if (index === stack.length) return;
    let continuation;
    await stack[index](req, res, error => {
      if (error) throw error;
      continuation = step(index + 1);
      return continuation;
    });
    await continuation;
  }
  await step(0);
  return res;
}
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    const actual = row[key];
    if (value && Object.hasOwn(value, '$ne')) return String(actual) !== String(value.$ne);
    return Array.isArray(actual) ? actual.some(v => String(v) === String(value)) : String(actual) === String(value);
  });
}
function fixture() {
  const users = [ownerId, otherId].map((_id, i) => UserModel.hydrate({ _id, name: 'User ' + i,
    email: `user${i}@example.com`, password: 'existing-hash-' + i, friends: [] }));
  const boards = [];
  const state = { existsError: false, loadError: false, loadDeleted: false, itemReferenced: false, updateConflict: false, updateError: false };
  let loadCalls = 0;
  let selected;
  let lastUpdate;
  let lastDelete;
  const User = {
    async exists(query) { if (state.existsError) throw Error('private database error'); return users.some(row => matches(row, query)); },
    findById(id) {
      loadCalls++;
      return { async select(fields) {
        selected = fields;
        if (state.loadError) throw Error('private loader error');
        return state.loadDeleted ? null : users.find(u => String(u._id) === id) || null;
      } };
    },
    async findOneAndUpdate(filter, update) {
      lastUpdate = filter;
      if (state.updateError) throw Error('private update error');
      const user = state.updateConflict ? null : users.find(row => matches(row, filter));
      if (user) user.set(update.$set);
      return user || null;
    },
    async deleteOne(filter) {
      lastDelete = filter;
      const index = users.findIndex(row => matches(row, filter));
      if (index < 0) return { deletedCount: 0 };
      users.splice(index, 1); return { deletedCount: 1 };
    }
  };
  const Board = {
    async create(value) { const board = new BoardModel(value); await board.validate(); boards.push(board); return board; },
    async find(filter) { return boards.filter(row => matches(row, filter)); },
    async findOne(filter) { return boards.find(row => matches(row, filter)) || null; },
    async exists(filter) { return boards.some(row => matches(row, filter)); },
    async findOneAndUpdate(filter, update) {
      const board = boards.find(row => matches(row, filter));
      if (board) board.set(update.$set); return board || null;
    },
    async deleteOne(filter) {
      const index = boards.findIndex(row => matches(row, filter));
      if (index < 0) return { deletedCount: 0 };
      boards.splice(index, 1); return { deletedCount: 1 };
    }
  };
  const Item = { async exists() { return state.itemReferenced; } };
  const authenticate = load('middleware/authenticate.js', {
    '../models/User': User, '../lib/jwt': { verifyAccessToken: token => verifyAccessToken(token, config), JwtConfigurationError }
  });
  const loader = load('middleware/loadAuthenticatedUser.js', { mongoose, '../models/User': User });
  const userController = load('controllers/userController.js', { bcryptjs: bcrypt, mongoose,
    '../models/User': User, '../models/Board': Board, '../models/Item': Item });
  const boardController = load('controllers/boardController.js', { mongoose, '../models/Board': Board, '../models/Item': Item });
  function req({ userId = ownerId, header = 'Bearer ' + signAccessToken(ownerId, config), params = {}, body = {}, method = 'GET' } = {}) {
    return { get: () => header, params: { userId, ...params }, body, method };
  }
  const stack = [authenticate, loader];
  async function userAction(action, options) { return dispatch([...stack, userController.authorizeSelf, userController[action]], req(options)); }
  function boardAction(action, options) {
    const middle = action === 'createBoard' ? [boardController.boardFields] : action === 'listBoards' ? [] : [boardController.validateBoardId];
    if (action === 'updateBoard') middle.push(boardController.boardFields);
    return dispatch([...stack, ...middle, boardController[action]], req(options));
  }
  return { users, boards, User, Board, state, authenticate, loader, stack, userController, boardController, req, userAction, boardAction,
    get loadCalls() { return loadCalls; }, get selected() { return selected; }, get lastUpdate() { return lastUpdate; }, get lastDelete() { return lastDelete; } };
}

// No MongoDB connection is opened by the tests above the explicit opt-in HTTP test.
test('JWT chain loads a Mongoose document with compatible id, _id and password hash', async () => {
  const f = fixture(); const req = f.req(); let reached = false;
  const res = await dispatch([...f.stack, (req, res) => {
    reached = true;
    assert.equal(req.user.id, ownerId);
    assert.ok(req.user._id.equals(ownerId));
    assert.equal(req.user.password, 'existing-hash-0');
    assert.equal(typeof req.user.toObject, 'function');
  }], req);
  assert.ok(reached); assert.equal(f.loadCalls, 1);
  assert.equal(f.selected, 'name email friends password');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('missing, Basic, invalid, expired and wrong-signature JWTs cannot reach User or Board CRUD', async () => {
  const expired = jwt.sign({ sub: ownerId, exp: Math.floor(Date.now() / 1000) - 10 }, config.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'postit-backend', audience: 'postit-api' });
  for (const header of [undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer invalid', 'Bearer ' + expired,
    'Bearer ' + signAccessToken(ownerId, { ...config, JWT_SECRET: randomBytes(48).toString('hex') })]) {
    const f = fixture();
    // Use an explicit request here so undefined does not select req()'s valid-token default.
    for (const action of [f.userController.getUser, f.boardController.listBoards]) {
      const req = { get: () => header, params: { userId: ownerId } };
      assert.equal((await dispatch([...f.stack, action], req)).code, 401);
    }
    assert.equal(f.loadCalls, 0);
  }
});

test('loader rejects absent or malformed identity without querying MongoDB', async () => {
  const f = fixture();
  for (const user of [undefined, {}, { id: 'bad' }, { id: { $ne: null } }]) {
    const res = await dispatch([f.loader, () => assert.fail('must stop')], { user });
    assert.equal(res.code, 401);
  }
  assert.equal(f.loadCalls, 0);
});

test('deleted users and deletion between token validation and document loading fail closed', async () => {
  const f = fixture(); f.users.splice(0, 1);
  assert.equal((await f.userAction('getUser')).code, 401); assert.equal(f.loadCalls, 0);
  const raced = fixture(); raced.state.loadDeleted = true;
  assert.equal((await raced.boardAction('listBoards')).code, 401); assert.equal(raced.loadCalls, 1);
});

test('authentication and user-loading database errors return generic 500 without reaching controllers', async () => {
  for (const flag of ['existsError', 'loadError']) {
    const f = fixture(); f.state[flag] = true;
    const res = await dispatch([...f.stack, () => assert.fail('must stop')], f.req());
    assert.equal(res.code, 500); assert.equal(res.body.message, 'Internal server error');
    assert.equal(JSON.stringify(res.body).includes('private'), false);
  }
});

test('User GET returns only profile fields; other-user operations remain forbidden', async () => {
  const f = fixture(); const own = await f.userAction('getUser');
  assert.equal(own.code, 200); assert.equal(String(own.body.user.id), ownerId);
  assert.equal(own.body.user.password, undefined);
  for (const action of ['getUser', 'updateUser', 'deleteUser']) {
    const res = await f.userAction(action, { userId: otherId, body: { name: 'Forbidden' } });
    assert.equal(res.code, 403);
  }
  assert.equal(f.users.length, 2); assert.equal(f.users[1].name, 'User 1');
  assert.equal((await f.userAction('getUser', { userId: 'bad' })).code, 400);
});

test('User update and delete retain current password hash concurrency predicates and reference checks', async () => {
  const f = fixture();
  const updated = await f.userAction('updateUser', { method: 'PATCH', body: { name: ' Updated ' } });
  assert.equal(updated.code, 200); assert.equal(updated.body.user.name, 'Updated');
  assert.equal(f.lastUpdate.password, 'existing-hash-0'); assert.ok(f.lastUpdate._id.equals(ownerId));
  assert.equal(updated.body.user.password, undefined);
  f.state.updateConflict = true;
  assert.equal((await f.userAction('updateUser', { body: { name: 'Race' } })).code, 409);
  f.state.itemReferenced = true;
  assert.equal((await f.userAction('deleteUser')).code, 409);
  f.state.itemReferenced = false;
  assert.equal((await f.userAction('deleteUser')).code, 204);
  assert.equal(f.lastDelete.password, 'existing-hash-0');
  assert.equal((await f.userAction('getUser')).code, 401);
});

test('User update database failures retain existing generic error behavior', async () => {
  const f = fixture(); f.state.updateError = true;
  const res = await f.userAction('updateUser', { body: { name: 'Updated' } });
  assert.equal(res.code, 500); assert.equal(res.body.error, 'Internal server error');
});

test('password change hashes the password but existing JWT stays valid (no revocation implemented)', async () => {
  const f = fixture(); const token = signAccessToken(ownerId, config);
  const res = await f.userAction('updateUser', { header: 'Bearer ' + token, body: { password: 'new-test-password' } });
  assert.equal(res.code, 200); assert.equal(res.body.user.password, undefined);
  assert.ok(await bcrypt.compare('new-test-password', f.users[0].password));
  assert.equal(verifyAccessToken(token, config).sub, ownerId);
  const again = await f.userAction('updateUser', { header: 'Bearer ' + token, body: { name: 'Still authorized' } });
  assert.equal(again.code, 200); assert.equal(f.lastUpdate.password, f.users[0].password);
});

test('Board create derives ownership and membership from authenticated document, ignoring body owner', async () => {
  const f = fixture(); const res = await f.boardAction('createBoard', { method: 'POST',
    body: { title: ' My board ', ownerId: otherId, userIds: [otherId] } });
  assert.equal(res.code, 201); assert.equal(res.body.board.title, 'My board');
  assert.ok(res.body.board.ownerId.equals(ownerId));
  assert.deepEqual(res.body.board.userIds.map(String), [ownerId]);
  assert.equal(res.headers.Location, '/api/boards/' + res.body.board.id);
});

test('Board reads allow owner/member, hide unrelated boards, and deny member mutations', async () => {
  const f = fixture();
  const owned = new BoardModel({ title: 'Owned', ownerId, userIds: [ownerId] });
  const shared = new BoardModel({ title: 'Shared', ownerId: otherId, userIds: [otherId, ownerId] });
  const foreign = new BoardModel({ title: 'Foreign', ownerId: otherId, userIds: [otherId] });
  f.boards.push(owned, shared, foreign);
  const listed = await f.boardAction('listBoards');
  assert.deepEqual(listed.body.boards.map(b => b.title), ['Owned', 'Shared']);
  for (const board of [owned, shared]) assert.equal((await f.boardAction('getBoard', { params: { boardId: board.id } })).code, 200);
  for (const action of ['getBoard', 'updateBoard', 'deleteBoard']) {
    assert.equal((await f.boardAction(action, { params: { boardId: foreign.id }, body: { title: 'Forbidden' } })).code, 404);
  }
  for (const action of ['updateBoard', 'deleteBoard']) {
    assert.equal((await f.boardAction(action, { params: { boardId: shared.id }, body: { title: 'Forbidden' } })).code, 404);
  }
  assert.equal(shared.title, 'Shared'); assert.equal(f.boards.length, 3);
});

test('Board owner update/delete and Item reference guard remain intact', async () => {
  const f = fixture(); const created = await f.boardAction('createBoard', { method: 'POST', body: { title: 'Owned' } });
  const params = { boardId: created.body.board.id };
  assert.equal((await f.boardAction('updateBoard', { params, body: { title: 'Updated' } })).body.board.title, 'Updated');
  f.state.itemReferenced = true; assert.equal((await f.boardAction('deleteBoard', { params })).code, 409);
  f.state.itemReferenced = false; assert.equal((await f.boardAction('deleteBoard', { params })).code, 204);
  assert.equal((await f.boardAction('getBoard', { params })).code, 404);
  assert.equal((await f.boardAction('getBoard', { params: { boardId: 'bad' } })).code, 400);
});

test('User and Board routers install JWT then loader before existing authorization/controllers', () => {
  const f = fixture();
  const authenticate = f.authenticate; const loader = f.loader;
  let userPath; let userChain; const userRoutes = {};
  const userRouter = { route(path) { userPath = path; return {
    all(...handlers) { userChain = handlers; return this; },
    get(handler) { userRoutes.get = handler; return this; },
    patch(handler) { userRoutes.patch = handler; return this; },
    delete(handler) { userRoutes.delete = handler; return this; }
  }; } };
  load('routes/users.js', { express: { Router: () => userRouter }, '../controllers/userController': f.userController,
    '../middleware/authenticate': authenticate, '../middleware/loadAuthenticatedUser': loader });
  assert.equal(userPath, '/:userId');
  assert.equal(userChain[0], authenticate); assert.equal(userChain[1], loader); assert.equal(userChain[2], f.userController.authorizeSelf);
  assert.equal(userRoutes.get, f.userController.getUser); assert.equal(userRoutes.patch, f.userController.updateUser); assert.equal(userRoutes.delete, f.userController.deleteUser);
  const uses = []; const routes = [];
  const boardRouter = { use(...handlers) { uses.push(handlers); }, route(path) {
    const record = { path }; routes.push(record);
    return Object.fromEntries(['all', 'get', 'post', 'patch', 'delete'].map(method => [method, function (...handlers) { record[method] = handlers; return this; }]));
  } };
  load('routes/boards.js', { express: { Router: () => boardRouter }, '../controllers/boardController': f.boardController,
    '../middleware/authenticate': authenticate, '../middleware/loadAuthenticatedUser': loader });
  assert.equal(uses[0][0], authenticate); assert.equal(uses[0][1], loader);
  assert.equal(routes[0].get[0], f.boardController.listBoards); assert.equal(routes[0].post[1], f.boardController.createBoard);
  assert.equal(routes[1].all[0], f.boardController.validateBoardId);
  assert.equal(routes[1].get[0], f.boardController.getBoard); assert.equal(routes[1].patch[1], f.boardController.updateBoard); assert.equal(routes[1].delete[0], f.boardController.deleteBoard);
});

test('Reminder POST remains compatible with JWT id identity and does not require the CRUD loader', async () => {
  const f = fixture(); let saved; let itemOwner;
  const reminderController = load('controllers/reminderController.js', {
    '../models/Reminder': { async create(value) { saved = value; return { ...value, status: 'pending' }; } },
    '../models/Item': { async findOne(filter) { itemOwner = filter.userId; return filter.userId === ownerId ? {} : null; } },
    '../lib/reminderValidation': { validateReminder }
  });
  const req = f.req({ body: { itemId: new mongoose.Types.ObjectId().toString(), channel: 'email', recipient: 'test@example.com',
    remindAt: '2099-01-01T00:00:00Z', message: 'No provider calls' } });
  const res = await dispatch([f.authenticate, reminderController.createReminder], req);
  assert.equal(res.code, 201); assert.equal(itemOwner, ownerId); assert.equal(saved.userId, ownerId);
  assert.equal(saved.deliveryAuthorized, true); assert.equal(f.loadCalls, 0);
  assert.equal(req.user.id, ownerId); assert.equal(req.user.password, undefined);
});

// Real HTTP/Mongo coverage is opt-in, using a unique disposable DB and worker-disabled API.
test('JWT HTTP/Mongo integration: User/Board authorization, password change, deletion and Reminder compatibility', {
  skip: !process.env.JWT_TEST_MONGO_URI, timeout: 30000
}, async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const Item = require('../models/Item');
  const Reminder = require('../models/Reminder');
  const dbName = 'codex_jwt_e2e_' + randomUUID().replaceAll('-', '');
  let child;
  try {
    await mongoose.connect(process.env.JWT_TEST_MONGO_URI, { dbName, serverSelectionTimeoutMS: 3000 });
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const uri = new URL(process.env.JWT_TEST_MONGO_URI); uri.pathname = '/' + dbName;
    const secret = randomBytes(48).toString('hex');
    const env = { ...process.env, MONGODB_URI: uri.toString(), PORT: String(port), JWT_SECRET: secret,
      JWT_EXPIRES_IN: '1h', JWT_ISSUER: 'postit-backend', JWT_AUDIENCE: 'postit-api', REMINDER_WORKER_ENABLED: 'false',
      REMINDER_DELIVERY_MODE: 'mock', SENDGRID_API_KEY: '', SENDGRID_FROM_EMAIL: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM_PHONE: '' };
    child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: 'ignore' });
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await (await fetch(base + '/api/ping')).json()).db === 'connected') { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'isolated HTTP API became ready');
    let httpChecks = 0;
    async function request(method, endpoint, token, body, expected = 200, extraHeaders = {}) {
      const res = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, expected, method + ' ' + endpoint); httpChecks++;
      const data = res.status === 204 ? null : await res.json();
      return { data, headers: res.headers };
    }
    async function register(email) {
      const credentials = { name: 'JWT HTTP fixture', email, password: 'initial-test-password' };
      const registered = await request('POST', '/api/register', null, credentials, 201);
      assert.equal(registered.data.token, undefined);
      const { data } = await request('POST', '/api/login', null, credentials);
      assert.ok(data.token); assert.equal(data.user.password, undefined);
      return { ...data, credentials };
    }
    const owner = await register('owner@example.com'); const other = await register('other@example.com');
    const self = '/api/users/' + owner.user.id;
    const ownerProfile = await request('GET', self, owner.token);
    assert.equal(ownerProfile.data.user.id, owner.user.id); assert.equal(ownerProfile.data.user.password, undefined);
    assert.equal(ownerProfile.headers.get('cache-control'), 'no-store');
    const expired = jwt.sign({ sub: owner.user.id, exp: Math.floor(Date.now() / 1000) - 10 }, secret,
      { algorithm: 'HS256', issuer: 'postit-backend', audience: 'postit-api' });
    for (const endpoint of [self, '/api/boards', '/api/reminders']) {
      for (const token of [null, 'invalid', expired]) await request('GET', endpoint, token, null, 401);
      await request('GET', endpoint, null, null, 401, { Authorization: 'Basic ' + Buffer.from('owner@example.com:initial-test-password').toString('base64') });
    }
    for (const method of ['GET', 'PATCH', 'DELETE']) await request(method, '/api/users/' + other.user.id, owner.token, method === 'PATCH' ? { name: 'Forbidden' } : null, 403);
    await request('GET', '/api/users/bad', owner.token, null, 400);
    const changed = await request('PATCH', self, owner.token, { name: ' Updated ', email: 'OWNER-UPDATED@example.com' });
    assert.equal(changed.data.user.name, 'Updated'); assert.equal(changed.data.user.email, 'owner-updated@example.com');
    await request('PATCH', self, owner.token, { email: 'other@example.com' }, 409);
    const made = await request('POST', '/api/boards', owner.token, { title: 'Owner board', ownerId: other.user.id, userIds: [other.user.id] }, 201);
    const board = made.data.board; const boardPath = '/api/boards/' + board._id;
    assert.equal(board.ownerId, owner.user.id); assert.deepEqual(board.userIds, [owner.user.id]);
    await request('GET', boardPath, owner.token);
    for (const method of ['GET', 'PATCH', 'DELETE']) await request(method, boardPath, other.token, method === 'PATCH' ? { title: 'Forbidden' } : null, 404);
    assert.equal((await request('GET', '/api/boards', other.token)).data.boards.length, 0);
    const shared = await BoardModel.create({ title: 'Shared', ownerId: other.user.id, userIds: [other.user.id, owner.user.id] });
    await request('GET', '/api/boards/' + shared.id, owner.token);
    for (const method of ['PATCH', 'DELETE']) await request(method, '/api/boards/' + shared.id, owner.token, method === 'PATCH' ? { title: 'Forbidden' } : null, 404);
    assert.equal((await request('GET', '/api/boards', owner.token)).data.boards.length, 2);
    await request('PATCH', boardPath, owner.token, { title: 'Updated board' });
    const item = await Item.create({ boardId: board._id, userId: owner.user.id, content: 'JWT disposable fixture' });
    await request('DELETE', boardPath, owner.token, null, 409);
    await request('DELETE', self, owner.token, null, 409);
    const created = await request('POST', '/api/reminders', owner.token, { itemId: item.id, channel: 'email', recipient: 'test@example.com',
      remindAt: new Date(Date.now() + 3600000).toISOString(), message: 'Worker disabled' }, 201);
    const reminderPath = '/api/reminders/' + created.data.reminder._id;
    await request('GET', reminderPath, owner.token);
    for (const method of ['GET', 'DELETE']) await request(method, reminderPath, other.token, null, 404);
    assert.equal((await request('GET', '/api/reminders', other.token)).data.reminders.length, 0);
    await request('DELETE', reminderPath, owner.token);
    // Confirm current, deliberately non-revoking password-change behavior through actual HTTP.
    await request('PATCH', self, owner.token, { password: 'new-test-password' });
    assert.ok(await bcrypt.compare('new-test-password', (await UserModel.findById(owner.user.id)).password));
    await request('GET', self, owner.token);
    await request('PATCH', self, owner.token, { name: 'Old token still works' });
    await request('GET', '/api/boards', owner.token);
    await request('GET', reminderPath, owner.token);
    await request('POST', '/api/login', null, { email: 'owner-updated@example.com', password: 'initial-test-password' }, 401);
    await request('POST', '/api/login', null, { email: 'owner-updated@example.com', password: 'new-test-password' });
    const disposable = await register('deleted@example.com');
    await request('DELETE', '/api/users/' + disposable.user.id, disposable.token, null, 204);
    for (const endpoint of ['/api/users/' + disposable.user.id, '/api/boards', '/api/reminders']) await request('GET', endpoint, disposable.token, null, 401);
    await Item.deleteOne({ _id: item._id });
    await request('DELETE', boardPath, owner.token, null, 204);
    await request('GET', boardPath, owner.token, null, 404);
    assert.equal((await Reminder.findById(created.data.reminder._id)).attempts, 0);
    console.log('JWT isolated HTTP/Mongo checks passed: ' + httpChecks);
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    if (mongoose.connection.readyState === 1) {
      assert.equal(mongoose.connection.name, dbName); // Never drop a configured application DB.
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  }
});
