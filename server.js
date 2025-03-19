// server.js
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs'); // using bcryptjs
const dotenv = require('dotenv');
const path = require('path');
const db = require('./db'); // PostgreSQL-based db.js
const csvWriter = require('csv-writer').createObjectCsvWriter;

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

// Helper middleware for authentication
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('Access denied');
  }
  next();
}

// Ensure 'uploads' folder exists
const fs = require('fs');
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const multer = require('multer');
// Configure Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'shift-' + uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });
// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Home route
app.get('/', (req, res) => {
  res.render('index');
});

// Registration routes
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});
app.post('/register', async (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.render('register', { error: 'All fields are required' });
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  const queryText = 'INSERT INTO users (name, phone, password) VALUES ($1, $2, $3)';
  db.query(queryText, [name, phone, hashedPassword], (err, result) => {
    if (err) {
      if (err.message.includes('duplicate key value violates unique constraint')) {
        return res.render('register', { error: 'Phone number is already registered!' });
      } else {
        return res.render('register', { error: 'Registration error: ' + err.message });
      }
    }
    res.redirect('/login');
  });
});

// Login routes
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});
app.post('/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.render('login', { error: 'All fields are required' });
  }
  const queryText = 'SELECT * FROM users WHERE phone = $1';
  db.query(queryText, [phone], async (err, result) => {
    if (err || result.rowCount === 0) return res.render('login', { error: 'Invalid credentials' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.render('login', { error: 'Invalid credentials' });
    req.session.user = user;
    if (user.role === 'admin') {
      res.redirect('/admin');
    } else {
      res.redirect('/dashboard');
    }
  });
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ------------------------------
// VALET DASHBOARD WITH LOCATION SELECTION & SCREENSHOT UPLOAD
// ------------------------------
app.get('/dashboard', requireLogin, (req, res) => {
  db.query('SELECT * FROM locations', [], (err, result) => {
    if (err) {
      return res.render('dashboard', { error: 'Error loading locations: ' + err.message, message: null, locations: [] });
    }
    res.render('dashboard', { error: null, message: null, locations: result.rows });
  });
});
app.post('/dashboard', requireLogin, upload.array('screenshots', 5), (req, res) => {
  const { shift_date, hours, online_tips, cash_tips, location_id, cars } = req.body;
  if (!shift_date || !hours || online_tips === undefined || cash_tips === undefined || !location_id || cars === undefined) {
    return res.render('dashboard', { error: 'All fields are required', message: null, locations: [] });
  }
  const insertQuery = `
    INSERT INTO shift_reports (user_id, shift_date, hours, online_tips, cash_tips, location_id, cars)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `;
  db.query(insertQuery, [req.session.user.id, shift_date, hours, online_tips, cash_tips, location_id, cars], (err, result) => {
    if (err) {
      return res.render('dashboard', { error: 'Error saving report: ' + err.message, message: null, locations: [] });
    }
    const shiftReportId = result.rows[0].id;
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        db.query('INSERT INTO shift_screenshots (shift_report_id, file_path) VALUES ($1, $2)', [shiftReportId, file.filename], (err) => {
          if (err) console.error('Error inserting screenshot:', err);
        });
      });
    }
    db.query('SELECT * FROM locations', [], (err, result) => {
      if (err) {
        return res.render('dashboard', { error: 'Error loading locations: ' + err.message, message: null, locations: [] });
      }
      res.render('dashboard', { error: null, message: 'Shift report submitted successfully!', locations: result.rows });
    });
  });
});

// ------------------------------
// ADMIN PANEL - VIEW REPORTS
// ------------------------------
app.get('/admin', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY sr.shift_date DESC
  `;
  db.query(query, [], (err, result) => {
    if (err) return res.send('Error retrieving reports: ' + err.message);
    res.render('admin', { reports: result.rows });
  });
});

// ------------------------------
// EDIT SHIFT REPORT ROUTES
// ------------------------------
app.get('/admin/edit/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const query = `
    SELECT sr.*, u.name AS valet_name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    WHERE sr.id = $1
  `;
  db.query(query, [id], (err, result) => {
    if (err) return res.send('Error retrieving shift report: ' + err.message);
    if (result.rowCount === 0) return res.send('Shift report not found.');
    res.render('admin_edit', { report: result.rows[0] });
  });
});
app.post('/admin/edit/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { shift_date, hours, cars, online_tips, cash_tips } = req.body;
  const updateQuery = `
    UPDATE shift_reports
    SET shift_date = $1,
        hours = $2,
        cars = $3,
        online_tips = $4,
        cash_tips = $5
    WHERE id = $6
  `;
  db.query(updateQuery, [shift_date, hours, cars, online_tips, cash_tips, id], (err) => {
    if (err) return res.send('Error updating shift report: ' + err.message);
    res.redirect('/admin');
  });
});

// ------------------------------
// CSV EXPORT (ALL DATA) - BULK EXPORT
// ------------------------------
app.get('/admin/export', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY sr.shift_date DESC
  `;
  db.query(query, [], async (err, result) => {
    if (err) return res.send('Error retrieving reports: ' + err.message);
    let reports = result.rows.map(report => ({
      ...report,
      total: Number(report.online_tips) + Number(report.cash_tips)
    }));
    const csvPath = 'shift_reports.csv';
    const writer = csvWriter({
      path: csvPath,
      header: [
        { id: 'id', title: 'ID' },
        { id: 'name', title: 'Name' },
        { id: 'phone', title: 'Phone' },
        { id: 'shift_date', title: 'Shift Date' },
        { id: 'hours', title: 'Hours' },
        { id: 'cars', title: '# of Cars' },
        { id: 'online_tips', title: 'Online Payments' },
        { id: 'cash_tips', title: 'Cash Payments' },
        { id: 'total', title: 'Total' },
        { id: 'location_name', title: 'Location' }
      ]
    });
    await writer.writeRecords(reports);
    res.download(csvPath, 'shift_reports.csv');
  });
});

// ------------------------------
// ADMIN LOCATION MANAGEMENT
// ------------------------------
app.get('/admin/locations', requireAdmin, (req, res) => {
  db.query('SELECT * FROM locations', [], (err, result) => {
    if (err) return res.send('Error retrieving locations: ' + err.message);
    res.render('admin_locations', { locations: result.rows, error: null, message: null });
  });
});
app.post('/admin/locations', requireAdmin, (req, res) => {
  const { locationName } = req.body;
  if (!locationName) {
    return res.render('admin_locations', { locations: [], error: 'Location name is required', message: null });
  }
  db.query('INSERT INTO locations (name) VALUES ($1)', [locationName], (err) => {
    if (err) {
      return res.render('admin_locations', { locations: [], error: 'Error adding location: ' + err.message, message: null });
    }
    db.query('SELECT * FROM locations', [], (err, result) => {
      if (err) {
        return res.render('admin_locations', { locations: [], error: 'Error retrieving locations: ' + err.message, message: null });
      }
      res.render('admin_locations', { locations: result.rows, error: null, message: 'Location added successfully!' });
    });
  });
});

// ------------------------------
// DELETE SHIFT REPORT
// ------------------------------
app.post('/admin/delete/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM shift_reports WHERE id = $1', [id], (err) => {
    if (err) return res.send('Error deleting entry: ' + err.message);
    res.redirect('/admin');
  });
});

// ------------------------------
// ADMIN LEADERBOARD ROUTE (FILTER BY LOCATION)
// ------------------------------
app.get('/admin/leaderboard', requireAdmin, (req, res) => {
  const allowedSortColumns = ['total_hours', 'total_online', 'total_cash', 'total_tips'];
  let sort = req.query.sort || 'total_hours';
  let order = req.query.order || 'desc';
  if (!allowedSortColumns.includes(sort)) sort = 'total_hours';
  if (order !== 'asc' && order !== 'desc') order = 'desc';
  const locationFilter = req.query.location_id;
  let query = '';
  let params = [];
  if (locationFilter) {
    query = `
      SELECT u.id, u.name, u.phone,
        COALESCE(SUM(sr.hours), 0) AS total_hours,
        COALESCE(SUM(sr.online_tips), 0) AS total_online,
        COALESCE(SUM(sr.cash_tips), 0) AS total_cash,
        COALESCE(SUM(sr.online_tips) + SUM(sr.cash_tips), 0) AS total_tips
      FROM users u
      LEFT JOIN shift_reports sr ON sr.user_id = u.id AND sr.location_id = $1
      WHERE u.role = 'valet'
      GROUP BY u.id
      ORDER BY ${sort} ${order}
    `;
    params.push(locationFilter);
  } else {
    query = `
      SELECT u.id, u.name, u.phone,
        COALESCE(SUM(sr.hours), 0) AS total_hours,
        COALESCE(SUM(sr.online_tips), 0) AS total_online,
        COALESCE(SUM(sr.cash_tips), 0) AS total_cash,
        COALESCE(SUM(sr.online_tips) + SUM(sr.cash_tips), 0) AS total_tips
      FROM users u
      LEFT JOIN shift_reports sr ON sr.user_id = u.id
      WHERE u.role = 'valet'
      GROUP BY u.id
      ORDER BY ${sort} ${order}
    `;
  }
  db.query('SELECT * FROM locations', [], (err, result) => {
    if (err) return res.send('Error retrieving locations: ' + err.message);
    const locations = result.rows;
    db.query(query, params, (err, result) => {
      if (err) return res.send('Error retrieving leaderboard: ' + err.message);
      res.render('admin_leaderboard', { leaderboard: result.rows, sort, order, locations, selectedLocation: locationFilter });
    });
  });
});

// ------------------------------
// ADMIN CHARTS ROUTE
// ------------------------------
app.get('/admin/charts', requireAdmin, (req, res) => {
  const locationFilter = req.query.location_id || '';
  const attribute = req.query.attribute || 'hours';
  const allowedAttributes = ['hours', 'online_tips', 'cash_tips', 'total_tips'];
  if (!allowedAttributes.includes(attribute)) return res.send('Invalid attribute selected.');
  db.query('SELECT * FROM locations', [], (err, result) => {
    if (err) return res.send('Error retrieving locations: ' + err.message);
    const locations = result.rows;
    let query = '';
    let params = [];
    let columnSelect = (attribute === 'total_tips') 
      ? 'COALESCE(SUM(sr.online_tips) + SUM(sr.cash_tips), 0)' 
      : `COALESCE(SUM(sr.${attribute}), 0)`;
    if (locationFilter) {
      query = `
        SELECT sr.shift_date as date,
               ${columnSelect} as value
        FROM shift_reports sr
        WHERE sr.location_id = $1
        GROUP BY sr.shift_date
        ORDER BY sr.shift_date ASC
      `;
      params.push(locationFilter);
    } else {
      query = `
        SELECT sr.shift_date as date,
               ${columnSelect} as value
        FROM shift_reports sr
        GROUP BY sr.shift_date
        ORDER BY sr.shift_date ASC
      `;
    }
    db.query(query, params, (err, result) => {
      if (err) return res.send('Error retrieving chart data: ' + err.message);
      const labels = result.rows.map(r => r.date);
      const dataValues = result.rows.map(r => r.value);
      res.render('admin_charts', {
        locations,
        labels,
        dataValues,
        selectedLocation: locationFilter,
        selectedAttribute: attribute
      });
    });
  });
});

// ------------------------------
// ADVANCED ADMIN CHARTS ROUTE (COMPARE VALETS)
// ------------------------------
app.get('/admin/charts-compare', requireAdmin, (req, res) => {
  const locationFilter = req.query.location_id || '';
  const attribute = req.query.attribute || 'hours';
  const valetFilter = req.query.valet_id || 'all';
  const allowedAttributes = ['hours', 'online_tips', 'cash_tips', 'total_tips'];
  if (!allowedAttributes.includes(attribute)) return res.send('Invalid attribute selected.');
  db.query('SELECT * FROM locations', [], (err, result) => {
    if (err) return res.send('Error retrieving locations: ' + err.message);
    const locations = result.rows;
    db.query(`SELECT id, name FROM users WHERE role='valet'`, [], (err, result) => {
      if (err) return res.send('Error retrieving valets: ' + err.message);
      const valets = result.rows;
      let sumExpression = (attribute === 'total_tips') 
        ? 'COALESCE(SUM(sr.online_tips) + SUM(sr.cash_tips), 0) AS value' 
        : `COALESCE(SUM(sr.${attribute}), 0) AS value`;
      const whereClauses = [];
      const queryParams = [];
      if (locationFilter) {
        whereClauses.push('sr.location_id = $1');
        queryParams.push(locationFilter);
      }
      let groupBy = 'sr.shift_date';
      let selectUser = '';
      let joinUser = 'JOIN users u ON sr.user_id = u.id';
      if (valetFilter !== 'all') {
        whereClauses.push('sr.user_id = $' + (queryParams.length + 1));
        queryParams.push(valetFilter);
      } else {
        groupBy = 'sr.shift_date, sr.user_id';
        selectUser = ', u.id AS user_id, u.name AS user_name';
      }
      const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
      const query = `
        SELECT sr.shift_date AS date
        ${selectUser},
        ${sumExpression}
        FROM shift_reports sr
        ${joinUser}
        ${whereSql}
        GROUP BY ${groupBy}
        ORDER BY sr.shift_date ASC
      `;
      db.query(query, queryParams, (err, result) => {
        if (err) return res.send('Error retrieving chart data: ' + err.message);
        const uniqueDates = Array.from(new Set(result.rows.map(r => r.date))).sort();
        if (valetFilter !== 'all') {
          const dataMap = new Map();
          result.rows.forEach(r => dataMap.set(r.date, r.value));
          const dataValues = uniqueDates.map(d => dataMap.get(d) || 0);
          const datasets = [{ label: 'Valet Performance', data: dataValues }];
          return res.render('admin_charts_compare', { locations, valets, selectedLocation: locationFilter, selectedValet: valetFilter, selectedAttribute: attribute, labels: uniqueDates, datasets });
        } else {
          const userMap = new Map();
          result.rows.forEach(r => {
            const uid = r.user_id;
            if (!userMap.has(uid)) {
              userMap.set(uid, { userName: r.user_name, dataMap: new Map() });
            }
            userMap.get(uid).dataMap.set(r.date, r.value);
          });
          const datasets = [];
          for (let [uid, info] of userMap.entries()) {
            const dataArray = uniqueDates.map(d => info.dataMap.get(d) || 0);
            datasets.push({ label: info.userName, data: dataArray });
          }
          return res.render('admin_charts_compare', { locations, valets, selectedLocation: locationFilter, selectedValet: 'all', selectedAttribute: attribute, labels: uniqueDates, datasets });
        }
      });
    });
  });
});

// ------------------------------
// ADMIN SCREENSHOTS PAGE
// ------------------------------
app.get('/admin/screenshots', requireAdmin, (req, res) => {
  const locationFilter = req.query.location_id || '';
  db.query('SELECT * FROM locations', [], (err, result) => {
    if (err) return res.send('Error retrieving locations: ' + err.message);
    const locations = result.rows;
    let query = `
      SELECT sr.id AS shift_report_id,
             sr.shift_date,
             l.name AS location_name,
             u.name AS valet_name,
             sc.file_path
      FROM shift_reports sr
      JOIN users u ON sr.user_id = u.id
      LEFT JOIN locations l ON sr.location_id = l.id
      LEFT JOIN shift_screenshots sc ON sc.shift_report_id = sr.id
    `;
    const queryParams = [];
    if (locationFilter) {
      query += ' WHERE sr.location_id = $1';
      queryParams.push(locationFilter);
    }
    query += ' ORDER BY sr.shift_date DESC';
    db.query(query, queryParams, (err, result) => {
      if (err) return res.send('Error retrieving screenshots: ' + err.message);
      const reportMap = new Map();
      result.rows.forEach(r => {
        if (!reportMap.has(r.shift_report_id)) {
          reportMap.set(r.shift_report_id, {
            shift_report_id: r.shift_report_id,
            shift_date: r.shift_date,
            location_name: r.location_name,
            valet_name: r.valet_name,
            screenshots: []
          });
        }
        if (r.file_path) {
          reportMap.get(r.shift_report_id).screenshots.push(r.file_path);
        }
      });
      const reports = Array.from(reportMap.values());
      res.render('admin_screenshots', { locations, reports, selectedLocation: locationFilter });
    });
  });
});

// ------------------------------
// WEEKLY EXPORT ROUTE WITH 4:00 AM BOUNDARY PER LOCATION
// ------------------------------
app.get('/admin/export-weekly', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name AS valet_name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY l.id, sr.shift_date ASC
  `;
  db.query(query, [], (err, result) => {
    if (err) return res.send('Error retrieving reports: ' + err.message);
    const reports = result.rows;
    // Group by location first
    const locationMap = new Map();
    reports.forEach(r => {
      const loc = r.location_name || "Unspecified";
      if (!locationMap.has(loc)) {
        locationMap.set(loc, []);
      }
      locationMap.get(loc).push(r);
    });
    let csvLines = [];
    csvLines.push("ID,Valet Name,Phone,Shift Date,Hours,# of Cars,Online Tips,Cash Tips,Total,Location");
    for (const [locName, reportsForLoc] of locationMap.entries()) {
      csvLines.push(`Location: ${locName}`);
      const groupedByWeek = groupReportsByWeek(reportsForLoc);
      for (const [weekLabel, items] of groupedByWeek) {
        csvLines.push(`  Week: ${weekLabel}`);
        items.forEach(r => {
          const total = Number(r.online_tips) + Number(r.cash_tips);
          const line = [
            r.id,
            `"${r.valet_name}"`,
            r.phone,
            r.shift_date,
            r.hours,
            r.cars,
            r.online_tips,
            r.cash_tips,
            total,
            `"${r.location_name || ''}"`
          ].join(',');
          csvLines.push(line);
        });
        csvLines.push('');
      }
      csvLines.push('');
    }
    const csvContent = csvLines.join('\n');
    res.setHeader('Content-disposition', 'attachment; filename=weekly_shift_reports.csv');
    res.setHeader('Content-Type', 'text/csv');
    res.send(csvContent);
  });
});

// ------------------------------
// SPREADSHEETS PAGE
// ------------------------------
app.get('/admin/spreadsheets', requireAdmin, (req, res) => {
  res.render('admin_spreadsheets');
});

// ------------------------------
// TREVOR PORTAL - Manager Notebook Style
// Group shift reports by day (globally) then within each day by location.
// Sorted in descending order (most recent first) and displays date as "Month Day, Year - Weekday"
app.get('/admin/trevor', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name AS valet_name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY sr.shift_date DESC
  `;
  db.query(query, [], (err, result) => {
    if (err) return res.send('Error retrieving shift reports: ' + err.message);
    const reports = result.rows;
    // Group reports by day (using the date part of shift_date)
    const dayMap = new Map();
    reports.forEach(r => {
      let dayStr = r.shift_date;
      if (r.shift_date.includes('T')) {
        dayStr = r.shift_date.split('T')[0];
      }
      if (!dayMap.has(dayStr)) {
        dayMap.set(dayStr, []);
      }
      dayMap.get(dayStr).push(r);
    });
    // Transform into an array and sort days descending (most recent first)
    const daysData = [];
    for (let [day, shifts] of dayMap.entries()) {
      // Within each day, group by location
      const locationMap = new Map();
      shifts.forEach(r => {
        const loc = r.location_name || 'Unspecified';
        if (!locationMap.has(loc)) {
          locationMap.set(loc, []);
        }
        locationMap.get(loc).push(r);
      });
      const locationsArray = [];
      for (let [loc, shifts] of locationMap.entries()) {
        shifts.sort((a, b) => a.valet_name.localeCompare(b.valet_name));
        let totalHours = 0, totalCars = 0, totalOnline = 0, totalCash = 0;
        shifts.forEach(r => {
          totalHours += Number(r.hours) || 0;
          totalCars += Number(r.cars) || 0;
          totalOnline += Number(r.online_tips) || 0;
          totalCash += Number(r.cash_tips) || 0;
        });
        locationsArray.push({ location: loc, shifts, totalHours, totalCars, totalOnline, totalCash });
      }
      daysData.push({ day, locations: locationsArray });
    }
    // Sort daysData descending (most recent day first)
    daysData.sort((a, b) => new Date(b.day) - new Date(a.day));
    res.render('admin_trevor', { daysData });
  });
});

/* Helper functions for weekly export with 4:00 AM boundary */
function getValetWeekStart(dateTime) {
  const d = new Date(dateTime);
  const day = d.getDay();
  const hour = d.getHours();
  if (day === 1 && hour < 4) {
    d.setDate(d.getDate() - 1);
  }
  const day2 = d.getDay();
  let diff = day2 - 1;
  if (diff < 0) diff = 6;
  d.setDate(d.getDate() - diff);
  d.setHours(4, 0, 0, 0);
  return d;
}
function formatDate(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function groupReportsByWeek(reports) {
  const map = new Map();
  reports.forEach(r => {
    const weekStart = getValetWeekStart(r.shift_date);
    const sunday = new Date(weekStart);
    sunday.setDate(sunday.getDate() + 6);
    const label = `${formatDate(weekStart)} to ${formatDate(sunday)}`;
    if (!map.has(label)) {
      map.set(label, []);
    }
    map.get(label).push(r);
  });
  return map;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
