const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const moment = require('moment');
const nodemailer = require('nodemailer');
require('dotenv').config();
const twilio = require('twilio');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// MySQL Database Connection
const db = mysql.createPool({
    connectionLimit: 1000,
    host: process.env.HOST,
    user: process.env.USER,
    password: process.env.PASSWORD,
    database: process.env.DBNAME,
    connectTimeout: 300000, // Set a higher connection timeout (in milliseconds)
});



const accountSid = process.env.SID; // Replace with your Twilio Account SID
const authToken = process.env.AUTHTOKEN;   // Replace with your Twilio Auth Token
const client = twilio(accountSid, authToken);

db.on('connect', () => {
    console.log('Database connected successfully!');
});

// Handling connection error (e.g., connection lost)
db.on('error', (err) => {
    console.error('MySQL error:', err);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        console.log('Connection lost, reconnecting...');
        handleConnection(); // Retry the connection
    } else {
        console.error('Unexpected MySQL error:', err);
    }
});


const handleConnection = () => {
    db.getConnection((err, connection) => {
        if (err) {
            console.error('MySQL connection error:', err);
            if (err.code === 'PROTOCOL_CONNECTION_LOST') {
                console.log('Connection lost, attempting to reconnect...');
                setTimeout(handleConnection, 5000); // Retry after 5 seconds
            }
        } else {
            console.log('Database connected successfully');
            connection.release(); // Release the connection back to the pool
        }
    });
};


app.use(express.static(path.join(__dirname, 'public')));

// Default route to serve the index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

//registration and login

app.post('/api/admin/create', async (req, res) => {
    const { email, company_id, password } = req.body;

    // Input validation
    if (!email || !company_id || !password) {
        return res.status(400).json({ message: 'All fields are required.' });
    }

    try {
        // Check if the email is already registered
        db.query('SELECT * FROM Admin WHERE email = ?', [email], async (err, results) => {
            if (err) throw err;

            if (results.length > 0) {
                return res.status(400).json({ message: 'Email already exists.' });
            }

            // Hash the password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Insert new admin into the database
            db.query(
                'INSERT INTO Admin (email, company_id, password) VALUES (?, ?, ?)',
                [email, company_id, hashedPassword],
                (err, result) => {
                    if (err) throw err;

                    res.status(201).json({ message: 'Admin account created successfully.' });
                }
            );
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// Login Endpoint
app.post('/api/admin/login', (req, res) => {
    const { email, company_id, password } = req.body;
  
    // Input validation
    if (!email || !company_id || !password) {
      return res.status(400).json({ message: 'All fields are required.' });
    }
  
    try {
      // Check if admin exists in the database
      db.query(
        'SELECT * FROM Admin WHERE email = ? AND company_id = ?',
        [email, company_id],
        async (err, results) => {
          if (err) throw err;
  
          if (results.length === 0) {
            return res.status(401).json({ message: 'Invalid email, company ID, or password.' });
          }
  
          // Compare hashed password
          const admin = results[0];
          const isPasswordValid = await bcrypt.compare(password, admin.password);
  
          if (!isPasswordValid) {
            return res.status(401).json({ message: 'Invalid email, company ID, or password.' });
          }
  
          // Successful login
          res.status(200).json({ message: 'Login successful!' });
        }
      );
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Server error.' });
    }
  });


  // dashboard

  // Route to fetch product details with solved/unsolved counts
app.get('/api/products', (req, res) => {
    const query = `
      SELECT p.product_identifier, p.product_name, p.link, 
        SUM(CASE WHEN c.status = 'Resolved' THEN 1 ELSE 0 END) AS solved,
        SUM(CASE WHEN c.status IN ('In Progress', 'Pending') THEN 1 ELSE 0 END) AS not_solved
      FROM product_information p
      LEFT JOIN complaints c ON p.product_identifier = c.product_id
      GROUP BY p.product_identifier, p.product_name, p.link
    `;
    db.query(query, (err, results) => {
      if (err) {
        res.status(500).json({ error: 'Error fetching product data' });
      } else {
        res.json(results);
      }
    });
  });

  // API route to get complaint counts
app.get('/api/complaints-stats', (req, res) => {
    const query = `
      SELECT 
        COUNT(*) AS open_complaints,
        SUM(CASE WHEN status IN ('in progress', 'pending') THEN 1 ELSE 0 END) AS in_progress_complaints,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_complaints
      FROM complaints
    `;
    
    db.query(query, (err, result) => {
      if (err) {
        console.error('Error fetching complaints data:', err);
        res.status(500).json({ error: 'Internal Server Error' });
        return;
      }
      
      res.json(result[0]);
    });
  });

//product info

// Fetch product details from product_info table based on product_id
app.get('/api/product/:productId', (req, res) => {
    const productId = req.params.productId;

    db.query('SELECT * FROM product_information WHERE product_identifier = ?', [productId], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error fetching product details');
        }
        res.json(result[0]);
    });
});

// Fetch complaints statistics based on product_id and status
app.get('/api/complaints/:productId', (req, res) => {
    const productId = req.params.productId;

    db.query(
        `
      SELECT 
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS solved,
        SUM(CASE WHEN status IN ('in progress', 'pending') THEN 1 ELSE 0 END) AS not_solved,
        COUNT(*) AS total
      FROM complaints
      WHERE product_id = ?
      `,
        [productId],
        (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error fetching complaints statistics');
            }
            res.json(result[0]); // Send the first row of the result as JSON
        }
    );
});


// API Route to Get Complaints by Product ID
app.get('/api/get-complaints/:productId', (req, res) => {
    const productId = req.params.productId;

    const query = 'SELECT * FROM complaints WHERE product_id = ? order BY created_at DESC';
    db.query(query, [productId], (err, results) => {
        if (err) {
            console.error('Error fetching complaints:', err);
            return res.status(500).json({ error: 'Error fetching complaints' });
        }
        res.json(results); // Send the complaints as JSON response
    });
});

// followback

app.get('/api/complaint-details/:complaintId', (req, res) => {
    const complaintId = req.params.complaintId;

    // SQL query to fetch complaint details
    const complaintQuery = `
        SELECT * 
        FROM complaints
        WHERE id = ?
    `;

    // SQL query to fetch follow-ups sorted by followup_no
    const followupQuery = `
        SELECT * 
        FROM followbacks
        WHERE complaint_id = ?
        ORDER BY followback_number ASC
    `;

    // Execute queries
    db.query(complaintQuery, [complaintId], (err, complaintResults) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: 'Error fetching complaint details', error: err });
        }

        // Fetch follow-ups
        db.query(followupQuery, [complaintId], (err, followupResults) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: 'Error fetching follow-up details', error: err });
            }

            // Send both complaint and follow-up details
            res.status(200).json({
                complaint: complaintResults[0] || null,
                followups: followupResults || []
            });
        });
    });
});

app.post('/api/add-followback', (req, res) => {
    const {
        complaint_id,
        followback_number,
        description,
        followback_given_by,
        contact,
        remark,
        created_at
    } = req.body;

    // SQL query to insert the followback data into the followbacks table
    const sql = `INSERT INTO followbacks (complaint_id, followback_number, description, followback_given_by, contact, remark, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;

    const values = [complaint_id, followback_number, description, followback_given_by, contact, remark, created_at];

    // Execute the query
    db.query(sql, values, (err, result) => {
        if (err) {
            console.log(err);
            console.error('Error inserting data into followbacks table:', err);
            res.status(500).json({ error: 'Database error' });
            return;
        }

        // Send a success response
        res.status(200).json({ message: 'Followback added successfully', result });
    });
});

// Example route in your backend
app.post('/api/resolve-complaint', (req, res) => {
    const { complaint_id } = req.body;

    if (!complaint_id) {
        return res.status(400).json({ error: 'Complaint ID is required' });
    }

    const query = 'UPDATE complaints SET status = "Resolved" WHERE id = ?';

    db.query(query, [complaint_id], (err, results) => {
        if (err) {
            console.error('Error updating complaint status:', err);
            return res.status(500).json({ error: 'Error updating complaint status' });
        }

        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Complaint not found' });
        }

        res.json({ message: 'Complaint marked as resolved successfully' });
    });
});


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} `);
});