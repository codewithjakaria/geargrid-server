import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { toNodeHandler } from 'better-auth/node';
import { jwt } from 'better-auth/plugins';
import { createVerifyToken } from './middlewares/verifyToken.js';
import { createEquipmentRouter } from './routes/equipment.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { createProfileRouter } from './routes/profile.routes.js';

const app = express();
const port = process.env.PORT || 5000;

const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vj9qmzs.mongodb.net/`,
);

try {
  await client.connect();
  console.log('You successfully connected to MongoDB!');
} catch (error) {
  console.error('MongoDB connection failed:', error.message);
  process.exit(1);
}

const db = client.db('geargrid');
const clientOrigins = [
  'http://localhost:3000',
  ...(process.env.CLIENT_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const auth = betterAuth({
  database: mongodbAdapter(db, { client }),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: clientOrigins,
  emailAndPassword: { enabled: true, minPasswordLength: 6 },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'customer', input: false },
      phone: { type: 'string', required: false },
      address: { type: 'string', required: false },
    },
  },
  plugins: [
    jwt({
      jwt: {
        definePayload: ({ user }) => ({ email: user.email, role: user.role }),
      },
    }),
  ],
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || clientOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
  }),
);
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json());
const verifyToken = createVerifyToken(process.env.BETTER_AUTH_URL);

app.get('/api/me', verifyToken, (req, res) => {
  res.send({ success: true, user: req.user });
});

app.get('/', (req, res) => {
  res.send('GearGrid Server is Running');
});
app.use('/api/equipment', createEquipmentRouter(db, verifyToken));
app.use('/api/admin', createAdminRouter(db, verifyToken));
app.use('/api/profile', createProfileRouter(db, verifyToken));

app.listen(port, () => {
  console.log(`GearGrid Server app listening on port ${port}`);
});
