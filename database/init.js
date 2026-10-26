// Creates the database file and tables. The server also does this automatically on startup.
require('dotenv').config({ quiet: true });
const db = require('./database');

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((row) => row.name);

console.log(`[db] Ready. Tables: ${tables.join(', ')}`);
db.close();
