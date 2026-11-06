const { randomUUID } = require('node:crypto');
const { createEmailService } = require('./emailService');
const { createSmsService } = require('./smsService');

function deliveryMode(env = process.env) {
  const mode = env.REMINDER_DELIVERY_MODE || 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('REMINDER_DELIVERY_MODE must be mock or live');
  return mode;
}
function createReminderDelivery({ env = process.env } = {}) {
  const mode = deliveryMode(env);
  if (mode === 'mock') {
    // No SDK construction, credentials, network calls or recipient logging.
    return {
      sendEmail: async () => `mock-email-${randomUUID()}`,
      sendSms: async () => `mock-sms-${randomUUID()}`
    };
  }
  return { sendEmail: createEmailService({ env }), sendSms: createSmsService({ env }) };
}
module.exports = { deliveryMode, createReminderDelivery };
