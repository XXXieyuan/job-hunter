require('dotenv').config();
const app = require('./app');
const { PORT } = require('./config');
const { runMigrations } = require('./db/migrate');
const { ensureSampleResumeSeeded } = require('./services/resumeService');

async function start() {
  try {
    runMigrations();
    await ensureSampleResumeSeeded();

    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Job Hunter listening on port ${PORT}`);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to start Job Hunter:', err);
    process.exit(1);
  }
}

start();

