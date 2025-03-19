// db.js
const { Pool } = require('pg');

// Create a connection pool using DATABASE_URL from environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // For production environments (like Railway), you might need SSL:
  ssl: { rejectUnauthorized: false }
});

// Run schema creation queries
const createTables = async () => {
  try {
    // Create Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'valet'
      )
    `);

    // Create Locations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      )
    `);

    // Create ShiftReports table (using TIMESTAMP for shift_date)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_reports (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        shift_date TIMESTAMP NOT NULL,
        hours REAL NOT NULL,
        online_tips REAL NOT NULL DEFAULT 0,
        cash_tips REAL NOT NULL DEFAULT 0,
        cars INTEGER NOT NULL DEFAULT 0,
        location_id INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(location_id) REFERENCES locations(id)
      )
    `);

    // Create ShiftScreenshots table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_screenshots (
        id SERIAL PRIMARY KEY,
        shift_report_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        FOREIGN KEY(shift_report_id) REFERENCES shift_reports(id)
      )
    `);

    console.log("Tables created successfully.");
  } catch (err) {
    console.error("Error creating tables:", err);
  }
};

// Run the table creation when the module loads.
createTables();

module.exports = {
  query: (text, params, callback) => pool.query(text, params, callback),
  pool
};
