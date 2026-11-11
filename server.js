'use strict';

require('dotenv').config();

const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const apiRoutes = require('./routes/api');
const fccTestingRoutes = require('./routes/fcctesting');
const runner = require('./test-runner');

const app = express();

app.use(cors({ origin: '*' }));
app.use(helmet.frameguard({ action: 'sameorigin' }));
app.use(helmet.dnsPrefetchControl({ allow: false }));
app.use(helmet.referrerPolicy({ policy: 'same-origin' }));

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/b/:board/:threadid', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'thread.html'));
});

app.get('/b/:board/', (req, res) => {
  if (!req.path.endsWith('/')) {
    return res.redirect(`/b/${encodeURIComponent(req.params.board)}/`);
  }

  res.sendFile(path.join(__dirname, 'views', 'board.html'));
});

fccTestingRoutes(app);
apiRoutes(app);

app.use((req, res) => {
  res.status(404).type('text').send('Not Found');
});

const listener = app.listen(process.env.PORT || 3000, () => {
  const port = listener.address().port;
  console.log(`Your app is listening on port ${port}`);

  if (process.env.NODE_ENV === 'test') {
    process.env.MESSAGE_BOARD_TEST_PORT = String(port);
    runner.run();
  }
});

module.exports = app;