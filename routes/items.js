const express = require('express');
const router = express.Router();

const {
  createItem,
  getItems,
  updateItem,
  deleteItem
} = require('../controllers/itemController');

// CREATE - Create a new sticky note
router.post('/', createItem);

// READ - Get all sticky notes from a board
router.get('/', getItems);

// UPDATE - Update an existing sticky note
router.put('/:id', updateItem);

// DELETE - Delete an existing sticky note
router.delete('/:id', deleteItem);

module.exports = router;

