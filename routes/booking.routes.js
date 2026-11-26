import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function readDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return date;
}

function calculateRentalUnits(rentalType, numberOfDays) {
  if (rentalType === 'Weekly') return Math.ceil(numberOfDays / 7);
  if (rentalType === 'Monthly') return Math.ceil(numberOfDays / 30);
  return numberOfDays;
}

export function createBookingRouter(db, verifyToken) {
  const router = Router();
  const bookings = db.collection('bookings');
  const equipment = db.collection('equipment');
  const payments = db.collection('payments');

  const verifyCustomer = createVerifyRole(db, ['Customer']);
  const verifyOwner = createVerifyRole(db, ['Owner']);
  const verifyAdmin = createVerifyRole(db, ['Admin']);

  // Show an owner simple business totals for their dashboard.
  router.get('/owner-analytics', verifyToken, verifyOwner, async (req, res) => {
    try {
      const ownerId = req.dbUser._id.toString();
      const today = new Date();
      const currentYear = today.getUTCFullYear();
      const currentMonth = today.getUTCMonth();
      const firstMonth = new Date(Date.UTC(currentYear, currentMonth - 11, 1));
      const nextMonth = new Date(Date.UTC(currentYear, currentMonth + 1, 1));

      const [
        totalListedEquipment,
        completedRentals,
        paidPayments,
        recentPaidPayments,
      ] = await Promise.all([
        equipment.countDocuments({ 'owner.userId': ownerId }),
        bookings.countDocuments({ ownerId, bookingStatus: 'Completed' }),
        payments
          .aggregate([
            { $match: { ownerId, status: 'Paid' } },
            { $group: { _id: null, totalEarnings: { $sum: '$amount' } } },
          ])
          .toArray(),
        payments
          .find(
            {
              ownerId,
              status: 'Paid',
              paidAt: { $gte: firstMonth, $lt: nextMonth },
            },
            { projection: { paidAt: 1, amount: 1 } },
          )
          .toArray(),
      ]);

      // Add each payment amount to the month when the customer paid.
      const earningsByMonth = {};
      for (const payment of recentPaidPayments) {
        if (!(payment.paidAt instanceof Date)) continue;

        const month = payment.paidAt.toISOString().slice(0, 7);
        earningsByMonth[month] = (earningsByMonth[month] || 0) + payment.amount;
      }

      // Include all 12 months, even when the owner had no paid rentals.
      const monthlyEarnings = [];
      for (let monthNumber = 0; monthNumber < 12; monthNumber += 1) {
        const date = new Date(Date.UTC(currentYear, currentMonth - 11 + monthNumber, 1));
        const month = date.toISOString().slice(0, 7);

        monthlyEarnings.push({
          month,
          earnings: earningsByMonth[month] || 0,
        });
      }

      res.json({
        analytics: {
          totalListedEquipment,
          completedRentals,
          totalEarnings: paidPayments[0]?.totalEarnings || 0,
          monthlyEarnings,
        },
      });
    } catch (error) {
      console.error('Owner analytics error:', error.message);
      res.status(500).json({ message: 'Could not load owner analytics' });
    }
  });

  router.post('/', verifyToken, verifyCustomer, async (req, res) => {
    try {
      const equipmentId = req.body?.equipmentId;
      const startDate = readDate(req.body?.rentalStartDate);
      const endDate = readDate(req.body?.rentalEndDate);
      const quantity = Number(req.body?.requiredQuantity);
      const contactNumber = req.body?.contactNumber;
      const deliveryAddress = req.body?.deliveryAddress;
      const additionalNotes = req.body?.additionalNotes || '';

      if (!equipmentId || !ObjectId.isValid(equipmentId)) {
        return res.status(400).json({ message: 'Send a valid equipmentId' });
      }
      if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Dates must use YYYY-MM-DD format' });
      }

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      if (startDate < today) {
        return res.status(400).json({ message: 'Rental start date cannot be in the past' });
      }
      if (endDate < startDate) {
        return res.status(400).json({ message: 'End date must be on or after the start date' });
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ message: 'requiredQuantity must be at least 1' });
      }
      if (typeof contactNumber !== 'string' || contactNumber.trim().length < 5) {
        return res.status(400).json({ message: 'Enter a valid contact number' });
      }
      if (typeof deliveryAddress !== 'string' || deliveryAddress.trim().length < 5) {
        return res.status(400).json({ message: 'Enter a delivery address' });
      }
      if (typeof additionalNotes !== 'string') {
        return res.status(400).json({ message: 'additionalNotes must be text' });
      }

      const equipmentObjectId = new ObjectId(equipmentId);
      const item = await equipment.findOne({
        _id: equipmentObjectId,
        status: 'Approved',
      });

      if (!item) {
        return res.status(404).json({ message: 'Approved equipment was not found' });
      }
      if (!Number.isInteger(item.availableQuantity) || item.availableQuantity < 0) {
        return res.status(409).json({ message: 'Equipment availability is not set correctly' });
      }
      if (!Number.isFinite(item.rentalPrice) || item.rentalPrice <= 0) {
        return res.status(409).json({ message: 'Equipment price is not set correctly' });
      }
      if (!['Daily', 'Weekly', 'Monthly'].includes(item.rentalType)) {
        return res.status(409).json({ message: 'Equipment rental type is not set correctly' });
      }
      if (!item.owner || !item.owner.userId) {
        return res.status(409).json({ message: 'Equipment owner information is missing' });
      }
      const differenceInDays = Math.floor((endDate - startDate) / DAY_IN_MILLISECONDS);
      const numberOfDays = differenceInDays + 1;

      // Weekly rentals use groups of 7 days; monthly rentals use groups of 30 days.
      const rentalUnits = calculateRentalUnits(item.rentalType, numberOfDays);
      const totalAmount = item.rentalPrice * rentalUnits * quantity;

      const now = new Date();
      const activeBookings = await bookings
        .find({
          equipmentId: equipmentObjectId,
          rentalStartDate: { $lte: endDate },
          rentalEndDate: { $gte: startDate },
          $or: [
            { bookingStatus: { $in: ['Confirmed', 'Ongoing'] } },
            { bookingStatus: 'Payment Pending', expiresAt: { $gt: now } },
          ],
        })
        .toArray();

      // Check each rental day. This finds the busiest day, even when existing
      // bookings overlap only part of the requested date range.
      let alreadyBookedQuantity = 0;
      for (
        let dayTime = startDate.getTime();
        dayTime <= endDate.getTime();
        dayTime += DAY_IN_MILLISECONDS
      ) {
        const rentalDay = new Date(dayTime);
        let bookedOnThisDay = 0;

        for (const booking of activeBookings) {
          if (
            booking.rentalStartDate <= rentalDay &&
            booking.rentalEndDate >= rentalDay
          ) {
            bookedOnThisDay += booking.requiredQuantity;
          }
        }

        if (bookedOnThisDay > alreadyBookedQuantity) {
          alreadyBookedQuantity = bookedOnThisDay;
        }
      }

      const remainingQuantity = item.availableQuantity - alreadyBookedQuantity;
      if (quantity > remainingQuantity) {
        return res.status(409).json({
          message: 'Not enough equipment is available for these dates',
          availableQuantity: Math.max(remainingQuantity, 0),
        });
      }

      const booking = {
        customerId: req.dbUser._id.toString(),
        customer: {
          name: req.dbUser.name || '',
          email: req.dbUser.email,
        },
        ownerId: item.owner.userId,
        owner: item.owner,
        equipmentId: equipmentObjectId,
        equipment: {
          name: item.name,
          image: item.image,
          location: item.location,
          rentalPrice: item.rentalPrice,
          rentalType: item.rentalType,
        },
        rentalStartDate: startDate,
        rentalEndDate: endDate,
        numberOfDays,
        rentalUnits,
        requiredQuantity: quantity,
        contactNumber: contactNumber.trim(),
        deliveryAddress: deliveryAddress.trim(),
        additionalNotes: additionalNotes.trim(),
        totalAmount,
        paymentStatus: 'Unpaid',
        bookingStatus: 'Payment Pending',
        expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        createdAt: now,
      };

      const result = await bookings.insertOne(booking);

      res.status(201).json({
        message: 'Booking created. Continue to payment within 30 minutes.',
        booking: {
          id: result.insertedId.toString(),
          equipmentName: item.name,
          numberOfDays,
          rentalUnits,
          requiredQuantity: quantity,
          totalAmount,
          paymentStatus: booking.paymentStatus,
          bookingStatus: booking.bookingStatus,
        },
      });
    } catch (error) {
      console.error('Booking create error:', error.message);
      res.status(500).json({ message: 'Could not create this booking' });
    }
  });

  // A customer sees only their own rentals.
  router.get('/my-rentals', verifyToken, verifyCustomer, async (req, res) => {
    try {
      const result = await bookings
        .find({ customerId: req.dbUser._id.toString() })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ bookings: result });
    } catch (error) {
      console.error('Customer bookings error:', error.message);
      res.status(500).json({ message: 'Could not load your rentals' });
    }
  });

  // An owner sees rentals for their own equipment only.
  router.get('/owner-rentals', verifyToken, verifyOwner, async (req, res) => {
    try {
      const result = await bookings
        .find({ ownerId: req.dbUser._id.toString() })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ bookings: result });
    } catch (error) {
      console.error('Owner bookings error:', error.message);
      res.status(500).json({ message: 'Could not load your equipment rentals' });
    }
  });

  // An admin can monitor every booking on the platform.
  router.get('/admin/all', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const result = await bookings.find({}).sort({ createdAt: -1 }).toArray();
      res.json({ bookings: result });
    } catch (error) {
      console.error('Admin bookings error:', error.message);
      res.status(500).json({ message: 'Could not load bookings' });
    }
  });

  return router;
}
