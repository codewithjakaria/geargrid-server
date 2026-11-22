import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { toNodeHandler } from 'better-auth/node';

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

const auth = betterAuth({
  database: mongodbAdapter(db, { client }),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: ['http://localhost:3000'],
  emailAndPassword: { enabled: true, minPasswordLength: 6 },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'customer', input: false },
      phone: { type: 'string', required: false },
      address: { type: 'string', required: false },
    },
  },
});

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.all('/api/auth/*splat', toNodeHandler(auth)); // express.json() এর আগে
app.use(express.json());

app.get('/', (req, res) => {
  res.send('GearGrid Server is Running');
});

app.listen(port, () => {
  console.log(`GearGrid Server app listening on port ${port}`);
});
