const jwt = require('jsonwebtoken');

class JwtConfigurationError extends Error {}
function jwtConfig(env = process.env) {
  const secret = env.JWT_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret.trim()) < 32) {
    throw new JwtConfigurationError('JWT_SECRET must contain at least 32 bytes');
  }
  const expiresIn = env.JWT_EXPIRES_IN || '1h';
  // Explicit units avoid the library treating numeric strings as milliseconds.
  if (!/^[1-9]\d*(s|m|h|d)$/.test(expiresIn)) {
    throw new JwtConfigurationError('JWT_EXPIRES_IN must be a positive duration with units');
  }
  return { secret, expiresIn, issuer: env.JWT_ISSUER || 'postit-backend', audience: env.JWT_AUDIENCE || 'postit-api' };
}
function signAccessToken(userId, env = process.env) {
  const config = jwtConfig(env);
  return jwt.sign({}, config.secret, { algorithm: 'HS256', subject: String(userId),
    expiresIn: config.expiresIn, issuer: config.issuer, audience: config.audience });
}
function verifyAccessToken(token, env = process.env) {
  const config = jwtConfig(env);
  const claims = jwt.verify(token, config.secret, { algorithms: ['HS256'], issuer: config.issuer, audience: config.audience });
  if (!claims || typeof claims !== 'object' || !/^[a-fA-F0-9]{24}$/.test(claims.sub || '') ||
      !Number.isFinite(claims.exp)) throw new jwt.JsonWebTokenError('Invalid access token claims');
  return claims;
}
module.exports = { jwtConfig, signAccessToken, verifyAccessToken, JwtConfigurationError };
