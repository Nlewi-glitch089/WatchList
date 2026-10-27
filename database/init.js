// Connects to MongoDB, creates the indexes, and loads the movie catalog.
// The server also does this automatically on startup; this is for checking a new database by hand.
const { connectToDatabase, databaseSettings, describeUri, prepareDatabase } = require('./database');

(async () => {
  const { uri, dbName } = databaseSettings();
  const { client, db } = await connectToDatabase(uri, dbName);
  try {
    await prepareDatabase(db);
    const collections = (await db.listCollections().toArray()).map((c) => c.name).sort();
    const catalogCount = await db.collection('catalog_movies').countDocuments();
    console.log(`[db] Ready: ${describeUri(uri)}, database "${dbName}". Collections: ${collections.join(', ')}. Catalog: ${catalogCount} movies.`);
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error(`[db] ${err.message}`);
  process.exit(1);
});
