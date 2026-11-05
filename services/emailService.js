// Construct lazily so API-only/test processes need no provider credentials.
function createEmailService({ env = process.env, client } = {}) {
  let mail = client;
  return async function sendEmail(reminder) {
    if (!env.SENDGRID_API_KEY || !env.SENDGRID_FROM_EMAIL) {
      throw new Error('Email provider is not configured');
    }
    if (!mail) mail = new (require('@sendgrid/mail').MailService)();
    mail.setApiKey(env.SENDGRID_API_KEY);
    mail.setTimeout(Number(env.REMINDER_PROVIDER_TIMEOUT_MS || 10000));
    const [response] = await mail.send({
      to: reminder.recipient,
      from: env.SENDGRID_FROM_EMAIL,
      subject: 'PostIt reminder',
      text: reminder.message
    });
    if (!response || response.statusCode !== 202) {
      throw new Error('Email provider did not accept request');
    }
    return response.headers?.['x-message-id'] || null;
  };
}
module.exports = { createEmailService };
