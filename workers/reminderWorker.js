const { randomUUID } = require('node:crypto');
const { deliveryMode, createReminderDelivery } = require('../services/reminderDelivery');

function positiveInteger(env, key, fallback) {
  const value = Number(env[key] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
  return value;
}
function workerConfig(env = process.env) {
  const config = {
    deliveryMode: deliveryMode(env),
    intervalMs: positiveInteger(env, 'REMINDER_POLL_INTERVAL_MS', 5000),
    leaseMs: positiveInteger(env, 'REMINDER_LEASE_MS', 60000),
    timeoutMs: positiveInteger(env, 'REMINDER_PROVIDER_TIMEOUT_MS', 10000),
    maxAttempts: positiveInteger(env, 'REMINDER_MAX_ATTEMPTS', 3),
    retryMs: positiveInteger(env, 'REMINDER_RETRY_BASE_MS', 30000),
    batchSize: positiveInteger(env, 'REMINDER_BATCH_SIZE', 20)
  };
  if (config.leaseMs < config.timeoutMs * 3) {
    throw new Error('REMINDER_LEASE_MS must be at least three times the provider timeout');
  }
  return config;
}
// Only safe categories are persisted. Provider errors may contain tokens and recipients.
function safeProviderError(error) {
  const code = Number(error?.statusCode || error?.status || error?.code);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? `Provider HTTP ${code}` : 'Delivery attempt failed';
}
function createReminderWorker({
  Reminder = require('../models/Reminder'), Item = require('../models/Item'),
  sendEmail, sendSms,
  config = workerConfig(), now = () => new Date(), logger = console
} = {}) {
  const mode = config.deliveryMode || 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('Invalid delivery mode');
  const delivery = createReminderDelivery({ env: { ...process.env, REMINDER_DELIVERY_MODE: mode } });
  sendEmail ||= delivery.sendEmail;
  sendSms ||= delivery.sendSms;
  // Live delivery requires trusted authorization. Mock mode exercises the public
  // POST path without claiming that the caller is authenticated.
  const eligibility = mode === 'live'
    ? { deliveryAuthorized: true, userId: { $ne: null }, $or: [{ deliveryMode: 'live' }, { deliveryMode: null }] }
    : { $or: [{ deliveryMode: 'mock' }, { deliveryMode: null }] };
  let stopped = false;
  let timer;
  let running;

  async function processOne() {
    const current = now();
    // A crash on the final attempt must eventually become terminal too.
    await Reminder.updateMany({
      ...eligibility, status: 'processing', leaseUntil: { $lte: current }, attempts: { $gte: config.maxAttempts }
    }, { $set: { status: 'failed', lastError: 'Lease expired after final attempt', leaseUntil: null, claimToken: null } });
    const token = randomUUID();
    const reminder = await Reminder.findOneAndUpdate({
      ...eligibility,
      remindAt: { $lte: current },
      $and: [
        { $or: [{ attempts: { $lt: config.maxAttempts } }, { attempts: { $exists: false } }] },
        { $or: [
          { status: 'pending', $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: current } }] },
          { status: 'processing', leaseUntil: { $lte: current } }
        ] }
      ]
    }, {
      $set: { status: 'processing', deliveryMode: mode, claimToken: token, leaseUntil: new Date(current.getTime() + config.leaseMs) },
      $inc: { attempts: 1 }
    }, { returnDocument: 'after', sort: { remindAt: 1, _id: 1 } });
    if (!reminder) return false;
    const owned = () => ({ _id: reminder._id, ...eligibility, status: 'processing', claimToken: token });
    let heartbeat;
    try {
      // Refresh before delivery; a deleted Item or changed owner must not receive a reminder.
      const item = await Item.exists({
        _id: reminder.itemId,
        ...(mode === 'live' ? { userId: reminder.userId } : {})
      });
      if (!item) {
        await Reminder.updateOne(owned(), { $set: {
          status: 'cancelled', cancelledAt: now(), nextAttemptAt: null, lastError: 'Item unavailable or owner changed', claimToken: null, leaseUntil: null
        } });
        return true;
      }
      // Recheck the claim immediately before invoking the provider.
      const lease = await Reminder.updateOne({ ...owned(), leaseUntil: { $gt: now() } }, {
        $set: { leaseUntil: new Date(now().getTime() + config.leaseMs) }
      });
      if (!lease.matchedCount) return true;
      heartbeat = setInterval(() => {
        Reminder.updateOne({ ...owned(), leaseUntil: { $gt: now() } }, {
          $set: { leaseUntil: new Date(now().getTime() + config.leaseMs) }
        }).catch(() => logger.error('Reminder lease renewal failed'));
      }, Math.floor(config.leaseMs / 3));
      heartbeat.unref?.();
      let providerId;
      try {
        // Revalidate persisted data too: old or manually inserted rows may be invalid.
        const { validateReminder } = require('../lib/reminderValidation');
        const validation = validateReminder({
          itemId: String(reminder.itemId), channel: reminder.channel,
          recipient: reminder.recipient, message: reminder.message,
          remindAt: new Date(reminder.remindAt).toISOString()
        }, new Date(0));
        if (validation.error) throw new Error('Invalid stored reminder');
        if (!['email', 'sms'].includes(reminder.channel)) throw new Error('Invalid channel');
        providerId = await (reminder.channel === 'email' ? sendEmail(reminder) : sendSms(reminder));
      } catch (error) {
        const exhausted = reminder.attempts >= config.maxAttempts;
        await Reminder.updateOne(owned(), { $set: {
          status: exhausted ? 'failed' : 'pending',
          nextAttemptAt: exhausted ? null : new Date(now().getTime() + Math.min(config.retryMs * 2 ** (reminder.attempts - 1), 86400000)),
          lastError: safeProviderError(error), claimToken: null, leaseUntil: null
        } });
        return true;
      }
      // If this write fails, leave the lease for recovery; never pretend the send failed.
      await Reminder.updateOne(owned(), { $set: {
        status: 'sent', sentAt: now(), providerId, deliveryMode: mode, lastError: null,
        nextAttemptAt: null, claimToken: null, leaseUntil: null
      } });
      return true;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  async function tick() {
    for (let index = 0; index < config.batchSize && !stopped; index++) {
      if (!await processOne()) break;
    }
  }
  function start() {
    if (running || timer) return;
    stopped = false;
    const loop = () => {
      running = tick().catch(() => logger.error('Reminder worker cycle failed')).finally(() => {
        running = null;
        if (!stopped) timer = setTimeout(() => { timer = null; loop(); }, config.intervalMs);
      });
    };
    loop();
  }
  async function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    await running;
  }
  return { start, stop, tick, processOne };
}
module.exports = { createReminderWorker, workerConfig, safeProviderError };
