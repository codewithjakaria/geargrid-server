import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { createVerifyRole } from '../middlewares/verifyRole.js';

export function createPaymentRouter(db, verifyToken, stripe) {
  const router = Router();
  const bookings = db.collection('bookings');
  const payments = db.collection('payments');
  const verifyCustomer = createVerifyRole(db, ['Customer']);

  // Stripe sends the customer here after a successful checkout.
  router.get('/confirm', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ message: 'Stripe key is not configured on the server' });
    }

    try {
      const sessionId = req.query.session_id;
      if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
        return res.status(400).json({ message: 'A valid Stripe session_id is required' });
      }

      // Ask Stripe directly whether this session was paid. Do not trust the browser alone.
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') {
        return res.status(409).json({ message: 'Stripe has not marked this payment as paid' });
      }

      const bookingId = session.metadata?.bookingId;
      const customerId = session.metadata?.customerId;
      if (
        typeof bookingId !== 'string' ||
        !ObjectId.isValid(bookingId) ||
        new ObjectId(bookingId).toString() !== bookingId ||
        typeof customerId !== 'string'
      ) {
        return res.status(400).json({ message: 'Stripe session is missing booking information' });
      }

      const booking = await bookings.findOne({
        _id: new ObjectId(bookingId),
        customerId,
        stripeSessionId: session.id,
      });

      if (!booking) {
        return res.status(404).json({ message: 'The booking for this payment was not found' });
      }

      const currency = (process.env.STRIPE_CURRENCY || 'bdt').toLowerCase();
      const expectedAmount = Math.round(booking.totalAmount * 100);
      if (session.currency !== currency || session.amount_total !== expectedAmount) {
        return res.status(409).json({ message: 'Payment amount does not match the booking' });
      }

      const now = new Date();
      const paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id || '';

      // Store one payment record for this Checkout session, even if the page is refreshed.
      await payments.updateOne(
        { stripeSessionId: session.id },
        {
          $setOnInsert: {
            bookingId: booking._id,
            customerId: booking.customerId,
            ownerId: booking.ownerId,
            equipmentId: booking.equipmentId,
            stripeSessionId: session.id,
            stripePaymentIntentId: paymentIntentId,
            amount: session.amount_total / 100,
            currency: session.currency,
            status: 'Paid',
            paidAt: now,
            createdAt: now,
          },
        },
        { upsert: true },
      );

      const updateResult = await bookings.updateOne(
        {
          _id: booking._id,
          customerId: booking.customerId,
          stripeSessionId: session.id,
          paymentStatus: 'Unpaid',
          bookingStatus: 'Payment Pending',
        },
        {
          $set: {
            paymentStatus: 'Paid',
            bookingStatus: 'Confirmed',
            stripePaymentIntentId: paymentIntentId,
            paidAt: now,
            updatedAt: now,
          },
        },
      );

      if (updateResult.matchedCount === 0) {
        const alreadyConfirmed = await bookings.findOne({
          _id: booking._id,
          paymentStatus: 'Paid',
          bookingStatus: 'Confirmed',
        });

        if (!alreadyConfirmed) {
          return res.status(409).json({ message: 'The booking could not be confirmed' });
        }
      }

      const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000')
        .split(',')[0]
        .trim()
        .replace(/\/$/, '');
      return res.redirect(`${clientUrl}/payment/success?bookingId=${bookingId}`);
    } catch (error) {
      console.error('Stripe payment confirmation error:', error.message);
      return res.status(500).json({ message: 'Could not confirm this Stripe payment' });
    }
  });


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
      const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000')
        .split(',')[0]
        .trim()
        .replace(/\/$/, '');
      const serverUrl = (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 5000}`)
        .trim()
        .replace(/\/$/, '');
      const successUrl = `${serverUrl}/api/payments/confirm?session_id={CHECKOUT_SESSION_ID}`;
      const currency = (process.env.STRIPE_CURRENCY || 'bdt').toLowerCase();
      const amountInSmallestUnit = Math.round(booking.totalAmount * 100);
      const sessionExpiry = Math.floor(Date.now() / 1000) + 31 * 60;

      if (booking.stripeSessionId) {
        const oldSession = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);

        if (oldSession.status === 'open' && oldSession.url) {
          if (oldSession.success_url === successUrl) {
            return res.json({ checkoutUrl: oldSession.url });
          }

          // Replace an older checkout link that still points to the previous success URL.
          await stripe.checkout.sessions.expire(oldSession.id);
        }

        if (oldSession.status === 'complete') {
          return res.status(409).json({ message: 'Payment is being confirmed' });
        }
      }

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
        success_url: successUrl,
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
