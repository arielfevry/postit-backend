const { createHash, randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { isEmail } = require('validator');
const User = require('../models/User');
const { createEmailService } = require('../services/emailService');

const sendEmail = createEmailService();
const resetLifetimeMs = 30 * 60 * 1000;
const resetCooldownMs = 60 * 1000;
const clearResetToken = { passwordResetDigest: '', passwordResetExpiresAt: '' };

function digest(token) {
    return createHash('sha256').update(token).digest('hex');
}

async function forgotPassword(req, res) {
    res.set('Cache-Control', 'no-store');
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!isEmail(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
    }

    const resetUrl = URL.parse(process.env.PASSWORD_RESET_URL || '');
    const localHttp = resetUrl?.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(resetUrl.hostname);
    if (!resetUrl || (resetUrl.protocol !== 'https:' && !localHttp) ||
        resetUrl.username || resetUrl.password || !process.env.SENDGRID_API_KEY ||
        !process.env.SENDGRID_FROM_EMAIL) {
        return res.status(503).json({ error: 'Password reset email is unavailable' });
    }

    try {
        const now = Date.now();
        const token = randomBytes(32).toString('hex');
        const passwordResetDigest = digest(token);
        const result = await User.updateOne(
            {
                email,
                $or: [
                    { passwordResetRequestedAt: { $exists: false } },
                    { passwordResetRequestedAt: { $lte: new Date(now - resetCooldownMs) } },
                ],
            },
            {
                $set: {
                    passwordResetDigest,
                    passwordResetExpiresAt: new Date(now + resetLifetimeMs),
                    passwordResetRequestedAt: new Date(now),
                },
            }
        );

        // Reply before sending the email so the wait doesn't give away whether the account exists.
        res.status(202).json({ message: 'If the account exists, password reset instructions will be sent.' });
        if (!result.modifiedCount) return;

        resetUrl.searchParams.set('token', token);
        try {
            await sendEmail({
                recipient: email,
                subject: 'Reset your PostIt password',
                message: 'Reset your PostIt password using this link within 30 minutes:\n' + resetUrl.href,
            });
        } catch {
            console.error('Password reset email delivery failed');
            // If the email fails clear token and keep the one minute wait.
            await User.updateOne({ email, passwordResetDigest }, { $unset: clearResetToken });
        }
    } catch {
        console.error('Password reset request failed');
        if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
    }
}

async function resetPassword(req, res) {
    res.set('Cache-Control', 'no-store');
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        return res.status(400).json({ error: 'Invalid or expired password reset token' });
    }
    if (typeof password !== 'string' || !password.trim() || bcrypt.truncates(password)) {
        return res.status(400).json({ error: 'Password must be nonblank and at most 72 bytes' });
    }

    try {
        const passwordResetDigest = digest(token);
        const activeToken = () => ({
            passwordResetDigest,
            passwordResetExpiresAt: { $gt: new Date() },
        });
        if (await User.exists(activeToken())) {
            const passwordHash = await bcrypt.hash(password, 12);
            const result = await User.updateOne(activeToken(), {
                $set: { password: passwordHash },
                $unset: clearResetToken,
            }, { runValidators: true });
            if (result.modifiedCount) return res.status(204).end();
        }

        return res.status(400).json({ error: 'Invalid or expired password reset token' });
    } catch {
        console.error('Password reset failed');
        return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { forgotPassword, resetPassword };
