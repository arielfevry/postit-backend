
const Item = require('../models/Item');
const mongoose = require('mongoose');

// ==========================================
// CREATE ITEM - POST /api/items
// ==========================================
const createItem = async (req, res) => {
  try {
    const { boardId, userId, type, content } = req.body || {};

    // Validate required fields
    if (!boardId || !userId || content == null) {
      return res.status(400).json({
        message: 'boardId, userId, and content are required'
      });
    }

    // Create a new sticky note
    const item = await Item.create({
      boardId,
      userId,
      type,
      content
    });

    return res.status(201).json({
      message: 'Item created successfully',
      item
    });

  } catch (error) {
    // Handle invalid data
    if (
      error.name === 'ValidationError' ||
      error.name === 'CastError'
    ) {
      return res.status(400).json({
        message: error.message
      });
    }

    console.error('Create item error:', error);

    return res.status(500).json({
      message: 'Internal server error'
    });
  }
};

// ==========================================
// READ ITEMS - GET /api/items?boardId=...
// ==========================================
const getItems = async (req, res) => {
  const { boardId } = req.query;

  // Validate boardId
  if (typeof boardId !== 'string' || boardId.trim() === '') {
    return res.status(400).json({
      message: 'boardId is required and must be a single string'
    });
  }

  if (!mongoose.isObjectIdOrHexString(boardId)) {
    return res.status(400).json({
      message: 'boardId must be a valid MongoDB ObjectId'
    });
  }

  try {
    // Find all items belonging to this board
    const items = await Item.find({ boardId });

    return res.status(200).json({
      message: 'Items retrieved successfully',
      items
    });

  } catch (error) {
    console.error('Get items error:', error);

    return res.status(500).json({
      message: 'Internal server error'
    });
  }
};

// ==========================================
// UPDATE ITEM - PUT /api/items/:id
// ==========================================
const updateItem = async (req, res) => {
  const { id } = req.params;

  // Step 1: Validate Item ID
  if (!mongoose.isObjectIdOrHexString(id)) {
    return res.status(400).json({
      message: 'Item ID must be a valid MongoDB ObjectId'
    });
  }

  // Step 2: Validate request body
  const body = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      message: 'Request body must be a JSON object'
    });
  }

  // Only allow content and type to be updated
  const allowedFields = ['content', 'type'];
  const fields = Object.keys(body);

  if (
    fields.length === 0 ||
    fields.some((field) => !allowedFields.includes(field))
  ) {
    return res.status(400).json({
      message: 'Provide content and/or type only'
    });
  }

  // Step 3: Prepare update fields
  const updates = {};

  // Validate content
  if (Object.prototype.hasOwnProperty.call(body, 'content')) {
    if (body.content == null) {
      return res.status(400).json({
        message: 'content cannot be null'
      });
    }

    updates.content = body.content;
  }

  // Validate type
  if (Object.prototype.hasOwnProperty.call(body, 'type')) {
    if (typeof body.type !== 'string') {
      return res.status(400).json({
        message: 'type must be a string'
      });
    }

    updates.type = body.type;
  }

  // Step 4: Update item in MongoDB
  try {
    const item = await Item.findByIdAndUpdate(
      id,
      { $set: updates },
      {
        returnDocument: 'after',
        runValidators: true,
        upsert: false
      }
    );

    // Item does not exist
    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      });
    }

    return res.status(200).json({
      message: 'Item updated successfully',
      item
    });

  } catch (error) {
    // Handle validation errors
    if (
      error.name === 'ValidationError' ||
      error.name === 'CastError'
    ) {
      return res.status(400).json({
        message: error.message
      });
    }

    console.error('Update item error:', error);

    return res.status(500).json({
      message: 'Internal server error'
    });
  }
};

// ==========================================
// DELETE ITEM - DELETE /api/items/:id
// ==========================================
const deleteItem = async (req, res) => {
  const { id } = req.params;

  // Step 1: Validate Item ID
  if (!mongoose.isObjectIdOrHexString(id)) {
    return res.status(400).json({
      message: 'Item ID must be a valid MongoDB ObjectId'
    });
  }

  // Step 2: Delete item from MongoDB
  try {
    const item = await Item.findByIdAndDelete(id);

    // Item does not exist
    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      });
    }

    return res.status(200).json({
      message: 'Item deleted successfully',
      item
    });

  } catch (error) {
    console.error('Delete item error:', error);

    return res.status(500).json({
      message: 'Internal server error'
    });
  }
};

// ==========================================
// EXPORT CONTROLLERS
// ==========================================
module.exports = {
  createItem,
  getItems,
  updateItem,
  deleteItem
};

