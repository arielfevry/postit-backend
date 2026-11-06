// Optional dedicated worker; the API can also run the same polling loop.
const mongoose = require('mongoose');
const { createReminderWorker } = require('./reminderWorker');
async function main() {
  if (process.env.REMINDER_WORKER_ENABLED !== 'true') {
    console.log('Reminder worker disabled');
    return;
  }
  await mongoose.connect(process.env.MONGODB_URI);
  await require('../models/Reminder').init();
  const worker = createReminderWorker();
  worker.start();
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await worker.stop();
    await mongoose.disconnect();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
if (require.main === module) main().catch(async () => {
  console.error('Reminder worker startup failed');
  await mongoose.disconnect();
  process.exitCode = 1;
});
module.exports = { main };
