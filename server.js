// server.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs'); // using bcryptjs
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const csvWriter = require('csv-writer').createObjectCsvWriter;

// Your Postgres wrapper (pool + query helper)
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------
   Core Middleware
--------------------------------*/
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure 'uploads' folder exists & serve uploaded images
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

/* ------------------------------
   Sessions (Production-ready)
--------------------------------*/
// If behind a proxy (Railway/Heroku/etc.), trust it so secure cookies work
app.set('trust proxy', 1);

// Configure session store in Postgres (no MemoryStore in prod)
const sessionStore = new pgSession({
  // Use connection string directly to avoid requiring db.pool export shapes
  conObject: {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  },
  tableName: 'session'
});

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'change_this_secret_in_env',
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // only over HTTPS in prod
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
  })
);

/* ------------------------------
   View Engine
--------------------------------*/
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

/* ------------------------------
   Auth Helpers
--------------------------------*/
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

/* ------------------------------
   Multer (File Uploads)
--------------------------------*/
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'shift-' + uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

/* ------------------------------
   Routes
--------------------------------*/

// Home
app.get('/', (req, res) => {
  res.render('index');
});

// Register
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});
app.post('/register', async (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.render('register', { error: 'All fields are required' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const queryText = `
      INSERT INTO users (name, phone, password)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    await db.query(queryText, [name, phone, hashedPassword]);
    res.redirect('/login');
  } catch (err) {
    if (
      (err.code === '23505') || // unique_violation
      (err.message && err.message.includes('duplicate key value'))
    ) {
      return res.render('register', { error: 'Phone number is already registered!' });
    }
    return res.render('register', { error: 'Registration error: ' + err.message });
  }
});

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});
app.post('/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.render('login', { error: 'All fields are required' });
  }
  const queryText = 'SELECT * FROM users WHERE phone = $1';
  db.query(queryText, [phone])
    .then(async (result) => {
      if (result.rowCount === 0) return res.render('login', { error: 'Invalid credentials' });
      const user = result.rows[0];
      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.render('login', { error: 'Invalid credentials' });
      req.session.user = user;
      if (user.role === 'admin') res.redirect('/admin');
      else res.redirect('/dashboard');
    })
    .catch(() => res.render('login', { error: 'Invalid credentials' }));
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ------------------------------
   Dashboard (valet)
--------------------------------*/
app.get('/dashboard', requireLogin, (req, res) => {
  db.query('SELECT * FROM locations')
    .then((r) => res.render('dashboard', { error: null, message: null, locations: r.rows }))
    .catch((err) =>
      res.render('dashboard', { error: 'Error loading locations: ' + err.message, message: null, locations: [] })
    );
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
  db.query(insertQuery, [req.session.user.id, shift_date, hours, online_tips, cash_tips, location_id, cars])
    .then((result) => {
      const shiftReportId = result.rows[0].id;
      if (req.files && req.files.length > 0) {
        const promises = req.files.map((file) =>
          db.query('INSERT INTO shift_screenshots (shift_report_id, file_path) VALUES ($1, $2)', [
            shiftReportId,
            file.filename
          ])
        );
        return Promise.all(promises);
      }
    })
    .then(() => db.query('SELECT * FROM locations'))
    .then((r) => res.render('dashboard', { error: null, message: 'Shift report submitted successfully!', locations: r.rows }))
    .catch((err) =>
      res.render('dashboard', { error: 'Error saving report: ' + err.message, message: null, locations: [] })
    );
});

/* ------------------------------
   Admin: Reports
--------------------------------*/
app.get('/admin', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY sr.shift_date DESC
  `;
  db.query(query)
    .then((r) => res.render('admin', { reports: r.rows }))
    .catch((err) => res.send('Error retrieving reports: ' + err.message));
});

/* ------------------------------
   Admin: Edit Shift
--------------------------------*/
app.get('/admin/edit/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const query = `
    SELECT sr.*, u.name AS valet_name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    WHERE sr.id = $1
  `;
  db.query(query, [id])
    .then((r) => {
      if (r.rowCount === 0) return res.send('Shift report not found.');
      res.render('admin_edit', { report: r.rows[0] });
    })
    .catch((err) => res.send('Error retrieving shift report: ' + err.message));
});

app.post('/admin/edit/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { shift_date, hours, cars, online_tips, cash_tips } = req.body;
  const updateQuery = `
    UPDATE shift_reports
    SET shift_date = $1, hours = $2, cars = $3, online_tips = $4, cash_tips = $5
    WHERE id = $6
  `;
  db.query(updateQuery, [shift_date, hours, cars, online_tips, cash_tips, id])
    .then(() => res.redirect('/admin'))
    .catch((err) => res.send('Error updating shift report: ' + err.message));
});

/* ------------------------------
   Admin: Export CSV (All)
--------------------------------*/
app.get('/admin/export', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY sr.shift_date DESC
  `;
  db.query(query)
    .then(async (r) => {
      const reports = r.rows.map((report) => ({
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
    })
    .catch((err) => res.send('Error retrieving reports: ' + err.message));
});

/* ------------------------------
   Admin: Locations
--------------------------------*/
app.get('/admin/locations', requireAdmin, (req, res) => {
  db.query('SELECT * FROM locations')
    .then((r) => res.render('admin_locations', { locations: r.rows, error: null, message: null }))
    .catch((err) => res.send('Error retrieving locations: ' + err.message));
});

app.post('/admin/locations', requireAdmin, (req, res) => {
  const { locationName } = req.body;
  if (!locationName) {
    return res.render('admin_locations', { locations: [], error: 'Location name is required', message: null });
  }
  db.query('INSERT INTO locations (name) VALUES ($1)', [locationName])
    .then(() => db.query('SELECT * FROM locations'))
    .then((r) => res.render('admin_locations', { locations: r.rows, error: null, message: 'Location added successfully!' }))
    .catch((err) =>
      res.render('admin_locations', { locations: [], error: 'Error adding/retrieving location: ' + err.message, message: null })
    );
});

/* ------------------------------
   Admin: Delete Shift
--------------------------------*/
app.post('/admin/delete/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM shift_reports WHERE id = $1', [id])
    .then(() => res.redirect('/admin'))
    .catch((err) => res.send('Error deleting entry: ' + err.message));
});

/* ------------------------------
   Admin: Leaderboard
--------------------------------*/
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

  db.query('SELECT * FROM locations')
    .then((lr) => {
      const locations = lr.rows;
      return db.query(query, params).then((qr) =>
        res.render('admin_leaderboard', {
          leaderboard: qr.rows,
          sort,
          order,
          locations,
          selectedLocation: locationFilter
        })
      );
    })
    .catch((err) => res.send('Error retrieving leaderboard/locations: ' + err.message));
});

/* ------------------------------
   Admin: Charts
--------------------------------*/
app.get('/admin/charts', requireAdmin, (req, res) => {
  const locationFilter = req.query.location_id || '';
  const attribute = req.query.attribute || 'hours';
  const allowedAttributes = ['hours', 'online_tips', 'cash_tips', 'total_tips'];
  if (!allowedAttributes.includes(attribute)) return res.send('Invalid attribute selected.');

  db.query('SELECT * FROM locations')
    .then((lr) => {
      const locations = lr.rows;
      let query = '';
      let params = [];
      const columnSelect =
        attribute === 'total_tips'
          ? 'COALESCE(SUM(sr.online_tips) + SUM(sr.cash_tips), 0)'
          : `COALESCE(SUM(sr.${attribute}), 0)`;

      if (locationFilter) {
        query = `
          SELECT sr.shift_date as date, ${columnSelect} as value
          FROM shift_reports sr
          WHERE sr.location_id = $1
          GROUP BY sr.shift_date
          ORDER BY sr.shift_date ASC
        `;
        params.push(locationFilter);
      } else {
        query = `
          SELECT sr.shift_date as date, ${columnSelect} as value
          FROM shift_reports sr
          GROUP BY sr.shift_date
          ORDER BY sr.shift_date ASC
        `;
      }

      return db.query(query, params).then((qr) => {
        const labels = qr.rows.map((r) => r.date);
        const dataValues = qr.rows.map((r) => r.value);
        res.render('admin_charts', {
          locations,
          labels,
          dataValues,
          selectedLocation: locationFilter,
          selectedAttribute: attribute
        });
      });
    })
    .catch((err) => res.send('Error retrieving chart data: ' + err.message));
});

/* ------------------------------
   Admin: Charts Compare
--------------------------------*/
app.get('/admin/charts-compare', requireAdmin, (req, res) => {
  const locationFilter = req.query.location_id || '';
  const attribute = req.query.attribute || 'hours';
  const valetFilter = req.query.valet_id || 'all';
  const allowedAttributes = ['hours', 'online_tips', 'cash_tips', 'total_tips'];
  if (!allowedAttributes.includes(attribute)) return res.send('Invalid attribute selected.');

  db.query('SELECT * FROM locations')
    .then((lr) => {
      const locations = lr.rows;
      return db.query(`SELECT id, name FROM users WHERE role='valet'`).then((vr) => ({ locations, valets: vr.rows }));
    })
    .then(({ locations, valets }) => {
      const sumExpression =
        attribute === 'total_tips'
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
        whereClauses.push(`sr.user_id = $${queryParams.length + 1}`);
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

      return db.query(query, queryParams).then((qr) => {
        const rows = qr.rows;
        const uniqueDates = Array.from(new Set(rows.map((r) => r.date))).sort();
        if (valetFilter !== 'all') {
          const dataMap = new Map();
          rows.forEach((r) => dataMap.set(r.date, r.value));
          const dataValues = uniqueDates.map((d) => dataMap.get(d) || 0);
          const datasets = [{ label: 'Valet Performance', data: dataValues }];
          return res.render('admin_charts_compare', {
            locations,
            valets,
            selectedLocation: locationFilter,
            selectedValet: valetFilter,
            selectedAttribute: attribute,
            labels: uniqueDates,
            datasets
          });
        } else {
          const userMap = new Map();
          rows.forEach((r) => {
            const uid = r.user_id;
            if (!userMap.has(uid)) {
              userMap.set(uid, { userName: r.user_name, dataMap: new Map() });
            }
            userMap.get(uid).dataMap.set(r.date, r.value);
          });
          const datasets = [];
          for (let [, info] of userMap.entries()) {
            const dataArray = uniqueDates.map((d) => info.dataMap.get(d) || 0);
            datasets.push({ label: info.userName, data: dataArray });
          }
          return res.render('admin_charts_compare', {
            locations,
            valets,
            selectedLocation: locationFilter,
            selectedValet: 'all',
            selectedAttribute: attribute,
            labels: uniqueDates,
            datasets
          });
        }
      });
    })
    .catch((err) => res.send('Error retrieving chart data: ' + err.message));
});

/* ------------------------------
   Admin: Screenshots
--------------------------------*/
app.get('/admin/screenshots', requireAdmin, (req, res) => {
  const locationFilter = req.query.location_id || '';
  db.query('SELECT * FROM locations')
    .then((lr) => {
      const locations = lr.rows;
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
      return db.query(query, queryParams).then((qr) => {
        const reportMap = new Map();
        qr.rows.forEach((r) => {
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
    })
    .catch((err) => res.send('Error retrieving screenshots: ' + err.message));
});

/* ------------------------------
   Weekly Export helpers & route
--------------------------------*/
function getValetWeekStart(dateTime) {
  const d = new Date(dateTime);
  const day = d.getDay();
  const hour = d.getHours();
  if (day === 1 && hour < 4) d.setDate(d.getDate() - 1);
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
  reports.forEach((r) => {
    const weekStart = getValetWeekStart(r.shift_date);
    const sunday = new Date(weekStart);
    sunday.setDate(sunday.getDate() + 6);
    const label = `${formatDate(weekStart)} to ${formatDate(sunday)}`;
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(r);
  });
  return map;
}

app.get('/admin/export-weekly', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name AS valet_name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY l.id, sr.shift_date ASC
  `;
  db.query(query)
    .then((r) => {
      const reports = r.rows;
      const locationMap = new Map();
      reports.forEach((row) => {
        const loc = row.location_name || 'Unspecified';
        if (!locationMap.has(loc)) locationMap.set(loc, []);
        locationMap.get(loc).push(row);
      });

      let csvLines = [];
      csvLines.push('ID,Valet Name,Phone,Shift Date,Hours,# of Cars,Online Tips,Cash Tips,Total,Location');
      for (const [locName, reportsForLoc] of locationMap.entries()) {
        csvLines.push(`Location: ${locName}`);
        const groupedByWeek = groupReportsByWeek(reportsForLoc);
        for (const [weekLabel, items] of groupedByWeek) {
          csvLines.push(`  Week: ${weekLabel}`);
          items.forEach((r) => {
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
    })
    .catch((err) => res.send('Error retrieving reports: ' + err.message));
});

/* ------------------------------
   Trevor Portal
--------------------------------*/
app.get('/admin/trevor', requireAdmin, (req, res) => {
  const query = `
    SELECT sr.*, u.name AS valet_name, u.phone, l.name AS location_name
    FROM shift_reports sr
    JOIN users u ON sr.user_id = u.id
    LEFT JOIN locations l ON sr.location_id = l.id
    ORDER BY sr.shift_date DESC
  `;
  db.query(query)
    .then((r) => {
      const reports = r.rows;
      const dayMap = new Map();
      reports.forEach((rec) => {
        let dayStr = rec.shift_date;
        if (typeof dayStr === 'string' && dayStr.includes('T')) {
          dayStr = dayStr.split('T')[0];
        }
        if (!dayMap.has(dayStr)) dayMap.set(dayStr, []);
        dayMap.get(dayStr).push(rec);
      });

      const daysData = [];
      for (let [day, shifts] of dayMap.entries()) {
        const locMap = new Map();
        shifts.forEach((r) => {
          const loc = r.location_name || 'Unspecified';
          if (!locMap.has(loc)) locMap.set(loc, []);
          locMap.get(loc).push(r);
        });
        const locationsArray = [];
        for (let [loc, sList] of locMap.entries()) {
          sList.sort((a, b) => a.valet_name.localeCompare(b.valet_name));
          let totalHours = 0,
            totalCars = 0,
            totalOnline = 0,
            totalCash = 0;
          sList.forEach((r) => {
            totalHours += Number(r.hours) || 0;
            totalCars += Number(r.cars) || 0;
            totalOnline += Number(r.online_tips) || 0;
            totalCash += Number(r.cash_tips) || 0;
          });
          locationsArray.push({ location: loc, shifts: sList, totalHours, totalCars, totalOnline, totalCash });
        }
        daysData.push({ day, locations: locationsArray });
      }
      daysData.sort((a, b) => new Date(b.day) - new Date(a.day));
      res.render('admin_trevor', { daysData });
    })
    .catch((err) => res.send('Error retrieving shift reports: ' + err.message));
});

/* ------------------------------
   Start Server after DB Ready
--------------------------------*/
async function waitForDbReady(retries = 12, delayMs = 2500) {
  for (let i = 1; i <= retries; i++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

(async () => {
  try {
    await waitForDbReady();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Could not connect to database after retries:', err);
    process.exit(1);
  }
})();
