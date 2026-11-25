import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

export function createPaymentRouter(db, verifyToken, stripe) {
  const router = Router();
  const bookings = db.collection('bookings');
  const verifyCustomer = createVerifyRole(db, ['Customer']);


  router.post('/checkout', verifyToken, verifyCustomer, async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ message: 'Stripe key is not configured on the server' });
      }

      const bookingId = req.body?.bookingId;
      if (
        typeof bookingId !== 'string' ||
        !ObjectId.isValid(bookingId) ||
        new ObjectId(bookingId).toString() !== bookingId
      ) {
        return res.status(400).json({ message: 'Send a valid bookingId' });
      }


      const booking = await bookings.findOne({
        _id: new ObjectId(bookingId),
        customerId: req.dbUser._id.toString(),
      });

      if (!booking) {
        return res.status(404).json({ message: 'Your booking was not found' });
      }

      if (booking.paymentStatus !== 'Unpaid' || booking.bookingStatus !== 'Payment Pending') {
        return res.status(409).json({ message: 'This booking is not waiting for payment' });
      }

      if (!booking.expiresAt || booking.expiresAt <= new Date()) {
        return res.status(409).json({ message: 'This booking has expired. Please book again.' });
      }

      if (!Number.isFinite(booking.totalAmount) || booking.totalAmount <= 0) {
        return res.status(409).json({ message: 'The booking amount is not valid' });
      }
      if (booking.stripeSessionId) {
        const oldSession = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);

        if (oldSession.status === 'open' && oldSession.url) {
          return res.json({ checkoutUrl: oldSession.url });
        }

        if (oldSession.status === 'complete') {
          return res.status(409).json({ message: 'Payment is being confirmed' });
        }
      }

      const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000')
        .split(',')[0]
        .trim()
        .replace(/\/$/, '');
      const currency = (process.env.STRIPE_CURRENCY || 'bdt').toLowerCase();
      const amountInSmallestUnit = Math.round(booking.totalAmount * 100);
      const sessionExpiry = Math.floor(Date.now() / 1000) + 31 * 60;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency,
              unit_amount: amountInSmallestUnit,
              product_data: {
                name: booking.equipment.name,
                description: `Rental for ${booking.numberOfDays} day(s)`,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          bookingId: booking._id.toString(),
          customerId: booking.customerId,
        },
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/payment/cancel?bookingId=${booking._id.toString()}`,
        expires_at: sessionExpiry,
      });

      // Keep the booking reserved until this Checkout page expires.
      const updateResult = await bookings.updateOne(
        {
          _id: booking._id,
          customerId: booking.customerId,
          paymentStatus: 'Unpaid',
          bookingStatus: 'Payment Pending',
          expiresAt: { $gt: new Date() },
        },
        {
          $set: {
            stripeSessionId: session.id,
            expiresAt: new Date(session.expires_at * 1000),
            updatedAt: new Date(),
          },
        },
      );

      if (updateResult.matchedCount === 0) {
        try {
          await stripe.checkout.sessions.expire(session.id);
        } catch {
          // The session may already have expired or completed.
        }
        return res.status(409).json({ message: 'Booking changed. Please check your booking again.' });
      }

      res.json({ checkoutUrl: session.url });
    } catch (error) {
      console.error('Stripe checkout error:', error.message);
      res.status(500).json({ message: 'Could not start Stripe Checkout' });
    }
  });

  return router;
}
