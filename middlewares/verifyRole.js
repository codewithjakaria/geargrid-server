import { ObjectId } from 'mongodb';

export function createVerifyRole(db, allowedRoles = []) {
  const roles = allowedRoles.map(r => r.toLowerCase());

  return async function (req, res, next) {
    try {
      const tokenUser = req.user || req.decoded;
      if (!tokenUser?.email && !tokenUser?.id) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const users = db.collection('user');
      const filter = tokenUser.email
        ? { email: tokenUser.email }
        : { _id: new ObjectId(tokenUser.id) };

      const user = await users.findOne(filter);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const currentRole = (user.role || 'Customer').toLowerCase();
      if (!roles.includes(currentRole)) {
        return res.status(403).json({ message: 'Forbidden access' });
      }

      req.dbUser = user;
      next();
    } catch (err) {
      res.status(500).json({ message: 'Role check failed' });
    }
  };
}
