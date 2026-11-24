import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

export function createEquipmentRouter(db, verifyToken) {
  const router = Router();
  const equipment = db.collection('equipment');

  const verifyOwner = createVerifyRole(db, ['Owner', 'Admin']);
  const verifyAdmin = createVerifyRole(db, ['Admin']);

  router.get('/', async (req, res) => {
    try {
      const {
        search = '',
        category = '',
        rentalType = '',
        minPrice = '',
        maxPrice = '',
        availability = '',
        sort = 'newest',
      } = req.query;
      const query = { status: 'Approved' };

      if (search.trim()) {
        const regex = new RegExp(search.trim(), 'i');
        query.$or = [{ name: regex }, { location: regex }, { category: regex }];
      }

      if (category && category !== 'All') {
        query.category = category;
      }

      if (rentalType && rentalType !== 'All') {
        query.rentalType = rentalType;
      }

      if (minPrice !== '' || maxPrice !== '') {
        query.rentalPrice = {};
        if (minPrice !== '') query.rentalPrice.$gte = Number(minPrice);
        if (maxPrice !== '') query.rentalPrice.$lte = Number(maxPrice);
      }

      if (availability === 'available') {
        query.availableQuantity = { $gt: 0 };
      }

      let sortBy = { createdAt: -1 };
      if (sort === 'price_asc') sortBy = { rentalPrice: 1 };
      if (sort === 'price_desc') sortBy = { rentalPrice: -1 };

      const list = await equipment.find(query).sort(sortBy).toArray();
      res.json(list);
    } catch (err) {
      res.status(500).json({ message: 'Failed to load equipment' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const item = await equipment.findOne({ _id: new ObjectId(id) });
      if (!item) {
        return res.status(404).json({ message: 'Equipment not found' });
      }

      res.json(item);
    } catch (err) {
      res.status(500).json({ message: 'Failed to load item' });
    }
  });

  router.post('/', verifyToken, verifyOwner, async (req, res) => {
    try {
      const data = req.body;
      const doc = {
        name: data.name,
        description: data.description,
        category: data.category,
        location: data.location,
        rentalPrice: Number(data.rentalPrice),
        rentalType: data.rentalType,
        availableQuantity: Number(data.availableQuantity),
        condition: data.condition || 'Good',
        brand: data.brand || '',
        model: data.model || '',
        image: data.image,
        terms: data.terms || '',
        status: 'Pending',
        owner: {
          userId: req.dbUser._id.toString(),
          name: req.dbUser.name,
          email: req.dbUser.email,
        },
        createdAt: new Date(),
      };

      const result = await equipment.insertOne(doc);
      res
        .status(201)
        .json({
          insertedId: result.insertedId,
          equipment: { ...doc, _id: result.insertedId },
        });
    } catch (err) {
      res.status(500).json({ message: 'Failed to create equipment' });
    }
  });

  router.patch('/status/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }

      const result = await equipment.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updatedAt: new Date() } },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: 'Equipment not found' });
      }

      res.json({ message: 'Status updated' });
    } catch (err) {
      res.status(500).json({ message: 'Failed to update status' });
    }
  });

  return router;
}
