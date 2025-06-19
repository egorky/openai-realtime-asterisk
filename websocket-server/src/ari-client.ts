import Ari from 'ari-client';
import dotenv from 'dotenv';
// import logger from '../logger'; // Assuming logger will be added later

dotenv.config();

const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'ari-app';

export async function initializeAriClient() {
  try {
    const client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
    // logger.info('Connected to ARI');
    console.log('Connected to ARI');

    client.on('StasisStart', (event, channel) => {
      // logger.info(`StasisStart: Channel ${channel.id} entered ${ASTERISK_ARI_APP_NAME}`);
      console.log(`StasisStart: Channel ${channel.id} entered ${ASTERISK_ARI_APP_NAME}`);
      // TODO: Answer the channel and handle media
    });

    client.on('StasisEnd', (event, channel) => {
      // logger.info(`StasisEnd: Channel ${channel.id} left ${ASTERISK_ARI_APP_NAME}`);
      console.log(`StasisEnd: Channel ${channel.id} left ${ASTERISK_ARI_APP_NAME}`);
    });

    client.on('error', (err) => {
      // logger.error('ARI Error:', err);
      console.error('ARI Error:', err);
    });

    client.on('close', () => {
      // logger.info('ARI Connection Closed');
      console.log('ARI Connection Closed');
      // TODO: Implement reconnection logic if needed
    });

    await client.start(ASTERISK_ARI_APP_NAME);
    // logger.info(`ARI application ${ASTERISK_ARI_APP_NAME} started`);
    console.log(`ARI application ${ASTERISK_ARI_APP_NAME} started`);

    return client;
  } catch (err) {
    // logger.error('Failed to connect to ARI:', err);
    console.error('Failed to connect to ARI:', err);
    throw err;
  }
}
