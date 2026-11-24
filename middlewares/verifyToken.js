import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createVerifyToken(authURL) {
  const jwksUrl = new URL('/api/auth/jwks', authURL);
  const jwks = createRemoteJWKSet(jwksUrl);

  return async function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Please send a Bearer token' });
    }

    const token = authHeader.slice(7);

    try {
      const { payload } = await jwtVerify(token, jwks);

      if (!payload.email) {
        return res.status(401).json({ message: 'Token does not include a user email' });
      }

      req.user = {
        email: payload.email,
        role: payload.role || 'customer',
      };
      next();
    } catch (error) {
      console.error('Token check error:', error.message);
      res.status(401).json({ message: 'Token is invalid or expired' });
    }
  };
}
