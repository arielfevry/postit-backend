const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const bcrypt = require('bcryptjs');
const validator = require('validator');

function fixture() {
    const email = 'alice@example.com';
    const account = { email, password: 'old-hash' };
    const messages = [];
    const env = {
        PASSWORD_RESET_URL: 'https://postit.example/reset-password',
        SENDGRID_API_KEY: 'test',
        SENDGRID_FROM_EMAIL: 'sender@example.com',
    };

    function matches(filter) {
        if (filter.email && filter.email !== account.email) return false;
        if (filter.$or && account.passwordResetRequestedAt > filter.$or[1].passwordResetRequestedAt.$lte) return false;
        if (filter.passwordResetDigest && filter.passwordResetDigest !== account.passwordResetDigest) return false;
        if (filter.passwordResetExpiresAt && !(account.passwordResetExpiresAt > filter.passwordResetExpiresAt.$gt)) return false;
        return true;
    }

    const dependencies = {
        'node:crypto': require('node:crypto'),
        bcryptjs: bcrypt,
        validator,
        '../models/User': {
            async exists(filter) { return matches(filter); },
            async updateOne(filter, { $set, $unset }) {
                if (!matches(filter)) return { modifiedCount: 0 };
                Object.assign(account, $set);
                for (const key of Object.keys($unset || {})) delete account[key];
                return { modifiedCount: 1 };
            },
        },
        '../services/emailService': {
            createEmailService: () => async (message) => { messages.push(message); },
        },
    };
    const module = { exports: {} };
    runInNewContext(readFileSync(require.resolve('../controllers/passwordResetController'), 'utf8'), {
        module, require: (name) => dependencies[name], process: { env }, URL,
    });

    async function call(action, body) {
        const response = {
            status(code) { this.code = code; return this; },
            set() {},
            json(payload) { this.body = JSON.stringify(payload); return this; },
            end() {},
        };
        await module.exports[action]({ body }, response);
        return response;
    }
    return { account, email, messages, env, call };
}

test('reset emails are generic, throttled per account, and contain only the raw token sent to that account', async () => {
    const { account, email, messages, call, env } = fixture();
    assert.equal((await call('forgotPassword', { email: { $ne: null } })).code, 400);
    const missing = await call('forgotPassword', { email: 'missing@example.com' });
    const issued = await call('forgotPassword', { email: ' ALICE@example.com ' });
    assert.equal(issued.code, 202);
    assert.equal(missing.body, issued.body);
    await call('forgotPassword', { email });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].recipient, email);
    const link = new URL(messages[0].message.split('\n').at(-1));
    assert.equal(link.origin, 'https://postit.example');
    const token = link.searchParams.get('token');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(account.passwordResetDigest, createHash('sha256').update(token).digest('hex'));
    assert.ok(!issued.body.includes(token));
    env.PASSWORD_RESET_URL = 'http://postit.example/reset-password';
    assert.equal((await call('forgotPassword', { email })).code, 503);
});

test('password reset rejects expired tokens and consumes a valid token atomically', async () => {
    const { account, email, messages, call } = fixture();
    await call('forgotPassword', { email });
    const token = new URL(messages[0].message.split('\n').at(-1)).searchParams.get('token');
    account.passwordResetExpiresAt = new Date(0);
    assert.equal((await call('resetPassword', { token, password: 'new password' })).code, 400);
    assert.equal(account.password, 'old-hash');
    account.passwordResetExpiresAt = new Date(Date.now() + 60_000);
    assert.equal((await call('resetPassword', { token, password: 'é'.repeat(37) })).code, 400);
    const results = await Promise.all([
        call('resetPassword', { token, password: 'new password' }),
        call('resetPassword', { token, password: 'new password' }),
    ]);
    assert.deepEqual(results.map(result => result.code).sort(), [204, 400]);
    assert.ok(await bcrypt.compare('new password', account.password));
    assert.equal(account.passwordResetDigest, undefined);
});
