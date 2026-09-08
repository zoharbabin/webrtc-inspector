// Starts the real livekit-server once for the whole suite run and stops it
// afterward. Runs in Playwright's root process; individual spec files (which
// run in worker processes) never touch this instance directly — they mint
// their own tokens via server.js's standalone mintToken() and only need the
// server to already be listening at LIVEKIT_URL.
'use strict';

const { LiveKitDevServer, startControlServer } = require('./server.js');

module.exports = async function globalSetup() {
  const server = new LiveKitDevServer();
  await server.start();
  const controlServer = await startControlServer(server);
  return async function globalTeardown() {
    await server.stop();
    await new Promise((resolve) => controlServer.close(resolve));
  };
};
