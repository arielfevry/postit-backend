const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
{
	name: { type: String,
		required: true,
		trim: true},
	email: { type: String,
		trim: true,
		required: true,
		unique: true,
		lowercase: true},
	password: { type: String, required: true},
	isVerified: { type: Boolean, default: false },
	verificationTokenHash: { type: String, select: false, index: { sparse: true } },
	verificationTokenExpiresAt: { type: Date, select: false },
	verificationTokenEmail: { type: String, select: false },
	verificationRequestedAt: { type: Date, select: false },
	passwordResetDigest: { type: String, select: false, index: { sparse: true } },
	passwordResetExpiresAt: { type: Date, select: false },
	passwordResetRequestedAt: { type: Date, select: false },
	friends: [
	{
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
	},
	],

},
{ timestamps: true, collection: 'users', versionKey: false }
);

module.exports = mongoose.model('User', userSchema);
