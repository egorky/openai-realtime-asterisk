import Ari, { Channel, Bridge, Playback } from 'ari-client';
import dotenv from 'dotenv';
import { RtpServer } from './rtp-server';
import * as sessionManager from './sessionManager'; // Using namespace import
import { AriClient as AriClientInterface } from './types'; // Import the interface

// For now, using console as the logger for the module
const moduleLogger = {
  info: console.log,
  error: console.error,
  warn: console.warn,
  debug: console.log,
  silly: console.log,
  isLevelEnabled: (level: string) => level !== 'silly',
};

dotenv.config();

// Configuration Variables (remains at module level for now)
const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'openai-ari-app';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const DEFAULT_RTP_HOST_IP = process.env.RTP_HOST_IP || '127.0.0.1';
const DEFAULT_SNOOP_SPY_DIRECTION = process.env.SNOOP_SPY_DIRECTION || 'in';
const DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA = process.env.AUDIO_FORMAT_FOR_EXTERNAL_MEDIA || 'ulaw';

if (!OPENAI_API_KEY) {
  moduleLogger.error("OPENAI_API_KEY environment variable is required for sessionManager interaction.");
}

interface CallResources {
  channel: Channel; // The original incoming channel
  userBridge?: Bridge; // Bridge holding the user channel
  snoopBridge?: Bridge; // Bridge for snoop and external media
  rtpServer?: RtpServer;
  externalMediaChannel?: Channel; // Channel for Asterisk -> RTP Server
  snoopChannel?: Channel; // Snoop channel on the user's audio
}

class AriClientService implements AriClientInterface {
  private client: Ari.Client | null = null;
  private activeCalls = new Map<string, CallResources>();
  private appOwnedChannelIds = new Set<string>();
  private logger = moduleLogger;
  private openaiApiKey: string;

  constructor(openaiApiKey: string) {
    this.openaiApiKey = openaiApiKey;
    if (!this.openaiApiKey) {
      this.logger.error("OPENAI_API_KEY is essential and was not provided to AriClientService.");
      // Consider throwing an error or handling this more gracefully
    }
  }

  public async connect(): Promise<void> {
    try {
      this.client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
      this.logger.info('Connected to ARI');

      this.client.on('StasisStart', (event, channel) => this.onStasisStart(event, channel));
      this.client.on('StasisEnd', (event, channel) => this.onStasisEnd(event, channel));
      this.client.on('error', (err) => this.onAriError(err));
      this.client.on('close', () => this.onAriClose());

      await this.client.start(ASTERISK_ARI_APP_NAME);
      this.logger.info(`ARI application ${ASTERISK_ARI_APP_NAME} started`);
    } catch (err) {
      this.logger.error('Failed to connect or initialize ARI client:', err);
      throw err; // Propagate error for handling by the caller
    }
  }

  private async onStasisStart(event: any, incomingChannel: Channel): Promise<void> {
    this.logger.info(`StasisStart: Channel ${incomingChannel.id} entered ${ASTERISK_ARI_APP_NAME}, name: ${incomingChannel.name}`);

    if (this.appOwnedChannelIds.has(incomingChannel.id)) {
      this.logger.info(`Channel ${incomingChannel.id} is app-owned, ignoring StasisStart.`);
      return;
    }

    const callResources: CallResources = { channel: incomingChannel };
    this.activeCalls.set(incomingChannel.id, callResources);

    try {
      await incomingChannel.answer();
      this.logger.info(`Channel ${incomingChannel.id} answered.`);

      if (!this.client) throw new Error("ARI client not connected in onStasisStart");

      callResources.userBridge = await this.client.bridges.create({ type: 'mixing', name: `user_bridge_${incomingChannel.id}` });
      this.logger.info(`User bridge ${callResources.userBridge.id} created for channel ${incomingChannel.id}.`);
      await callResources.userBridge.addChannel({ channel: incomingChannel.id });
      this.logger.info(`Channel ${incomingChannel.id} added to user bridge ${callResources.userBridge.id}.`);

      callResources.snoopBridge = await this.client.bridges.create({ type: 'mixing', name: `snoop_bridge_${incomingChannel.id}` });
      this.logger.info(`Snoop bridge ${callResources.snoopBridge.id} created for channel ${incomingChannel.id}.`);

      callResources.rtpServer = new RtpServer(this.logger); // Pass instance logger
      const rtpServerAddress = await callResources.rtpServer.start(0, DEFAULT_RTP_HOST_IP);
      this.logger.info(`RTP Server started for channel ${incomingChannel.id} at ${rtpServerAddress.host}:${rtpServerAddress.port}`);

      callResources.externalMediaChannel = await this.client.channels.externalMedia({
        app: ASTERISK_ARI_APP_NAME,
        external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`,
        format: DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA, // Log this format
      });
      this.appOwnedChannelIds.add(callResources.externalMediaChannel.id);
      this.logger.info(`External Media channel ${callResources.externalMediaChannel.id} created for channel ${incomingChannel.id} with format: ${DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA}.`);

      callResources.snoopChannel = await this.client.channels.snoopChannelWithId({
        channelId: incomingChannel.id,
        snoopId: `snoop_${incomingChannel.id}`,
        app: ASTERISK_ARI_APP_NAME,
        spy: DEFAULT_SNOOP_SPY_DIRECTION as 'in' | 'out' | 'both' | undefined,
      });
      this.appOwnedChannelIds.add(callResources.snoopChannel.id);
      this.logger.info(`Snoop channel ${callResources.snoopChannel.id} created for channel ${incomingChannel.id}.`);

      await callResources.snoopBridge.addChannel({ channel: callResources.externalMediaChannel.id });
      this.logger.info(`External Media channel ${callResources.externalMediaChannel.id} added to snoop bridge ${callResources.snoopBridge.id}.`);
      await callResources.snoopBridge.addChannel({ channel: callResources.snoopChannel.id });
      this.logger.info(`Snoop channel ${callResources.snoopChannel.id} added to snoop bridge ${callResources.snoopBridge.id}.`);

      callResources.rtpServer.on('audioPacket', (audioPayload: Buffer) => {
        sessionManager.handleAriAudioMessage(audioPayload);
      });

      // Integrate with sessionManager
      sessionManager.handleCallConnection(incomingChannel.id, this.openaiApiKey, this);
      this.logger.info(`Call connection for channel ${incomingChannel.id} passed to sessionManager.`);

    } catch (err) {
      this.logger.error(`Error setting up call for channel ${incomingChannel.id}:`, err);
      await this.cleanupCallResources(incomingChannel.id, true); // true for hangup
    }
  }

  private async onStasisEnd(event: any, channel: Channel): Promise<void> {
    this.logger.info(`StasisEnd: Channel ${channel.id} left ${ASTERISK_ARI_APP_NAME}`);
    await this.cleanupCallResources(channel.id, false); // false for hangupChannel, channel is already down
    sessionManager.handleAriCallEnd(channel.id);
  }

  private onAriError(err: Error): void {
    this.logger.error('ARI Client Error:', err);
  }

  private onAriClose(): void {
    this.logger.info('ARI Connection Closed. Cleaning up all active calls.');
    const allChannelIds = Array.from(this.activeCalls.keys());
    allChannelIds.forEach(channelId => this.cleanupCallResources(channelId, false, true)); // No hangup, isAriClosing = true
    this.client = null; // Mark client as disconnected
    // TODO: Implement reconnection logic if needed
  }

  public async playbackAudio(channelId: string, audioPayload: string): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (!call || !call.channel) {
      this.logger.error(`playbackAudio: Call resources not found for channelId ${channelId}. Cannot play audio.`);
      return;
    }

    // Play on the original incoming channel, which should be in the userBridge
    const userChannel = call.channel;
    this.logger.info(`Attempting to play audio on channel ${userChannel.id}`);
    try {
      // Ensure the channel is still valid and in Stasis
      // A channel might have left Stasis but resources not yet fully cleaned.
      // A more robust check might involve querying channel state if needed.
      await userChannel.play({ media: 'sound:base64:' + audioPayload });
      this.logger.info(`Audio playback started on channel ${userChannel.id}`);
    } catch (error) {
      this.logger.error(`Error playing audio on channel ${userChannel.id}:`, error);
      // Decide if any specific cleanup is needed here, e.g., if playback error means call is dead.
    }
  }

  public async endCall(channelId: string): Promise<void> {
    // To be fully implemented in Step 9
    this.logger.info(`endCall requested for channel ${channelId}`);
    await this.cleanupCallResources(channelId, true);
  }

  private async cleanupCallResources(channelId: string, hangupChannel: boolean = false, isAriClosing: boolean = false): Promise<void> {
    const resources = this.activeCalls.get(channelId);
    if (!resources) {
      this.logger.warn(`No resources found for channel ${channelId} during cleanup.`);
      return;
    }

    this.logger.info(`Cleaning up resources for channel ${channelId}. Hangup: ${hangupChannel}`);

    if (resources.rtpServer && resources.rtpServer.isReady()) {
      try {
        await resources.rtpServer.stop();
        this.logger.info(`RTP server stopped for channel ${channelId}.`);
      } catch (rtpErr) {
        this.logger.error(`Error stopping RTP server for ${channelId}:`, rtpErr);
      }
    }

    // Remove app-owned channel IDs from the tracking set
    if (resources.externalMediaChannel) this.appOwnedChannelIds.delete(resources.externalMediaChannel.id);
    if (resources.snoopChannel) this.appOwnedChannelIds.delete(resources.snoopChannel.id);

    // Hangup the original channel if requested and ARI is not closing
    if (hangupChannel && resources.channel && !isAriClosing) {
      try {
        this.logger.info(`Attempting to hang up channel ${resources.channel.id}.`);
        await resources.channel.hangup();
        this.logger.info(`Channel ${resources.channel.id} hung up.`);
      } catch (hangupError) {
        // Ignore errors if channel already hung up (e.g. StasisEnd already processed)
        if ((hangupError as any)?.message?.includes("Channel not found")) {
             this.logger.warn(`Channel ${resources.channel.id} already hung up or not found.`);
        } else {
             this.logger.error(`Error hanging up channel ${resources.channel.id}:`, hangupError);
        }
      }
    }

    // Bridges are often managed by Asterisk when channels leave, but explicit destruction can be added if needed.
    // For snoopChannel and externalMediaChannel, hangup if they exist
    if (resources.snoopChannel) {
      try {
        this.logger.info(`Hanging up snoop channel ${resources.snoopChannel.id} for main channel ${channelId}.`);
        await resources.snoopChannel.hangup();
      } catch (snoopErr) {
        this.logger.warn(`Error hanging up snoop channel ${resources.snoopChannel.id}:`, snoopErr);
      }
    }
    if (resources.externalMediaChannel) {
      try {
        this.logger.info(`Hanging up external media channel ${resources.externalMediaChannel.id} for main channel ${channelId}.`);
        await resources.externalMediaChannel.hangup();
      } catch (extMediaErr) {
        this.logger.warn(`Error hanging up external media channel ${resources.externalMediaChannel.id}:`, extMediaErr);
      }
    }

    // Destroy bridges if they exist
    if (resources.userBridge) {
      try {
        this.logger.info(`Destroying user bridge ${resources.userBridge.id} for channel ${channelId}.`);
        await resources.userBridge.destroy();
      } catch (bridgeErr) {
        this.logger.warn(`Error destroying user bridge ${resources.userBridge.id}:`, bridgeErr);
      }
    }
    if (resources.snoopBridge) {
      try {
        this.logger.info(`Destroying snoop bridge ${resources.snoopBridge.id} for channel ${channelId}.`);
        await resources.snoopBridge.destroy();
      } catch (bridgeErr) {
        this.logger.warn(`Error destroying snoop bridge ${resources.snoopBridge.id}:`, bridgeErr);
      }
    }

    // Hangup the original channel if requested and ARI is not closing
    if (hangupChannel && resources.channel && !isAriClosing) {
      try {
        this.logger.info(`Attempting to hang up main channel ${resources.channel.id}.`);
        await resources.channel.hangup();
        this.logger.info(`Main channel ${resources.channel.id} hung up.`);
      } catch (hangupError) {
        if ((hangupError as any)?.message?.includes("Channel not found") || (hangupError as any)?.message?.includes("does not exist")) {
             this.logger.warn(`Main channel ${resources.channel.id} already hung up or not found.`);
        } else {
             this.logger.error(`Error hanging up main channel ${resources.channel.id}:`, hangupError);
        }
      }
    }

    this.activeCalls.delete(channelId);
    this.logger.info(`Resources for channel ${channelId} removed from activeCalls.`);
  }
}

// Singleton instance of the service
let ariClientServiceInstance: AriClientService | null = null;

export async function initializeAriClient(): Promise<AriClientService> {
  if (!OPENAI_API_KEY) {
    moduleLogger.error("Cannot initialize AriClientService: OPENAI_API_KEY is not set.");
    throw new Error("OPENAI_API_KEY is not set.");
  }
  if (!ariClientServiceInstance) {
    ariClientServiceInstance = new AriClientService(OPENAI_API_KEY);
    await ariClientServiceInstance.connect();
  }
  return ariClientServiceInstance;
}
