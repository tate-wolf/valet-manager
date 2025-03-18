// db.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./valet.db');

db.serialize(() => {
  // Create Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'valet'
    )
  `);

  // Create Locations table
  db.run(`
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )
  `);

  // Create ShiftReports table with separate tip columns for online and cash payments
  db.run(`
    CREATE TABLE IF NOT EXISTS shift_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      shift_date TEXT NOT NULL,
      hours REAL NOT NULL,
      online_tips REAL NOT NULL DEFAULT 0,
      cash_tips REAL NOT NULL DEFAULT 0,
      cars INTEGER NOT NULL DEFAULT 0,   -- NEW COLUMN for # of Cars
      location_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(location_id) REFERENCES locations(id)
    )
  `);
  

  // Create ShiftScreenshots table (only once)
  db.run(`
    CREATE TABLE IF NOT EXISTS shift_screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_report_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      FOREIGN KEY(shift_report_id) REFERENCES shift_reports(id)
    )
  `);
});

module.exports = db;
