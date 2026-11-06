const express = require('express');

const authenticate = require('../middleware/authenticate');
const loadAuthenticatedUser = require('../middleware/loadAuthenticatedUser');

const {
    boardFields, validateBoardId, createBoard, listBoards, getBoard, updateBoard, deleteBoard,
} = require('../controllers/boardController');

const router = express.Router();

router.use(authenticate, loadAuthenticatedUser);
router.route('/')
    .get(listBoards)
    .post(boardFields, createBoard);
router.route('/:boardId')
    .all(validateBoardId)
    .get(getBoard)
    .patch(boardFields, updateBoard)
    .delete(deleteBoard);

router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.name === 'ValidationError') {
        return res.status(400).json({ error: 'Invalid board fields' });
    }
    console.error('Board operation failed:', error.name);
    return res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;
