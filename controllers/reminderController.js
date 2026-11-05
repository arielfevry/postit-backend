const Reminder = require('../models/Reminder');
const Item = require('../models/Item');
const { validateReminder, isId } = require('../lib/reminderValidation');

// Never expose worker coordination state, including in the existing POST response.
function publicReminder(reminder) {
  const value = reminder.toObject ? reminder.toObject() : { ...reminder };
  delete value.claimToken;
  delete value.leaseUntil;
  return value;
}

// Authentication is supplied by the shared JWT middleware.
const createReminder = async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  const { value, error } = validateReminder(req.body);
  if (error) return res.status(400).json({ message: error });
  try {
    const item = await Item.findOne({ _id: value.itemId, userId: req.user.id });
    if (!item) return res.status(404).json({ message: 'Item not found' });
    const reminder = await Reminder.create({ ...value, userId: req.user.id, deliveryAuthorized: true });
    return res.status(201).json({ message: 'Reminder created successfully', reminder: publicReminder(reminder) });
  } catch (error) {
    if (['ValidationError', 'CastError'].includes(error.name)) {
      return res.status(400).json({ message: 'Invalid reminder data' });
    }
    console.error('Create reminder failed');
    return res.status(500).json({ message: 'Internal server error' });
  }
};
const statuses = ['pending', 'processing', 'sent', 'failed', 'cancelled'];
const publicProjection = '-claimToken -leaseUntil';

function paginationInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= max ? number : null;
}

async function getReminders(req, res) {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  const query = req.query || {};
  if (Object.keys(query).some(key => !['itemId', 'status', 'page', 'limit'].includes(key))) {
    return res.status(400).json({ message: 'Supported query parameters: itemId, status, page, limit' });
  }
  if (query.itemId !== undefined && !isId(query.itemId)) return res.status(400).json({ message: 'Invalid Item ID' });
  if (query.status !== undefined && !statuses.includes(query.status)) return res.status(400).json({ message: 'Invalid reminder status' });
  const page = paginationInteger(query.page, 1, 10000);
  const limit = paginationInteger(query.limit, 20, 100);
  if (page === null || limit === null) return res.status(400).json({ message: 'page must be 1–10000 and limit must be 1–100' });
  const filter = { userId: req.user.id };
  if (query.itemId !== undefined) filter.itemId = query.itemId;
  if (query.status !== undefined) filter.status = query.status;
  try {
    const rows = await Reminder.find(filter).select(publicProjection)
      .sort({ remindAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit + 1).lean();
    return res.status(200).json({ message: 'Reminders retrieved successfully',
      reminders: rows.slice(0, limit).map(publicReminder), pagination: { page, limit, hasMore: rows.length > limit } });
  } catch {
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getReminder(req, res) {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid Reminder ID' });
  try {
    const reminder = await Reminder.findOne({ _id: req.params.id, userId: req.user.id }).select(publicProjection).lean();
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });
    return res.status(200).json({ message: 'Reminder retrieved successfully', reminder: publicReminder(reminder) });
  } catch {
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function cancelReminder(req, res) {
  if (!req.user?.id) return res.status(401).json({ message: 'Authentication required' });
  if (!isId(req.params.id)) return res.status(400).json({ message: 'Invalid Reminder ID' });
  const owner = { _id: req.params.id, userId: req.user.id };
  try {
    // The status predicate competes atomically with the worker's pending claim.
    const cancelled = await Reminder.findOneAndUpdate({ ...owner, status: 'pending' }, {
      $set: { status: 'cancelled', cancelledAt: new Date(), nextAttemptAt: null, claimToken: null, leaseUntil: null }
    }, { returnDocument: 'after', runValidators: true, upsert: false }).select(publicProjection).lean();
    if (cancelled) return res.status(200).json({ message: 'Reminder cancelled successfully', reminder: publicReminder(cancelled) });
    const existing = await Reminder.findOne(owner).select(publicProjection).lean();
    if (!existing) return res.status(404).json({ message: 'Reminder not found' });
    if (existing.status === 'cancelled') return res.status(200).json({ message: 'Reminder cancelled successfully', reminder: publicReminder(existing) });
    return res.status(409).json({ message: 'Only pending reminders can be cancelled', status: existing.status });
  } catch {
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = { createReminder, getReminders, getReminder, cancelReminder };
