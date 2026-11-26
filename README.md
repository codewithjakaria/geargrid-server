# GearGrid Server

GearGrid is an equipment rental platform. This repository contains the server API used by equipment owners, customers, and administrators.

## Live URL

- Client website: Add the deployed client URL before submitting the assignment.
- Server API: Add the deployed server URL before submitting the assignment.
- Local API: `http://localhost:5000`

## Main Features

- Email and password sign-up and sign-in, JWT access tokens, and Google sign-in configuration.
- Customer, Owner, and Admin role checks for protected API routes.
- Equipment listing, search, filters, sorting, owner management, and admin approval.
- Rental booking creation with date availability checks and rental price calculation.
- Customer favorites and profile management.
- Stripe Checkout payment confirmation and transaction records.
- Admin and Owner dashboard analytics.
- Admin booking status management.

## Technologies and Packages

- Node.js and Express
- MongoDB
- Better Auth and its MongoDB adapter
- Stripe
- `express`, `mongodb`, `better-auth`, `@better-auth/mongo-adapter`, `cors`, `dotenv`, `stripe`

## Run Locally

1. Install the packages with `npm install`.
2. Add the environment variables listed below to a `.env` file.
3. Start the server with `node index.js`.
4. The server runs at `http://localhost:5000` unless `PORT` is set.

## Environment Variables

Keep secret values in `.env`; do not commit that file.

```env
PORT=5000
DB_USER=your_mongodb_username
DB_PASS=your_mongodb_password
BETTER_AUTH_URL=http://localhost:5000
BETTER_AUTH_SECRET=your_long_random_secret
CLIENT_URL=http://localhost:3000
SERVER_URL=http://localhost:5000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
STRIPE_SECRET_KEY=sk_test_your_key
STRIPE_CURRENCY=bdt
```

Google sign-in is available when both Google values are configured. Stripe payment requires a test or live secret key that matches the environment.
