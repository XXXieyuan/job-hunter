const path = require('path');
const express = require('express');
const engine = require('ejs-mate');
const jobsRoutes = require('./routes/jobsRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();

// Use ejs-mate for layout support (needed for layout('layout') in views)
app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use('/', jobsRoutes);
app.use('/', adminRoutes);

app.use((req, res) => {
  res.status(404).send('未找到页面');
});

module.exports = app;
