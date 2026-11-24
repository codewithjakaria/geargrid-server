import { Router } from 'express';

export function createProfileRouter(db, verifyToken) {
  const router = Router();
  const users = db.collection('user');
  router.get('/', verifyToken, async (req, res) => {
    try {
      const profile = await users.findOne(
        { email: req.user.email },
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            phone: 1,
            address: 1,
            createdAt: 1,
          },
        },
      );

      if (!profile) {
        return res.status(404).json({ message: 'User profile was not found' });
      }

      res.json({
        profile: {
          id: profile._id.toString(),
          name: profile.name || '',
          email: profile.email,
          image: profile.image || '',
          role: profile.role || 'Customer',
          phone: profile.phone || '',
          address: profile.address || '',
          createdAt: profile.createdAt || null,
        },
      });
    } catch (error) {
      console.error('Profile load error:', error.message);
      res.status(500).json({ message: 'Could not load your profile' });
    }
  });

  // Only these four fields can be changed from the profile page.
  router.patch('/', verifyToken, async (req, res) => {
    try {
      const allowedFields = ['name', 'image', 'phone', 'address'];
      const updates = {};

      for (const field of allowedFields) {
        if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
          continue;
        }

        if (typeof req.body[field] !== 'string') {
          return res.status(400).json({ message: `${field} must be text` });
        }

        updates[field] = req.body[field].trim();
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: 'Send at least one profile field to update' });
      }

      if (updates.name !== undefined && updates.name.length === 0) {
        return res.status(400).json({ message: 'Name cannot be empty' });
      }

      if (updates.image) {
        let imageUrl;
        try {
          imageUrl = new URL(updates.image);
        } catch {
          return res.status(400).json({ message: 'Image must be a valid URL' });
        }

        if (!['http:', 'https:'].includes(imageUrl.protocol)) {
          return res.status(400).json({ message: 'Image URL must start with http or https' });
        }
      }

      updates.updatedAt = new Date();

      const result = await users.updateOne(
        { email: req.user.email },
        { $set: updates },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: 'User profile was not found' });
      }

      res.json({ message: 'Profile updated successfully' });
    } catch (error) {
      console.error('Profile update error:', error.message);
      res.status(500).json({ message: 'Could not update your profile' });
    }
  });

  return router;
}
