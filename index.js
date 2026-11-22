import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import 'dotenv/config';
const app = express();
const port = process.env.PORT || 5000;
app.use(express.json());
app.use(cors());
const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vj9qmzs.mongodb.net/`,
);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.dir(err);
  }
}

await connectToMongoDB();
// console.log(gearGridServerConnect);
app.get('/', (req, res) => {
  res.send('GearGrid Server is Running');
});

app.listen(port, () => {
  console.log(`GearGrid Server app listening on port ${port}`);
});
