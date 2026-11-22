import express from 'express';
import cors from "cors";
const app = express();
const port = process.env.PORT||5000;
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
  res.send('GearGrid Server is Running');
});

app.listen(port, () => {
  console.log(`GearGrid Server app listening on port ${port}`);
});
