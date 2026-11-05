
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');

const {
  createReminder, getReminders, getReminder, cancelReminder
} = require('../controllers/reminderController');

// CREATE - Schedule a new Email/SMS reminder
router.post('/', authenticate, createReminder);

router.get('/', authenticate, getReminders);
router.get('/:id', authenticate, getReminder);
router.delete('/:id', authenticate, cancelReminder);

module.exports = router;
