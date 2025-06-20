import dgram from 'dgram';
import { EventEmitter } from 'events';
// import { Logger } from 'winston'; // Assuming a logger type, replace with actual if available

// A simple logger interface for now, replace with your actual logger if needed
interface Logger {
  info(message: string): void;
  error(message: string, error?: any): void;
  warn(message: string): void;
  debug(message: string): void;
  silly?(message: string): void; // Optional, as used in reference
  isLevelEnabled?(level: string): boolean; // Optional, as used in reference
}

const RTP_HEADER_LENGTH = 12;

export class RtpServer extends EventEmitter {
  private socket: dgram.Socket;
  private logger: Logger;
  private host: string = '127.0.0.1';
  private port: number = 0;
  private _isReady: boolean = false;
  private packetCount: number = 0;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
    this.socket = dgram.createSocket('udp4');

    this.socket.on('error', (err) => {
      this.logger.error(`RtpServer socket error:`, err);
      this._isReady = false;
      this.emit('error', err);
      try {
        this.socket.close();
      } catch (closeError) {
        this.logger.warn(`RtpServer: Error trying to close socket after an error: ${(closeError as Error).message}`);
      }
    });

    this.socket.on('message', (msg, rinfo) => {
      this.packetCount++;
      if (this.logger.isLevelEnabled?.('debug')) {
        this.logger.debug(`RtpServer: Received UDP packet #${this.packetCount} of ${msg.length} bytes from ${rinfo.address}:${rinfo.port}.`);
      }


      if (msg.length < RTP_HEADER_LENGTH) {
        this.logger.warn(`RtpServer: Packet #${this.packetCount} is too short (${msg.length} bytes) to be an RTP packet. Discarding.`);
        return;
      }

      const payload = Buffer.from(msg.subarray(RTP_HEADER_LENGTH));

      if (payload.length > 0) {
        if (this.logger && typeof this.logger.silly === 'function') {
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
      this.host = address.address;
      this._isReady = true;
      this.logger.info(`RtpServer listening on ${this.host}:${this.port}`);
      this.emit('listening', { host: this.host, port: this.port });
    });

    this.socket.on('close', () => {
      this._isReady = false;
      this.logger.info(`RtpServer socket closed on port ${this.port}. Total packets received: ${this.packetCount}`);
      this.emit('close');
    });
  }

  public start(port: number = 0, host: string = '127.0.0.1'): Promise<{ host: string, port: number }> {
    return new Promise((resolve, reject) => {
      this.port = port;
      this.host = host;
      this.packetCount = 0;
      this._isReady = false;

      const onListening = () => {
        this.socket.removeListener('error', onErrorDuringBind);
        // _isReady is set by the 'listening' event handler
        resolve({ host: this.socket.address().address, port: this.socket.address().port });
      };

      const onErrorDuringBind = (err: Error) => {
        this.socket.removeListener('listening', onListening);
        this._isReady = false;
        this.logger.error(`RtpServer failed to bind to ${this.host}:${this.port}: ${err.message}`);
        reject(err);
      };

      this.socket.once('listening', onListening);
      this.socket.once('error', onErrorDuringBind);

      try {
        this.socket.bind(this.port, this.host);
      } catch (bindError) {
        onErrorDuringBind(bindError as Error);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this._isReady = false;
      if (this.socket) {
        this.logger.info(`RtpServer attempting to close socket on port ${this.port}.`);
        try {
          if (this.socket.address()) { // Check if socket was bound
            this.socket.close(() => {
              resolve();
            });
          } else {
            this.logger.info(`RtpServer socket for port ${this.port} was not bound or already closed.`);
            resolve();
          }
        } catch (e) {
          this.logger.warn(`RtpServer error during socket.address() check or close() call: ${(e as Error).message}. Assuming closed.`);
          resolve();
        }
      } else {
        this.logger.info('RtpServer: No socket instance to close.');
        resolve();
      }
    });
  }

  public isReady(): boolean {
    return this._isReady;
  }

  public getAddress(): { host: string, port: number } | null {
    if (!this._isReady || this.port === 0) {
      return null;
    }
    try {
      const address = this.socket.address();
      return address ? { host: address.address, port: this.port } : null;
    } catch (e) {
      this.logger.warn(`RtpServer: Error getting socket address: ${(e as Error).message}`);
      return null;
    }
  }
}
