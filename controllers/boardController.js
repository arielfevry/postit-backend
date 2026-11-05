const mongoose = require('mongoose');
const Board = require('../models/Board');
const Item = require('../models/Item');

function boardFields(req, res, next) {
    const { title, background_image } = req.body || {};
    if (title === undefined && (req.method === 'POST' || background_image === undefined)) {
        return res.status(400).json({ error: 'Provide a title for a new board or fields to update' });
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
        return res.status(400).json({ error: 'Title must be a nonempty string' });
    }
    if (background_image !== undefined && typeof background_image !== 'string') {
        return res.status(400).json({ error: 'Background image must be a string' });
    }

    res.locals.boardFields = {};
    if (title !== undefined) res.locals.boardFields.title = title.trim();
    if (background_image !== undefined) res.locals.boardFields.background_image = background_image.trim();
    next();
}

function validateBoardId(req, res, next) {
    if (!mongoose.isObjectIdOrHexString(req.params.boardId)) {
        return res.status(400).json({ error: 'Invalid board ID' });
    }
    next();
}

function accessibleBoards(userId) {
    return { $or: [{ ownerId: userId }, { userIds: userId }] };
}

function boardNotFound(res) {
    return res.status(404).json({ error: 'Board not found' });
}

async function createBoard(req, res) {
    const board = await Board.create({
        ...res.locals.boardFields,
        ownerId: req.user._id,
        userIds: [req.user._id],
    });
    return res.status(201).location('/api/boards/' + board.id).json({ board });
}

async function listBoards(req, res) {
    const boards = await Board.find(accessibleBoards(req.user._id));
    return res.json({ boards });
}

async function getBoard(req, res) {
    const board = await Board.findOne({
        _id: req.params.boardId,
        ...accessibleBoards(req.user._id),
    });
    if (!board) return boardNotFound(res);
    return res.json({ board });
}

async function updateBoard(req, res) {
    const board = await Board.findOneAndUpdate(
        { _id: req.params.boardId, ownerId: req.user._id },
        { $set: res.locals.boardFields },
        { returnDocument: 'after', runValidators: true }
    );
    if (!board) return boardNotFound(res);
    return res.json({ board });
}

async function deleteBoard(req, res) {
    const filter = { _id: req.params.boardId, ownerId: req.user._id };
    if (!(await Board.exists(filter))) return boardNotFound(res);

    if (await Item.exists({ boardId: req.params.boardId })) {
        return res.status(409).json({ error: 'Remove the board items before deleting the board' });
    }

    const result = await Board.deleteOne(filter);
    if (!result.deletedCount) return boardNotFound(res);
    return res.status(204).end();
}

module.exports = { boardFields, validateBoardId, createBoard, listBoards, getBoard, updateBoard, deleteBoard };
