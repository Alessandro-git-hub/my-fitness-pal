const express = require('express');
const cors = require('cors');
const pool = require('./db');
const dotenv = require('dotenv');
const authRoutes = require('./routes/auth');
const app = express();

dotenv.config();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
    res.send('Server is running!');
  });

const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
