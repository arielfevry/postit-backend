const User = require('../models/User');
const { verifyAccessToken, JwtConfigurationError } = require('../lib/jwt');

async function authenticate(req, res, next) {
  const header = req.get('authorization');
  const match = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return res.status(401).json({ message: 'Authentication required' });
  let claims;
  try {
    claims = verifyAccessToken(match[1]);
  } catch (error) {
    if (error instanceof JwtConfigurationError) {
      return res.status(500).json({ message: 'Authentication is not configured' });
    }
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  try {
    if (!await User.exists({ _id: claims.sub })) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
  } catch {
    return res.status(500).json({ message: 'Internal server error' });
  }
  req.user = { id: claims.sub };
  return next();
}
module.exports = authenticate;
