import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

const RENTAL_TYPES = new Map([
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateEquipment(data = {}, { partial = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: { body: 'Request body must be a JSON object' } };
  }

  const updates = {};
  const errors = {};
  const has = (field) => Object.prototype.hasOwnProperty.call(data, field);
  const stringFields = [
    'name',
    'description',
    'category',
    'location',
    'condition',
    'brand',
    'model',
    'image',
    'terms',
  ];

  for (const field of stringFields) {
    if (!has(field) && partial) continue;
    const value = typeof data[field] === 'string' ? data[field].trim() : '';

    if (['name', 'description', 'category', 'location', 'image'].includes(field) && !value) {
      errors[field] = `${field} is required`;
      continue;
    }

    if (field === 'image' && value) {
      try {
        const imageUrl = new URL(value);
        if (!['http:', 'https:'].includes(imageUrl.protocol)) {
          errors.image = 'image must be an http or https URL';
          continue;
        }
      } catch {
        errors.image = 'image must be a valid URL';
        continue;
      }
    }

    if (value) {
      updates[field] = value;
    } else if (['condition', 'brand', 'model', 'terms'].includes(field)) {
      if (partial && has(field)) updates[field] = field === 'condition' ? 'Good' : '';
      else if (!partial) updates[field] = field === 'condition' ? 'Good' : '';
    }
  }

  if (has('rentalPrice') || !partial) {
    const price = Number(data.rentalPrice);
    if (!Number.isFinite(price) || price <= 0) {
      errors.rentalPrice = 'rentalPrice must be a number greater than 0';
    } else {
      updates.rentalPrice = price;
    }
  }

  if (has('availableQuantity') || !partial) {
    const quantity = Number(data.availableQuantity);
    const min = partial ? 0 : 1;
    if (!Number.isInteger(quantity) || quantity < min) {
      errors.availableQuantity = `availableQuantity must be an integer of at least ${min}`;
    } else {
      updates.availableQuantity = quantity;
    }
  }

  if (has('rentalType') || !partial) {
    const rentalType = RENTAL_TYPES.get(String(data.rentalType || '').toLowerCase());
    if (!rentalType) {
      errors.rentalType = 'rentalType must be Daily, Weekly, or Monthly';
    } else {
      updates.rentalType = rentalType;
    }
  }

  if (Object.keys(errors).length) return { errors };
  return { updates };
}

function validObjectId(id) {
  return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
}

export function createEquipmentRouter(db, verifyToken) {
  const router = Router();
  const equipment = db.collection('equipment');
  const verifyOwnerOrAdmin = createVerifyRole(db, ['Owner', 'Admin']);
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
        limit = '',
      } = req.query;
      const query = { status: 'Approved' };

      if (typeof search === 'string' && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), 'i');
        query.$or = [{ name: regex }, { location: regex }, { category: regex }];
      }

      if (typeof category === 'string' && category && category !== 'All') {
        query.category = category;
      }

      if (typeof rentalType === 'string' && rentalType && rentalType !== 'All') {
        const normalizedType = RENTAL_TYPES.get(rentalType.toLowerCase());
        if (!normalizedType) {
          return res.status(400).json({ message: 'Invalid rentalType filter' });
        }
        query.rentalType = normalizedType;
      }

      const priceRange = {};
      if (minPrice !== '') {
        const min = Number(minPrice);
        if (!Number.isFinite(min) || min < 0) {
          return res.status(400).json({ message: 'minPrice must be a non-negative number' });
        }
        priceRange.$gte = min;
      }
      if (maxPrice !== '') {
        const max = Number(maxPrice);
        if (!Number.isFinite(max) || max < 0) {
          return res.status(400).json({ message: 'maxPrice must be a non-negative number' });
        }
        priceRange.$lte = max;
      }
      if (
        priceRange.$gte !== undefined &&
        priceRange.$lte !== undefined &&
        priceRange.$gte > priceRange.$lte
      ) {
        return res.status(400).json({ message: 'minPrice cannot exceed maxPrice' });
      }
      if (Object.keys(priceRange).length) query.rentalPrice = priceRange;

      if (availability === 'available') query.availableQuantity = { $gt: 0 };
      else if (availability === 'unavailable') query.availableQuantity = { $lte: 0 };
      else if (availability !== '') {
        return res.status(400).json({ message: 'availability must be available or unavailable' });
      }

      const sortOptions = {
        newest: { createdAt: -1 },
        price_asc: { rentalPrice: 1, createdAt: -1 },
        price_desc: { rentalPrice: -1, createdAt: -1 },
      };
      if (typeof sort !== 'string' || !Object.hasOwn(sortOptions, sort)) {
        return res.status(400).json({ message: 'Invalid sort option' });
      }

      const cursor = equipment.find(query).sort(sortOptions[sort]);
      if (limit !== '') {
        const resultLimit = Number(limit);
        if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) {
          return res.status(400).json({ message: 'limit must be an integer between 1 and 100' });
        }
        cursor.limit(resultLimit);
      }
      const list = await cursor.toArray();
      res.json(list);
    } catch (err) {
      console.error('Equipment list error:', err.message);
      res.status(500).json({ message: 'Failed to load equipment' });
    }
  });

  router.get('/owner/mine', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    try {
      const isAdmin = req.dbUser.role?.toLowerCase() === 'admin';
      const query = isAdmin ? {} : { 'owner.userId': req.dbUser._id.toString() };
      const list = await equipment.find(query).sort({ createdAt: -1 }).toArray();
      res.json(list);
    } catch (err) {
      console.error('Owner equipment list error:', err.message);
      res.status(500).json({ message: 'Failed to load your equipment' });
    }
  });

  router.get('/admin/all', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { status = 'All', search = '' } = req.query;
      const query = {};

      if (status !== 'All') {
        if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
          return res.status(400).json({ message: 'Invalid equipment status filter' });
        }
        query.status = status;
      }

      if (typeof search === 'string' && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), 'i');
        query.$or = [
          { name: regex },
          { location: regex },
          { category: regex },
          { 'owner.name': regex },
          { 'owner.email': regex },
        ];
      }

      const list = await equipment.find(query).sort({ createdAt: -1 }).toArray();
      res.json(list);
    } catch (err) {
      console.error('Admin equipment list error:', err.message);
      res.status(500).json({ message: 'Failed to load equipment' });
    }
  });

  router.get('/:id', verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validObjectId(id)) return res.status(400).json({ message: 'Invalid ID' });

      const item = await equipment.findOne({ _id: new ObjectId(id) });
      if (!item) return res.status(404).json({ message: 'Equipment not found' });

      const isOwner = item.owner?.email === req.user.email;
      const isAdmin = req.user.role?.toLowerCase() === 'admin';
      if (item.status !== 'Approved' && !isOwner && !isAdmin) {
        return res.status(404).json({ message: 'Equipment not found' });
      }

      res.json(item);
    } catch (err) {
      console.error('Equipment details error:', err.message);
      res.status(500).json({ message: 'Failed to load item' });
    }
  });

  router.post('/', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    try {
      const { updates, errors } = validateEquipment(req.body);
      if (errors) return res.status(400).json({ message: 'Invalid equipment data', errors });

      const doc = {
        ...updates,
        status: 'Pending',
        owner: {
          userId: req.dbUser._id.toString(),
          name: req.dbUser.name,
          email: req.dbUser.email,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await equipment.insertOne(doc);
      res.status(201).json({ equipment: { ...doc, _id: result.insertedId } });
    } catch (err) {
      console.error('Equipment create error:', err.message);
      res.status(500).json({ message: 'Failed to create equipment' });
    }
  });

  router.patch('/status/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      if (!validObjectId(id)) return res.status(400).json({ message: 'Invalid ID' });
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

      res.json({ message: 'Equipment status updated', status });
    } catch (err) {
      console.error('Equipment status update error:', err.message);
      res.status(500).json({ message: 'Failed to update equipment status' });
    }
  });

  router.patch('/:id', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validObjectId(id)) return res.status(400).json({ message: 'Invalid ID' });

      const { updates, errors } = validateEquipment(req.body, { partial: true });
      if (errors) return res.status(400).json({ message: 'Invalid equipment data', errors });
      if (!Object.keys(updates).length) {
        return res.status(400).json({ message: 'At least one editable field is required' });
      }

      const filter = { _id: new ObjectId(id) };
      if (req.dbUser.role?.toLowerCase() !== 'admin') {
        filter['owner.userId'] = req.dbUser._id.toString();
      }

      const result = await equipment.updateOne(filter, {
        $set: { ...updates, updatedAt: new Date() },
      });
      if (result.matchedCount === 0) {
        return res.status(404).json({ message: 'Equipment not found' });
      }

      res.json({ message: 'Equipment updated successfully' });
    } catch (err) {
      console.error('Equipment update error:', err.message);
      res.status(500).json({ message: 'Failed to update equipment' });
    }
  });

  router.delete('/:id', verifyToken, verifyOwnerOrAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!validObjectId(id)) return res.status(400).json({ message: 'Invalid ID' });

      const filter = { _id: new ObjectId(id) };
      if (req.dbUser.role?.toLowerCase() !== 'admin') {
        filter['owner.userId'] = req.dbUser._id.toString();
      }

      const result = await equipment.deleteOne(filter);
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: 'Equipment not found' });
      }

      res.json({ message: 'Equipment deleted successfully' });
    } catch (err) {
      console.error('Equipment delete error:', err.message);
      res.status(500).json({ message: 'Failed to delete equipment' });
    }
  });

  return router;
}
