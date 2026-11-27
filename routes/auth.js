const express = require('express');

const router = express.Router();

const {login, register} = require('../controllers/authController');

const { forgotPassword, resetPassword } = require('../controllers/passwordResetController');

const {
    verifyEmail, resendVerification, limitVerificationResends,
} = require('../controllers/emailVerificationController');

//login and register endpoint
router.post('/login', login);
router.post('/register', register);

router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

router.post('/verify-email', verifyEmail);
router.post('/resend-verification', limitVerificationResends, resendVerification);

module.exports = router;