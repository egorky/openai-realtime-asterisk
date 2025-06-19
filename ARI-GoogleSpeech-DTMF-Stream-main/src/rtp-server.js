/**
 * @fileoverview RTP Server module for receiving UDP packets containing RTP audio.
 */
const dgram = require('dgram');
const EventEmitter = require('events');

/**
 * The length of a standard RTP header in bytes.
 * This is used to offset into the UDP packet to extract the audio payload.
 * @const {number}
 */
const RTP_HEADER_LENGTH = 12;

/**
 * @class RtpServer
 * @extends EventEmitter
 * @description Manages a UDP socket to receive RTP packets from Asterisk (or another source),
 * extracts audio payloads, and emits them for further processing (e.g., by a speech service).
 *
 * @fires RtpServer#listening
 *   @property {object} address - The address information.
 *   @property {string} address.host - The host address the server is listening on.
 *   @property {number} address.port - The port number the server is listening on.
 * @fires RtpServer#error
 *   @property {Error} error - The error object encountered by the socket.
 * @fires RtpServer#audioPacket
 *   @property {Buffer} payload - The raw audio payload extracted from the RTP packet.
 *   @property {dgram.RemoteInfo} rinfo - Information about the remote sender of the packet.
 * @fires RtpServer#close
 *   @description Emitted when the server's UDP socket is closed.
 */
class RtpServer extends EventEmitter {
  /**
   * Creates an instance of RtpServer.
   * @param {winston.Logger} logger - The logger instance for application-wide logging.
   * @param {string} [host='0.0.0.0'] - The host address to bind the UDP socket to.
   *                                    Defaults to '0.0.0.0' to listen on all available interfaces.
   */
  constructor(logger, host = '0.0.0.0') {
    super();
    /** @type {winston.Logger} Logger instance. */
    this.logger = logger;
    /** @type {string} Host address the server will try to bind to. */
    this.host = host;
    /**
     * The UDP socket instance.
     * @type {dgram.Socket}
     */
    this.socket = dgram.createSocket('udp4');
    /**
     * The port number the server is listening on. Initialized to 0 and set upon successful binding.
     * @type {number}
     */
    this.port = 0;
    /**
     * Counter for the number of RTP packets received since the server started or was last reset.
     * @type {number}
     */
    this.packetCount = 0;
    /**
     * Indicates if the server has successfully started and the socket is listening.
     * @private
     * @type {boolean}
     */
    this._isReady = false;

    this.socket.on('error', (err) => {
      this.logger.error(`RtpServer socket error:\n${err.stack}`);
      this._isReady = false;
      this.emit('error', err);
      // Attempt to close the socket if an error occurs, to free up resources.
      try {
        this.socket.close();
      } catch (closeError) {
        this.logger.warn(`RtpServer: Error trying to close socket after an error: ${closeError.message}`);
      }
    });

    this.socket.on('message', (msg, rinfo) => {
      this.packetCount++;
      // Reduce log verbosity for packet reception unless debugging is needed.
      // Use isLevelEnabled for performance: avoids constructing log string if level not enabled.
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(`RtpServer: Received UDP packet #${this.packetCount} of ${msg.length} bytes from ${rinfo.address}:${rinfo.port}.`);
      }

      if (msg.length < RTP_HEADER_LENGTH) {
        this.logger.warn(`RtpServer: Packet #${this.packetCount} is too short (${msg.length} bytes) to be an RTP packet. Discarding.`);
        return;
      }

      // Extract payload (audio data) by creating a new Buffer that is a subarray of msg.
      // This avoids modifying the original message buffer if it's referenced elsewhere.
      const payload = Buffer.from(msg.subarray(RTP_HEADER_LENGTH));

      if (payload.length > 0) {
        if (this.logger.isLevelEnabled('silly')) {
          this.logger.silly(`RtpServer: Packet #${this.packetCount} contains audio payload of ${payload.length} bytes. Emitting 'audioPacket'.`);
        }
        this.emit('audioPacket', payload, rinfo);
      } else {
        this.logger.warn(`RtpServer: Packet #${this.packetCount} has an empty payload after removing RTP header. Discarding.`);
      }
    });

    this.socket.on('listening', () => {
      const address = this.socket.address();
      this.port = address.port;
      this._isReady = true;
      this.logger.info(`RtpServer listening on ${address.address}:${this.port}`);
      this.emit('listening', { host: address.address, port: this.port });
    });

    this.socket.on('close', () => {
      this._isReady = false;
      this.logger.info(`RtpServer socket closed on port ${this.port}. Total packets received: ${this.packetCount}`);
      this.emit('close');
    });
  }

  /**
   * Starts the RTP server, attempting to bind the UDP socket to the specified host and port.
   * @async
   * @param {number} [preferredPort=0] - The preferred port to bind to. If 0 (or not provided),
   *                                     the OS will assign a random available port.
   * @returns {Promise<{host: string, port: number}>} A promise that resolves with an object
   *                                                 containing the host and port the server is listening on.
   * @throws {Error} If the server fails to bind to the port (e.g., port already in use).
   */
  start(preferredPort = 0) {
    return new Promise((resolve, reject) => {
      this.port = preferredPort;
      this.packetCount = 0; // Reset packet count each time server starts
      this._isReady = false;  // Set to false until 'listening' event confirms readiness

      const onListening = () => {
        this.socket.removeListener('error', onErrorDuringBind); // Clean up error listener for bind
        // _isReady is set true by the 'listening' event handler a few lines above.
        resolve({ host: this.socket.address().address, port: this.port });
      };

      const onErrorDuringBind = (err) => {
        this.socket.removeListener('listening', onListening); // Clean up listening listener
        this._isReady = false;
        this.logger.error(`RtpServer failed to bind to ${this.host}:${this.port}: ${err.message}`);
        reject(err);
      };

      // These listeners are specific to the binding process.
      this.socket.once('listening', onListening);
      this.socket.once('error', onErrorDuringBind);

      try {
        this.socket.bind(this.port, this.host);
      } catch (bindError) {
        // This catch block might be redundant if the 'error' event handles all bind errors,
        // but it's a safeguard for synchronous errors during the .bind() call itself.
        onErrorDuringBind(bindError);
      }
    });
  }

  /**
   * Stops the RTP server and closes the UDP socket.
   * @async
   * @returns {Promise<void>} A promise that resolves when the socket is confirmed to be closed,
   *                          or if there was no socket to close.
   */
  stop() {
    return new Promise((resolve) => {
      this._isReady = false; // Mark as not ready immediately upon stop intention
      if (this.socket) {
        this.logger.info(`RtpServer attempting to close socket on port ${this.port}.`);
        try {
            // Check if the socket has an address, implying it was bound and might be open.
            if (this.socket.address()) {
                 this.socket.close(() => {
                    // The 'close' event handler logs "RtpServer socket closed..."
                    resolve();
                });
            } else {
                // Socket exists but was never bound, or already closed by an error and has no address.
                this.logger.info(`RtpServer socket for port ${this.port} was not bound or already effectively closed.`);
                resolve();
            }
        } catch (e) {
             // This catch is for synchronous errors during the close attempt (e.g., if socket.address() throws).
             this.logger.warn(`RtpServer error during socket.address() check or close() call: ${e.message}. Assuming closed.`);
             resolve();
        }
      } else {
        this.logger.info('RtpServer: No socket instance to close.');
        resolve();
      }
    });
  }

  /**
   * Gets the network address the server is listening on.
   * @returns {{host: string, port: number} | null} An object containing the host and port,
   *                                                 or null if the server is not listening or the address is unavailable.
   */
  getAddress() {
    // Check _isReady first as it's a more reliable indicator of active listening state.
    if (!this._isReady || this.port === 0) {
      return null;
    }
    try {
      const address = this.socket.address();
      // Ensure address is not null (can happen if socket was just closed or in error state)
      return address ? { host: address.address, port: this.port } : null;
    } catch (e) {
      // Catch potential errors if socket.address() is called on a non-existent/closed socket.
      this.logger.warn(`RtpServer: Error getting socket address: ${e.message}`);
      return null;
    }
  }

  /**
   * Checks if the RTP server is currently listening and ready to receive packets.
   * @returns {boolean} True if the server is ready (socket is bound and listening), false otherwise.
   */
  isReady() {
    return this._isReady;
  }
}

module.exports = RtpServer;
