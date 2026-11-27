const { createHash, randomBytes } = require('node:crypto');
const { isEmail } = require('validator');
const User = require('../models/User');
const { createEmailService } = require('../services/emailService');

const sendEmail = createEmailService();
const tokenLifetimeMs = 24 * 60 * 60 * 1000;
const resendCooldownMs = 60 * 1000;
const requestWindowMs = 10 * 60 * 1000;
const resendRequests = new Map();

function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

function limitVerificationResends(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    const key = req.ip;
    let entry = resendRequests.get(key);

    if (!entry || entry.expiresAt <= now) {
        // Remove old entries before keeping another visitor's counter.
        for (const [ip, counter] of resendRequests) {
            if (counter.expiresAt <= now) resendRequests.delete(ip);
        }
        if (resendRequests.size >= 10000) {
            return res.set('Retry-After', '600').status(429).json({ error: 'Please try again later' });
        }
        entry = { count: 0, expiresAt: now + requestWindowMs };
        resendRequests.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > 10) {
        return res.set('Retry-After', String(Math.ceil((entry.expiresAt - now) / 1000)))
            .status(429).json({ error: 'Too many verification requests. Please try again later.' });
    }
    return next();
}

async function verifyEmail(req, res) {
    res.set('Cache-Control', 'no-store');
    const { token } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    try {
        // Checking and clearing the token in one update prevents it from being reused.
        const result = await User.updateOne({
            isVerified: { $ne: true },
            verificationTokenHash: hashToken(token),
            verificationTokenExpiresAt: { $gt: new Date() },
            $expr: { $eq: ['$email', '$verificationTokenEmail'] },
        }, {
            $set: { isVerified: true },
            $unset: {
                verificationTokenHash: '',
                verificationTokenExpiresAt: '',
                verificationTokenEmail: '',
            },
        }, { runValidators: true });

        if (!result.modifiedCount) {
            return res.status(400).json({ error: 'Invalid or expired verification token' });
        }
        return res.json({ message: 'Email verified successfully' });
    } catch {
        console.error('Email verification failed');
        return res.status(500).json({ error: 'Internal server error' });
    }
}

async function resendVerification(req, res) {
    res.set('Cache-Control', 'no-store');
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!isEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
    }

    let verificationUrl;
    try {
        verificationUrl = new URL(process.env.EMAIL_VERIFICATION_URL);
    } catch {
        return res.status(503).json({ error: 'Verification email is unavailable' });
    }
    const localHttp = verificationUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(verificationUrl.hostname);
    if ((verificationUrl.protocol !== 'https:' && !localHttp) ||
        verificationUrl.username || verificationUrl.password ||
        !process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
        return res.status(503).json({ error: 'Verification email is unavailable' });
    }

    try {
        const now = Date.now();
        const token = randomBytes(32).toString('hex');
        const verificationTokenHash = hashToken(token);
        const result = await User.updateOne({
            email,
            isVerified: { $ne: true },
            $or: [
                { verificationRequestedAt: { $exists: false } },
                { verificationRequestedAt: { $lte: new Date(now - resendCooldownMs) } },
            ],
        }, {
            $set: {
                verificationTokenHash,
                verificationTokenEmail: email,
                verificationTokenExpiresAt: new Date(now + tokenLifetimeMs),
                verificationRequestedAt: new Date(now),
            },
        });

        // Use the same reply for unknown, verified, and recently requested accounts.
        res.status(202).json({
            message: 'If the account needs verification, instructions will be sent.',
        });
        if (!result.modifiedCount) return;

        verificationUrl.searchParams.set('token', token);
        try {
            await sendEmail({
                recipient: email,
                subject: 'Welcome to Post It! Verify your email',
                message: 'Welcome to Post It! Verify your email using this link within 24 hours:\n' +
                    verificationUrl.href,
            });
        } catch {
            // Keep the account and cooldown so the user can request another email.
            console.error('Verification email delivery failed');
            await User.updateOne({ email, verificationTokenHash }, {
                $unset: {
                    verificationTokenHash: '',
                    verificationTokenExpiresAt: '',
                    verificationTokenEmail: '',
                },
            });
        }
    } catch {
        console.error('Verification email request failed');
        if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { verifyEmail, resendVerification, limitVerificationResends };
