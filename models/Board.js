const mongoose = require("mongoose");

const boardSchema = new mongoose.Schema(
{
	title: { type: String,
		trim: true,
		required: true},
	background_image: { type: String,
		trim: true,
		default: ""},
	ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
	userIds: [
	{
		type: mongoose.Schema.Types.ObjectId,
		ref: "User",
	}, ],
},
{
	collection: "boards", versionKey: false, timestamps: true
}

);

module.exports = mongoose.model('Board', boardSchema);
