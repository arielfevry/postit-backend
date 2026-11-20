const express = require('express');

const { authorizeSelf, searchUser, getUser, updateUser, deleteUser } = require('../controllers/userController');
const authenticate = require('../middleware/authenticate');
const loadAuthenticatedUser = require('../middleware/loadAuthenticatedUser');


const router = express.Router();

router.get('/search', authenticate, loadAuthenticatedUser, searchUser);

router.route('/:userId')
    .all(authenticate, loadAuthenticatedUser, authorizeSelf)
    .get(getUser)
    .patch(updateUser)
    .delete(deleteUser);

module.exports = router;
