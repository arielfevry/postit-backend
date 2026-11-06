const express = require('express');

const { authorizeSelf, getUser, updateUser, deleteUser } = require('../controllers/userController');
const authenticate = require('../middleware/authenticate');
const loadAuthenticatedUser = require('../middleware/loadAuthenticatedUser');


const router = express.Router();

router.route('/:userId')
    .all(authenticate, loadAuthenticatedUser, authorizeSelf)
    .get(getUser)
    .patch(updateUser)
    .delete(deleteUser);

module.exports = router;
