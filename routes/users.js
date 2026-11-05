const express = require('express');
const { authenticate, authorizeSelf, getUser, updateUser, deleteUser } = require('../controllers/userController');

const router = express.Router();

router.route('/:userId')
    .all(authenticate, authorizeSelf)
    .get(getUser)
    .patch(updateUser)
    .delete(deleteUser);

module.exports = router;
