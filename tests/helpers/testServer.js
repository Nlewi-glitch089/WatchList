// Starts the app for a test file: a real, throwaway MongoDB server (mongodb-memory-server)
// plus the Express app on a random port. Nothing touches your own database.
//
// The first run downloads the MongoDB binary, so it needs an internet connection once.
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createApp } = require('../../app');
const { connectToDatabase, prepareDatabase } = require('../../database/database');

async function startTestServer() {
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
  const connection = await connectToDatabase(mongo.getUri(), 'movie_night_test');
  await prepareDatabase(connection.db);
  const server = createApp(connection.db).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  return {
    db: connection.db,
    mongo,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await connection.client.close();
      await mongo.stop();
    },
  };
}

module.exports = { startTestServer };
