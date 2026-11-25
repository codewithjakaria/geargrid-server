import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function readDate(value) {
  // The API accepts dates in YYYY-MM-DD format.
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

  const verifyCustomer = createVerifyRole(db, ['Customer']);
  const verifyOwner = createVerifyRole(db, ['Owner']);
  const verifyAdmin = createVerifyRole(db, ['Admin']);

  // Customer sends a booking request after selecting equipment and dates.
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

      // End date is treated as the last rental day, so add one to the difference.
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
