const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Board = require('../models/Board');
const Item = require('../models/Item');

async function authenticate(req, res, next) {
    const unauthorized = () => res.set('WWW-Authenticate', 'Basic realm="PostIt", charset="UTF-8"')
        .status(401).json({ error: 'Valid email and password are required' });

    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.get('Authorization') || '');
    if (!match) return unauthorized();

    const credentials = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = credentials.indexOf(':');
    if (separator <= 0) return unauthorized();

    const email = credentials.slice(0, separator);
    const password = credentials.slice(separator + 1);
    if (!email.trim() || !password) return unauthorized();

    try {
        const user = await User.findOne({ email: email.trim().toLowerCase() }).select('name email friends password');
        if (!user || !user.password || !(await bcrypt.compare(password, user.password))) return unauthorized();

        req.user = user;
        res.set('Cache-Control', 'no-store');
        next();
    } catch (error) {
        console.error('Authentication error:', error.name);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

const profile = (user) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    friends: user.friends,
});

function authorizeSelf(req, res, next) {
    const { userId } = req.params;
    if (!mongoose.isObjectIdOrHexString(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (!req.user._id.equals(userId)) {
        return res.status(403).json({ error: 'You can only access your own account' });
    }
    next();
}

function getUser(req, res) {
    return res.json({ user: profile(req.user) });
}

async function updateUser(req, res) {
    const { name, email, password } = req.body || {};
    const changes = {};

    if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Name must be a nonempty string' });
        }
        changes.name = name.trim();
    }

    if (email !== undefined) {
        if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return res.status(400).json({ error: 'A valid email is required' });
        }
        changes.email = email.trim().toLowerCase();
    }

    if (password !== undefined && (
        typeof password !== 'string' || !password.trim() || Buffer.byteLength(password) > 72
    )) {
        return res.status(400).json({ error: 'Password must be nonblank and at most 72 bytes' });
    }
    if (name === undefined && email === undefined && password === undefined) {
        return res.status(400).json({ error: 'Provide a name, email, or password to update' });
    }

    try {
        if (password !== undefined) changes.password = await bcrypt.hash(password, 12);

        const user = await User.findOneAndUpdate(
            { _id: req.user._id, password: req.user.password },
            { $set: changes },
            { returnDocument: 'after', runValidators: true }
        );
        if (!user) return res.status(409).json({ error: 'Account changed. Retry with your current credentials.' });
        return res.json({ user: profile(user) });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ error: 'Email already registered' });
        console.error('User update failed:', error.name);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

async function deleteUser(req, res) {
    try {
        const id = req.user._id;
        const references = await Promise.all([
            Board.exists({ $or: [{ ownerId: id }, { userIds: id }] }),
            Item.exists({ userId: id }),
            User.exists({ _id: { $ne: id }, friends: id }),
        ]);
        if (references.some(Boolean)) {
            return res.status(409).json({ error: 'Account is still referenced by boards, items, or friends' });
        }

        const result = await User.deleteOne({ _id: id, password: req.user.password });
        if (!result.deletedCount) {
            return res.status(409).json({ error: 'Account changed. Retry with your current credentials.' });
        }
        return res.status(204).end();
    } catch (error) {
        console.error('User deletion failed:', error.name);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { authenticate, authorizeSelf, getUser, updateUser, deleteUser };
