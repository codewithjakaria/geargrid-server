import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createVerifyToken(authURL) {
  const jwks = createRemoteJWKSet(new URL('/api/auth/jwks', authURL));

  return async function verifyToken(req, res, next) {
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;

    if (!token) {
      return res.status(401).send({ message: 'Unauthorized access' });
    }

    try {
      const { payload } = await jwtVerify(token, jwks);

      req.user = {
        email: payload.email,
        role: payload.role || 'customer',
      };
      next();
    } catch (error) {
      console.log('Token error:', error.message);
      res.status(401).send({ message: 'Invalid or expired token' });
    }
  };
}
