const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { once } = require('node:events');
const User = require('../models/User');

function response() {
    return {
        code: 200,
        headers: {},
        headersSent: false,
        set(name, value) { this.headers[name] = value; return this; },
        status(code) { this.code = code; return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
    };
}

function fixture() {
    const state = {
        account: { email: 'alice@example.com', isVerified: false },
        now: Date.now(),
        deliveryFails: false,
        databaseFails: false,
        updates: [],
    };
    const messages = [];
    const env = {
        EMAIL_VERIFICATION_URL: 'https://postit.example/verify-email',
        SENDGRID_API_KEY: 'test-key',
        SENDGRID_FROM_EMAIL: 'sender@example.com',
    };

    // Use a controlled clock so cooldown and expiry tests need no waiting.
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [state.now])); }
        static now() { return state.now; }
    }

    const model = {
        async updateOne(filter, update) {
            if (state.databaseFails) throw new Error('private database detail');
            state.updates.push({ filter, update });
            const account = state.account;
            if (!account ||
                (filter.email && filter.email !== account.email) ||
                (filter.isVerified && account.isVerified === filter.isVerified.$ne) ||
                (filter.verificationTokenHash && filter.verificationTokenHash !== account.verificationTokenHash) ||
                (filter.verificationTokenExpiresAt &&
                    !(account.verificationTokenExpiresAt > filter.verificationTokenExpiresAt.$gt)) ||
                (filter.$expr && account.email !== account.verificationTokenEmail) ||
                (filter.$or && account.verificationRequestedAt &&
                    account.verificationRequestedAt > filter.$or[1].verificationRequestedAt.$lte)) {
                return { modifiedCount: 0 };
            }
            Object.assign(account, update.$set);
            for (const key of Object.keys(update.$unset || {})) delete account[key];
            return { modifiedCount: 1 };
        },
    };
    const dependencies = {
        'node:crypto': require('node:crypto'),
        validator: require('validator'),
        '../models/User': model,
        '../services/emailService': {
            createEmailService: () => async (message) => {
                messages.push(message);
                if (state.deliveryFails) throw new Error('private provider detail');
            },
        },
    };
    const module = { exports: {} };
    runInNewContext(readFileSync(require.resolve('../controllers/emailVerificationController'), 'utf8'), {
        module,
        require(name) {
            assert.ok(name in dependencies, 'Unexpected dependency: ' + name);
            return dependencies[name];
        },
        Date: Clock,
        URL,
        process: { env },
        console: { error() {} },
    });

    async function call(action, body) {
        const res = response();
        await module.exports[action]({ body }, res);
        return res;
    }
    function sentToken(index = messages.length - 1) {
        return new URL(messages[index].message.split('\n').at(-1)).searchParams.get('token');
    }
    return { state, messages, env, api: module.exports, call, sentToken };
}

test('new accounts default to unverified and verification secrets are excluded from queries', () => {
    const account = new User({ name: 'Alice', email: 'alice@example.com', password: 'hash' });
    assert.equal(account.isVerified, false);
    for (const field of ['verificationTokenHash', 'verificationTokenExpiresAt',
        'verificationTokenEmail', 'verificationRequestedAt']) {
        assert.equal(User.schema.path(field).options.select, false);
    }
});

test('resend sends a welcome link with a random token and stores only its hash for 24 hours', async () => {
    const f = fixture();
    const res = await f.call('resendVerification', { email: ' ALICE@example.com ' });
    assert.equal(res.code, 202);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].recipient, 'alice@example.com');
    assert.equal(f.messages[0].subject, 'Welcome to Post It! Verify your email');
    assert.match(f.messages[0].message, /24 hours/);
    const token = f.sentToken();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(f.state.account.verificationTokenHash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(f.state.account.verificationTokenHash, token);
    assert.equal(+f.state.account.verificationTokenExpiresAt, f.state.now + 24 * 60 * 60 * 1000);
    assert.equal(f.state.account.verificationTokenEmail, 'alice@example.com');
    assert.equal(JSON.stringify(res.body).includes(token), false);
    assert.equal(f.state.account.isVerified, false);
    assert.notEqual((await issueToken()), token);

    async function issueToken() {
        const other = fixture();
        await other.call('resendVerification', { email: 'alice@example.com' });
        return other.sentToken();
    }
});

test('unknown, verified, legacy, and cooldown accounts get generic replies', async () => {
    const f = fixture();
    const initial = await f.call('resendVerification', { email: 'alice@example.com' });
    const cooldown = await f.call('resendVerification', { email: 'alice@example.com' });
    const unknown = await f.call('resendVerification', { email: 'unknown@example.com' });
    f.state.account.isVerified = true;
    const verified = await f.call('resendVerification', { email: 'alice@example.com' });
    for (const res of [cooldown, unknown, verified]) {
        assert.equal(res.code, 202);
        assert.equal(JSON.stringify(res.body), JSON.stringify(initial.body));
    }
    assert.equal(f.messages.length, 1);

    const legacy = fixture();
    delete legacy.state.account.isVerified;
    assert.equal((await legacy.call('resendVerification', { email: 'alice@example.com' })).code, 202);
    assert.equal(legacy.messages.length, 1);
});

test('a resend after the cooldown replaces the previous token', async () => {
    const f = fixture();
    await f.call('resendVerification', { email: 'alice@example.com' });
    const oldToken = f.sentToken();
    f.state.now += 60_000;
    await f.call('resendVerification', { email: 'alice@example.com' });
    assert.equal(f.messages.length, 2);
    assert.notEqual(f.sentToken(), oldToken);
    assert.equal((await f.call('verifyEmail', { token: oldToken })).code, 400);
    assert.equal((await f.call('verifyEmail', { token: f.sentToken() })).code, 200);
});

test('verification consumes the token once, including simultaneous requests', async () => {
    const f = fixture();
    await f.call('resendVerification', { email: 'alice@example.com' });
    const token = f.sentToken();
    const results = await Promise.all([
        f.call('verifyEmail', { token }),
        f.call('verifyEmail', { token }),
    ]);
    assert.deepEqual(results.map(res => res.code).sort(), [200, 400]);
    assert.equal(f.state.account.isVerified, true);
    assert.equal(f.state.account.verificationTokenHash, undefined);
    assert.equal(f.state.account.verificationTokenExpiresAt, undefined);
    assert.equal(f.state.account.verificationTokenEmail, undefined);
    assert.equal((await f.call('verifyEmail', { token })).code, 400);
});

test('invalid, expired, and wrong-email tokens cannot verify an account', async () => {
    const f = fixture();
    for (const token of [undefined, null, '', 'bad', 42, { $ne: null }, ['a'.repeat(64)]]) {
        assert.equal((await f.call('verifyEmail', { token })).code, 400);
    }
    assert.equal(f.state.updates.length, 0);
    await f.call('resendVerification', { email: 'alice@example.com' });
    const token = f.sentToken();
    assert.equal((await f.call('verifyEmail', { token: 'f'.repeat(64) })).code, 400);
    f.state.now += 24 * 60 * 60 * 1000;
    assert.equal((await f.call('verifyEmail', { token })).code, 400);
    f.state.now -= 1000;
    f.state.account.email = 'new@example.com';
    assert.equal((await f.call('verifyEmail', { token })).code, 400);
    assert.equal(f.state.account.isVerified, false);
});

test('validation and configuration failures never send an email', async () => {
    const f = fixture();
    for (const email of [undefined, null, '', 'bad', { $ne: null }, ['alice@example.com']]) {
        assert.equal((await f.call('resendVerification', { email })).code, 400);
    }
    for (const url of ['', 'invalid', 'http://postit.example/verify', 'https://user:pass@postit.example/verify']) {
        f.env.EMAIL_VERIFICATION_URL = url;
        assert.equal((await f.call('resendVerification', { email: 'alice@example.com' })).code, 503);
    }
    f.env.EMAIL_VERIFICATION_URL = 'http://localhost:5173/verify-email';
    f.env.SENDGRID_API_KEY = '';
    assert.equal((await f.call('resendVerification', { email: 'alice@example.com' })).code, 503);
    assert.equal(f.state.updates.length, 0);
    assert.equal(f.messages.length, 0);
    f.env.SENDGRID_API_KEY = 'test-key';
    assert.equal((await f.call('resendVerification', { email: 'alice@example.com' })).code, 202);
});

test('delivery failure keeps the account, clears the failed token, and allows retry after cooldown', async () => {
    const f = fixture();
    f.state.deliveryFails = true;
    const res = await f.call('resendVerification', { email: 'alice@example.com' });
    assert.equal(res.code, 202);
    assert.equal(f.state.account.email, 'alice@example.com');
    assert.equal(f.state.account.isVerified, false);
    assert.equal(f.state.account.verificationTokenHash, undefined);
    assert.ok(f.state.account.verificationRequestedAt);
    assert.equal((await f.call('verifyEmail', { token: f.sentToken() })).code, 400);
    f.state.now += 60_000;
    f.state.deliveryFails = false;
    await f.call('resendVerification', { email: 'alice@example.com' });
    assert.equal((await f.call('verifyEmail', { token: f.sentToken() })).code, 200);
});

test('database failures return generic errors without sending email', async () => {
    const f = fixture();
    f.state.databaseFails = true;
    for (const [action, body] of [
        ['resendVerification', { email: 'alice@example.com' }],
        ['verifyEmail', { token: 'a'.repeat(64) }],
    ]) {
        const res = await f.call(action, body);
        assert.equal(res.code, 500);
        assert.equal(res.body.error, 'Internal server error');
    }
    assert.equal(f.messages.length, 0);
});

test('IP limiter blocks request eleven, isolates IPs, and expires after ten minutes', () => {
    const f = fixture();
    const req = { ip: '127.0.0.1' };
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
        f.api.limitVerificationResends(req, response(), () => allowed++);
    }
    const blocked = response();
    f.api.limitVerificationResends(req, blocked, () => assert.fail('must limit'));
    assert.equal(blocked.code, 429);
    assert.equal(blocked.headers['Retry-After'], '600');
    f.api.limitVerificationResends({ ip: '127.0.0.2' }, response(), () => allowed++);
    f.state.now += 600_000;
    f.api.limitVerificationResends(req, response(), () => allowed++);
    assert.equal(allowed, 12);
});

test('HTTP routes support resend and verification without real SendGrid delivery', async (t) => {
    const f = fixture();
    const express = require('express');
    const module = { exports: {} };
    const deps = {
        express,
        '../controllers/authController': { login() {}, register() {} },
        '../controllers/passwordResetController': { forgotPassword() {}, resetPassword() {} },
        '../controllers/emailVerificationController': f.api,
    };
    runInNewContext(readFileSync(require.resolve('../routes/auth'), 'utf8'), {
        module, require: name => deps[name],
    });
    const app = express();
    app.use(express.json());
    app.use('/api', module.exports);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port + '/api';
    async function post(path, body) {
        return fetch(base + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
    }
    assert.equal((await post('/resend-verification', { email: 'alice@example.com' })).status, 202);
    assert.equal((await post('/verify-email', { token: f.sentToken() })).status, 200);
    assert.equal((await post('/verify-email', { token: f.sentToken() })).status, 400);
    for (let i = 0; i < 9; i++) {
        assert.equal((await post('/resend-verification', { email: 'unknown@example.com' })).status, 202);
    }
    const limited = await post('/resend-verification', { email: 'unknown@example.com' });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
});
