
const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema(
  {
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Item',
      required: true
    },

    // Set by the authenticated POST controller after verifying Item ownership.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Null until first claim; mock results must not be mistaken for provider acceptance.
    deliveryMode: { type: String, enum: ['mock', 'live'], default: null },
    deliveryAuthorized: { type: Boolean, default: false },
    attempts: { type: Number, default: 0, min: 0 },
    lastError: { type: String, default: null },
    nextAttemptAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    claimToken: { type: String, default: null },
    providerId: { type: String, default: null },

    channel: {
      type: String,
      enum: ['email', 'sms'],
      required: true
    },

    recipient: {
      type: String,
      required: true,
      trim: true
    },

    remindAt: {
      type: Date,
      required: true
    },

    message: {
      type: String,
      required: true
    },

    status: {
      type: String,
      enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'],
      default: 'pending'
    },

    cancelledAt: { type: Date, default: null },

    sentAt: {
      type: Date,
      default: null
    }
  },
  {
    collection: 'reminders',
    timestamps: true,
    versionKey: false
  }
);

reminderSchema.index({ deliveryAuthorized: 1, status: 1, remindAt: 1 });
reminderSchema.index({ status: 1, leaseUntil: 1 });
reminderSchema.index({ userId: 1, remindAt: 1, _id: 1 });

module.exports = mongoose.model('Reminder', reminderSchema);
