const mongoose = require('mongoose');
const User = require('../models/User');

// Load the authenticated user for User and Board CRUD controllers.
async function loadAuthenticatedUser(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId || !mongoose.isObjectIdOrHexString(userId)) {
      return res.status(401).json({
        message: 'Authentication required'
      });
    }

    const user = await User.findById(userId)
      .select('name email friends password');

    if (!user) {
      return res.status(401).json({
        message: 'Authentication required'
      });
    }

    // Sam's controllers expect a Mongoose user document.
    req.user = user;
    // Preserve the no-cache behavior of the original Basic Auth middleware.
    res.set('Cache-Control', 'no-store');
    return next();
  } catch (error) {
    console.error('Failed to load authenticated user:', error.name);
    return res.status(500).json({
      message: 'Internal server error'
    });
  }
}

module.exports = loadAuthenticatedUser;
