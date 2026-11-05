function createSmsService({ env = process.env, client } = {}) {
  let sms = client;
  return async function sendSms(reminder) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_PHONE) {
      throw new Error('SMS provider is not configured');
    }
    if (!/^\+[1-9]\d{1,14}$/.test(env.TWILIO_FROM_PHONE)) {
      throw new Error('SMS sender must use E.164 format');
    }
    if (!sms) sms = require('twilio')(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, {
      timeout: Number(env.REMINDER_PROVIDER_TIMEOUT_MS || 10000),
      autoRetry: false
    });
    const response = await sms.messages.create({
      to: reminder.recipient,
      from: env.TWILIO_FROM_PHONE,
      body: reminder.message
    });
    if (!response?.sid || ['failed', 'undelivered', 'canceled'].includes(response.status)) {
      throw new Error('SMS provider did not accept request');
    }
    return response.sid;
  };
}
module.exports = { createSmsService };
