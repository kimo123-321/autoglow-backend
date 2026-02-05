require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();

// --- 1. MIDDLEWARE ---
app.use(cors()); // Allows your Frontend (Vercel) to talk to this Backend (Render)
app.use(express.json()); // Allows the server to understand JSON data sent from React

// --- 2. DATABASE CONNECTION POOL ---
// We use a "Pool" instead of a single connection so the server doesn't crash if many people buy at once.
const db = mysql.createPool({
    host: process.env.DB_HOST,       // e.g., gateway01.us-west-2.prod.aws.tidbcloud.com
    user: process.env.DB_USER,       // e.g., 2a4...root
    password: process.env.DB_PASSWORD, // Your secret password from the .env file
    database: process.env.DB_NAME,   // e.g., autoglow_db
    port: process.env.DB_PORT || 4000,
    ssl: { rejectUnauthorized: true }, // REQUIRED for TiDB, Aiven, and most cloud databases
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Check connection on startup
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database Connection Failed:', err.code);
        console.error('Error Message:', err.message);
    } else {
        console.log('✅ Connected to MySQL Database Successfully!');
        connection.release(); // Release connection back to pool
    }
});

// --- 3. API ROUTES ---

// GET: Fetch all products (Used on the Home Page)
app.get('/api/products', (req, res) => {
    const sql = 'SELECT * FROM products ORDER BY id DESC';
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// POST: Place a New Order (Used on Checkout)
app.post('/api/orders', (req, res) => {
    // We expect the frontend to send: { customer: {...}, items: [...], total: 50.00, paymentMethod: 'COD' }
    const { customer, items, total, paymentMethod } = req.body;

    // VALIDATION: Basic check to ensure data exists
    if (!customer || !items || items.length === 0) {
        return res.status(400).json({ message: 'Missing order details' });
    }

    db.getConnection((err, connection) => {
        if (err) return res.status(500).json({ error: err.message });

        // START TRANSACTION (Ensures all steps succeed, or none do)
        connection.beginTransaction(err => {
            if (err) { connection.release(); return res.status(500).json({ error: err.message }); }

            // STEP A: Save or Update User
            const userSql = `
                INSERT INTO users (phone, name, city)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE name = VALUES(name), city = VALUES(city)
            `;

            connection.query(userSql, [customer.phone, customer.name, customer.address], (err) => {
                if (err) {
                    return connection.rollback(() => { connection.release(); res.status(500).json({ error: err.message }); });
                }

                // STEP B: Save the Order Summary
                const orderSql = 'INSERT INTO orders (user_phone, total_amount, status, payment_method, shipping_address) VALUES (?, ?, ?, ?, ?)';

                connection.query(orderSql, [customer.phone, total, 'Processing', paymentMethod, customer.address], (err, result) => {
                    if (err) {
                        return connection.rollback(() => { connection.release(); res.status(500).json({ error: err.message }); });
                    }

                    const orderId = result.insertId; // Get the ID of the order we just created

                    // STEP C: Save the Order Items
                    // We map the items array into a format MySQL accepts for bulk inserts
                    const orderItemsData = items.map(item => [orderId, item.name, item.price, 1]);
                    const itemsSql = 'INSERT INTO order_items (order_id, product_name, price, quantity) VALUES ?';

                    connection.query(itemsSql, [orderItemsData], (err) => {
                        if (err) {
                            return connection.rollback(() => { connection.release(); res.status(500).json({ error: err.message }); });
                        }

                        // STEP D: Commit (Save) Everything
                        connection.commit(err => {
                            if (err) {
                                return connection.rollback(() => { connection.release(); res.status(500).json({ error: err.message }); });
                            }
                            console.log(`💰 New Order #${orderId} from ${customer.name}`);
                            connection.release();
                            res.json({ message: 'Order placed successfully!', orderId: orderId });
                        });
                    });
                });
            });
        });
    });
});

// GET: Fetch User Profile & Orders (Used on Profile Page)
app.get('/api/user/:phone', (req, res) => {
    const phone = req.params.phone;

    // 1. Get User Details
    db.query('SELECT * FROM users WHERE phone = ?', [phone], (err, userResult) => {
        if (err) return res.status(500).json({ error: err.message });

        if (userResult.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        // 2. Get User's Orders
        db.query('SELECT * FROM orders WHERE user_phone = ? ORDER BY created_at DESC', [phone], (err, orderResult) => {
            if (err) return res.status(500).json({ error: err.message });

            // Send back both user info and their orders
            res.json({
                user: userResult[0],
                orders: orderResult
            });
        });
    });
});

// --- 4. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});