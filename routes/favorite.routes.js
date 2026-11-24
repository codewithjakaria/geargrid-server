import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

export function createFavoriteRouter(db, verifyToken) {
  const router = Router();
  const favorites = db.collection('favorites');
  const equipment = db.collection('equipment');
  const verifyCustomer = createVerifyRole(db, ['Customer']);

  // Return saved equipment for the signed-in customer.
  router.get('/', verifyToken, verifyCustomer, async (req, res) => {
    try {
      const customerId = req.dbUser._id.toString();
      const savedItems = await favorites
        .find({ customerId })
        .sort({ createdAt: -1 })
        .toArray();

      const result = [];
      for (const savedItem of savedItems) {
        const item = await equipment.findOne({
          _id: savedItem.equipmentId,
          status: 'Approved',
        });

        if (item) {
          result.push({
            favoriteId: savedItem._id.toString(),
            createdAt: savedItem.createdAt,
            equipment: item,
          });
        }
      }

      res.json({ favorites: result });
    } catch (error) {
      console.error('Favorites load error:', error.message);
      res.status(500).json({ message: 'Could not load your favorites' });
    }
  });

  // Save an approved equipment item once per customer.
  router.post('/', verifyToken, verifyCustomer, async (req, res) => {
    try {
      const equipmentId = req.body?.equipmentId;

      if (!equipmentId || !ObjectId.isValid(equipmentId)) {
        return res.status(400).json({ message: 'Send a valid equipmentId' });
      }

      const equipmentObjectId = new ObjectId(equipmentId);
      const item = await equipment.findOne({
        _id: equipmentObjectId,
        status: 'Approved',
      });

      if (!item) {
        return res.status(404).json({ message: 'Approved equipment was not found' });
      }

      const customerId = req.dbUser._id.toString();
      const existingFavorite = await favorites.findOne({
        customerId,
        equipmentId: equipmentObjectId,
      });

      if (existingFavorite) {
        return res.json({ message: 'Equipment is already in your favorites' });
      }

      await favorites.insertOne({
        customerId,
        equipmentId: equipmentObjectId,
        createdAt: new Date(),
      });

      res.status(201).json({ message: 'Equipment added to favorites' });
    } catch (error) {
      console.error('Favorite save error:', error.message);
      res.status(500).json({ message: 'Could not save this favorite' });
    }
  });

  // Remove one saved equipment item.
  router.delete('/:equipmentId', verifyToken, verifyCustomer, async (req, res) => {
    try {
      const { equipmentId } = req.params;

      if (!ObjectId.isValid(equipmentId)) {
        return res.status(400).json({ message: 'Invalid equipment ID' });
      }

      const result = await favorites.deleteOne({
        customerId: req.dbUser._id.toString(),
        equipmentId: new ObjectId(equipmentId),
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ message: 'Favorite was not found' });
      }

      res.json({ message: 'Equipment removed from favorites' });
    } catch (error) {
      console.error('Favorite remove error:', error.message);
      res.status(500).json({ message: 'Could not remove this favorite' });
    }
  });

  return router;
}
