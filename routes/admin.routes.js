import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

const ROLES = new Map([
  ['customer', 'Customer'],
  ['owner', 'Owner'],
  ['admin', 'Admin'],
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isObjectId(value) {
  return ObjectId.isValid(value) && new ObjectId(value).toString() === value;
}

export function createAdminRouter(db, verifyToken) {
  const router = Router();
  const users = db.collection('user');
  const equipment = db.collection('equipment');
  const bookings = db.collection('bookings');
  const payments = db.collection('payments');
  const verifyAdmin = createVerifyRole(db, ['Admin']);

  // Admin dashboard numbers required by the assignment.
  router.get('/analytics', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const today = new Date();
      const currentYear = today.getUTCFullYear();
      const currentMonth = today.getUTCMonth();
      const firstMonth = new Date(Date.UTC(currentYear, currentMonth - 11, 1));
      const nextMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 1));

      const [
        totalUsers,
        totalEquipment,
        totalBookings,
        pendingApprovals,
        completedRentals,
        paidPayments,
        recentBookings,
      ] = await Promise.all([
        users.countDocuments({}),
        equipment.countDocuments({}),
        bookings.countDocuments({}),
        equipment.countDocuments({ status: 'Pending' }),
        bookings.countDocuments({ bookingStatus: 'Completed' }),
        payments
          .aggregate([
            { $match: { status: 'Paid' } },
            { $group: { _id: null, totalRevenue: { $sum: '$amount' } } },
          ])
          .toArray(),
        bookings
          .find(
            { createdAt: { $gte: firstMonth, $lt: nextMonth } },
            { projection: { createdAt: 1 } },
          )
          .toArray(),
      ]);

      // Count bookings by month so the dashboard can draw a simple chart.
      const bookingCountsByMonth = {};
      for (const booking of recentBookings) {
        if (!(booking.createdAt instanceof Date)) continue;

        const month = booking.createdAt.toISOString().slice(0, 7);
        bookingCountsByMonth[month] = (bookingCountsByMonth[month] || 0) + 1;
      }

      // Include all 12 months, even if there were no bookings in a month.
      const monthlyBookingStats = [];
      for (let monthNumber = 0; monthNumber < 12; monthNumber += 1) {
        const date = new Date(Date.UTC(currentYear, currentMonth - 11 + monthNumber, 1));
        const month = date.toISOString().slice(0, 7);

        monthlyBookingStats.push({
          month,
          bookings: bookingCountsByMonth[month] || 0,
        });
      }

      res.json({
        analytics: {
          totalUsers,
          totalEquipment,
          totalBookings,
          pendingApprovals,
          completedRentals,
          totalRevenue: paidPayments[0]?.totalRevenue || 0,
          monthlyBookingStats,
        },
      });
    } catch (error) {
      console.error('Admin analytics error:', error.message);
      res.status(500).json({ message: 'Could not load admin analytics' });
    }
  });

  router.get('/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const pageValue = Number(req.query.page ?? 1);
      const limitValue = Number(req.query.limit ?? 20);
      if (!Number.isInteger(pageValue) || pageValue < 1) {
        return res.status(400).json({ message: 'page must be a positive integer' });
      }
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) {
        return res.status(400).json({ message: 'limit must be between 1 and 100' });
      }

      const query = {};
      if (typeof req.query.search === 'string' && req.query.search.trim()) {
        const regex = new RegExp(escapeRegex(req.query.search.trim()), 'i');
        query.$or = [{ name: regex }, { email: regex }];
      }

      if (typeof req.query.role === 'string' && req.query.role && req.query.role !== 'All') {
        const role = ROLES.get(req.query.role.toLowerCase());
        if (!role) return res.status(400).json({ message: 'Invalid role filter' });
        query.role = new RegExp(`^${role}$`, 'i');
      }

      const [total, rows] = await Promise.all([
        users.countDocuments(query),
        users
          .find(query, {
            projection: { name: 1, email: 1, role: 1, image: 1, createdAt: 1 },
          })
          .sort({ createdAt: -1 })
          .skip((pageValue - 1) * limitValue)
          .limit(limitValue)
          .toArray(),
      ]);

      const result = rows.map((user) => ({
        id: user._id.toString(),
        name: user.name || '',
        email: user.email,
        role: ROLES.get(String(user.role || 'Customer').toLowerCase()) || 'Customer',
        image: user.image || '',
        createdAt: user.createdAt || null,
      }));

      res.json({
        users: result,
        pagination: {
          page: pageValue,
          limit: limitValue,
          total,
          totalPages: Math.ceil(total / limitValue),
        },
      });
    } catch (err) {
      console.error('Admin user list error:', err.message);
      res.status(500).json({ message: 'Failed to load users' });
    }
  });

  router.patch('/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (!isObjectId(id)) return res.status(400).json({ message: 'Invalid user ID' });

      const nextRole = ROLES.get(String(req.body?.role || '').toLowerCase());
      if (!nextRole) {
        return res.status(400).json({ message: 'role must be Customer, Owner, or Admin' });
      }

      const userFilter = { _id: new ObjectId(id) };
      const target = await users.findOne(userFilter, {
        projection: { name: 1, email: 1, role: 1 },
      });
      if (!target) return res.status(404).json({ message: 'User not found' });

      const currentRole = ROLES.get(String(target.role || 'Customer').toLowerCase()) || 'Customer';
      if (currentRole === 'Admin' && nextRole !== 'Admin') {
        const adminCount = await users.countDocuments({ role: /^admin$/i });
        if (adminCount <= 1) {
          return res.status(409).json({ message: 'The last admin cannot be demoted' });
        }
      }

      await users.updateOne(userFilter, {
        $set: { role: nextRole, updatedAt: new Date() },
      });

      res.json({
        message: 'User role updated',
        user: {
          id,
          name: target.name || '',
          email: target.email,
          role: nextRole,
        },
      });
    } catch (err) {
      console.error('Admin user role update error:', err.message);
      res.status(500).json({ message: 'Failed to update user role' });
    }
  });

  return router;
}
