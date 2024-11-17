const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const axios = require('axios');
const dotenv = require('dotenv');
const authenticateToken = require('../middleware/authMiddleware');

dotenv.config();
const JWT_SECRET = process.env.JWT_SECRET;
const SPOONACULAR_API_KEY = process.env.SPOONACULAR_API_KEY;

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING *',
      [name, email, hashedPassword]
    );

    res.status(201).json({
      id: newUser.rows[0].id,
      name: newUser.rows[0].name,
      email: newUser.rows[0].email,
      created_at: newUser.rows[0].created_at,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            return res.status(400).json({error: 'Invalid email or password'});
        }

        const isMatch = await bcrypt.compare(password, user.rows[0].password);
        if (!isMatch) {
            return res.status(400).json({error: 'Invalid email or password'});
        }

        // Generate a JWT token
        const token = jwt.sign({ userId: user.rows[0].id }, JWT_SECRET, { expiresIn: '1h' });

        res.json({
            token,
            user: {
            id: user.rows[0].id,
            name: user.rows[0].name,
            email: user.rows[0].email,
            },
        })
    } catch (error) {
        res.status(500).json({ error: error.message });
      }
});

router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const user = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.user.userId]);
        res.json(user.rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/search', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Query must be provided' });
  }

  try {
    const response = await axios.get(
      `https://api.spoonacular.com/food/products/search`,
      {
        params: {
          apiKey: SPOONACULAR_API_KEY,
          query: query,
          number: 100,
        },
      }
    );

    const results = response.data.products.map((item) => ({
      id: item.id,
      title: item.title,
      image: item.image,
    }));

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/add-food', authenticateToken, async (req, res) => {
  const { food_name, serving_size, calories, protein, carbs, fat } = req.body;

  if (!food_name || !serving_size || !calories) {
    return res.status(400).json({ error: 'Food name, serving size, and calories are required' });
  }

  try {
    const newFood = await pool.query(
      `INSERT INTO foods (food_name, serving_size, calories, protein, carbs, fat, is_custom)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [food_name, serving_size, calories, protein || 0, carbs || 0, fat || 0, true]
    );

    res.status(201).json(newFood.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/log-food', authenticateToken, async (req, res) => {
  const { food_id, meal_type, quantity } = req.body;

  if (!food_id || !meal_type || !quantity) {
    return res.status(400).json({ error: 'Food ID, meal type, and quantity are required' });
  }

  const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
  const type = validMealTypes.includes(meal_type.toLowerCase()) ? meal_type.toLowerCase() : 'snack';

  try {
    const food = await pool.query(`SELECT food_name FROM foods WHERE id = $1`, [food_id]);
    if (food.rows.length === 0) {
      return res.status(404).json({ error: 'Food not found' });
    }

    const foodName = food.rows[0].food_name;

    const newLog = await pool.query(
      `INSERT INTO daily_food_logs (user_id, food_id, food_name, meal_type, quantity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.userId, food_id, foodName, type, quantity]
    );

    res.status(201).json(newLog.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/daily-summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const totalSummary = await pool.query(
      `SELECT 
         COALESCE(SUM(f.calories * dfl.quantity), 0) AS total_calories,
         COALESCE(SUM(f.protein * dfl.quantity), 0) AS total_protein,
         COALESCE(SUM(f.carbs * dfl.quantity), 0) AS total_carbs,
         COALESCE(SUM(f.fat * dfl.quantity), 0) AS total_fat
       FROM daily_food_logs dfl
       JOIN foods f ON dfl.food_id = f.id
       WHERE dfl.user_id = $1 AND dfl.logged_at::date = CURRENT_DATE`,
      [userId]
    );

    const mealSummary = await pool.query(
      `SELECT 
         dfl.meal_type,
         COALESCE(SUM(f.calories * dfl.quantity), 0) AS total_calories,
         COALESCE(SUM(f.protein * dfl.quantity), 0) AS total_protein,
         COALESCE(SUM(f.carbs * dfl.quantity), 0) AS total_carbs,
         COALESCE(SUM(f.fat * dfl.quantity), 0) AS total_fat
       FROM daily_food_logs dfl
       JOIN foods f ON dfl.food_id = f.id
       WHERE dfl.user_id = $1 AND dfl.logged_at::date = CURRENT_DATE
       GROUP BY dfl.meal_type`,
      [userId]
    );

    const total = totalSummary.rows[0];
    const meals = mealSummary.rows;

    res.json({
      date: new Date().toISOString().split('T')[0],
      total,
      meals,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});



module.exports = router;
