const express = require('express');

const router = express.Router();

const {login, register} = require('../controllers/authController');

const { forgotPassword, resetPassword } = require('../controllers/passwordResetController');

//login and register endpoint
router.post('/login', login);
router.post('/register', register);

router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;