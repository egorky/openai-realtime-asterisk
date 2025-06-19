const { initAriClient } = require('./ari-client'); // logger is also exported but used internally by ari-client

/**
 * @fileoverview Main application entry point.
 * Initializes the ARI client and handles process signals for graceful shutdown.
 */

/**
 * @global
 * @typedef {object} AppObject
 * @property {object} [ariClient] - The ARI client instance, once initialized.
 */

/** @type {AppObject} Simple app object to hold client or shared state. */
const app = {};

/**
 * Main application function.
 * Initializes the ARI client which connects to Asterisk and starts listening for calls.
 * The logger is initialized within `initAriClient` after configuration is loaded.
 * @async
 */
async function main() {
  // Initial log messages before logger is fully configured (if any) should be handled carefully.
  // console.log('Attempting to initialize ARI client...'); // Example of an early log

  await initAriClient(app);

  // By this point, the logger from 'ari-client' should be available and configured if needed globally.
  // For instance, if you need to use the logger here:
  // const { logger } = require('./ari-client'); // Re-require if needed, or pass from initAriClient
  // logger.info('Application initialized and running. Waiting for calls.');
}

main().catch(error => {
  // Use console.error for errors before logger might be fully set up or if logger itself fails.
  console.error(`Unhandled error in main function: ${error.message}`, error.stack);
  // The logger instance might not be available or configured if the error occurs very early in startup.
  // Accessing logger here could lead to further errors if it's not initialized.
  process.exit(1);
});

/**
 * Handles SIGINT signal for graceful shutdown.
 * Attempts to close the ARI client's WebSocket connection before exiting.
 * @listens SIGINT
 */
process.on('SIGINT', async () => {
  // Direct console.log is used here as the logger's state during shutdown can be uncertain.
  console.log('SIGINT received. Shutting down...');
  if (app.ariClient) {
    console.log('Attempting to unregister ARI application from Asterisk...');
    try {
      // Implement a timeout for stop operation
      const stopPromise = app.ariClient.stop();
      const timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('ARI client stop operation timed out')), 3000); // 3-second timeout
      });

      await Promise.race([stopPromise, timeoutPromise]);
      console.log('ARI application unregistered successfully.');
    } catch (e) {
      console.warn(`Error or timeout unregistering ARI application: ${e.message}.`);
    }

    // Existing WebSocket close logic, now after stop()
    if (app.ariClient.ws) { // Check if ws exists, as client might be stopped already
        console.log('Attempting to close ARI client WebSocket connection...');
        try {
            if (app.ariClient.ws.readyState === 1) { // WebSocket.OPEN = 1
                app.ariClient.ws.close();
                console.log('ARI client WebSocket connection close command issued.');
            } else {
                console.log(`ARI client WebSocket not open. State: ${app.ariClient.ws.readyState}`);
            }
        } catch (e) {
            console.warn(`Error closing ARI client WebSocket: ${e.message}.`);
        }
    } else {
        console.log('ARI client WebSocket instance not found (possibly already cleaned up by .stop()).');
    }

  } else {
    console.log('ARI client not initialized. No Asterisk de-registration needed.');
  }
  console.log('Exiting application.');
  process.exit(0);
});
