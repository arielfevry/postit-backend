const validator = require('validator');
const mongoose = require('mongoose');
const isId = value => typeof value === 'string' && mongoose.isObjectIdOrHexString(value);
const isPhone = value => typeof value === 'string' && /^\+[1-9]\d{1,14}$/.test(value);
const isEmail = value => typeof value === 'string' && validator.isEmail(value, {
  allow_display_name: false, allow_utf8_local_part: false, require_tld: true
});

function validateReminder(body, now = new Date()) {
  const allowed = ['itemId', 'channel', 'recipient', 'remindAt', 'message'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))) {
    return { error: 'Provide itemId, channel, recipient, remindAt, and message only' };
  }
  if (!isId(body.itemId)) return { error: 'Invalid Item ID' };
  if (!['email', 'sms'].includes(body.channel)) return { error: 'Channel must be email or sms' };
  const recipient = typeof body.recipient === 'string' ? body.recipient.trim() : '';
  if (!(body.channel === 'email' ? isEmail(recipient) : isPhone(recipient))) {
    return { error: body.channel === 'email' ? 'Invalid email address' : 'Phone number must use E.164 format' };
  }
  // Require a complete ISO date-time with explicit timezone, avoiding local-time ambiguity.
  if (typeof body.remindAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.remindAt) ||
      !validator.isISO8601(body.remindAt, { strict: true, strictSeparator: true })) {
    return { error: 'remindAt must be an ISO date-time with a timezone' };
  }
  const remindAt = new Date(body.remindAt);
  if (!Number.isFinite(remindAt.getTime()) || remindAt <= now) {
    return { error: 'Reminder time must be a valid future date' };
  }
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.trim().length > 1600) {
    return { error: 'Message must contain 1 to 1600 characters' };
  }
  return { value: { itemId: body.itemId, channel: body.channel, recipient, remindAt, message: body.message.trim() } };
}
module.exports = { isId, isPhone, isEmail, validateReminder };
