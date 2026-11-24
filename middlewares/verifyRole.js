export function createVerifyRole(db, allowedRoles = []) {
  return async function verifyRole(req, res, next) {
    try {
      // verifyToken runs first and adds the signed-in user's email to req.user.
      if (!req.user || !req.user.email) {
        return res.status(401).json({ message: 'Please sign in first' });
      }

      const users = db.collection('user');
      const user = await users.findOne({ email: req.user.email });

      if (!user) {
        return res.status(404).json({ message: 'User was not found' });
      }

      // Read the role from MongoDB so a changed role takes effect right away.
      const userRole = (user.role || 'Customer').toLowerCase();
      let roleIsAllowed = false;

      for (const role of allowedRoles) {
        if (role.toLowerCase() === userRole) {
          roleIsAllowed = true;
          break;
        }
      }

      if (!roleIsAllowed) {
        return res.status(403).json({ message: 'You do not have permission for this action' });
      }

      // Save the full database user for routes that need their id or name.
      req.dbUser = user;
      next();
    } catch (error) {
      console.error('Role check error:', error.message);
      res.status(500).json({ message: 'Could not check your role' });
    }
  };
}
