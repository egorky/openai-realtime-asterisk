import { google } from '@google-cloud/speech/build/protos/protos';
import { Transform } from 'stream';
import { SpeechClient } from '@google-cloud/speech';
import { CallSpecificConfig, LoggerInstance } from './types';
import { logConversationToRedis } from './redis-client';
import { extractAndSaveParameters } from './parameter-extractor';

// Helper to convert buffer to stream
import { Readable } from 'stream';

class GoogleSpeechService {
    private speechClient: SpeechClient;
    private logger: LoggerInstance;
    private callId: string;
    private config: CallSpecificConfig;
    private recognizeStream: any | null = null;

    constructor(callId: string, config: CallSpecificConfig, logger: LoggerInstance) {
        this.callId = callId;
        this.config = config;
        this.logger = logger.child({ component: 'GoogleSpeechService' });

        const googleCredentials = this.config.appConfig.appRecognitionConfig.asyncSttGoogleCredentials;
        const clientOptions = googleCredentials ? { keyFilename: googleCredentials } : {};
        this.speechClient = new SpeechClient(clientOptions);
    }

    public startTranscriptionStream(): void {
        const appRecogConf = this.config.appConfig.appRecognitionConfig;
        const languageCode = appRecogConf.asyncSttGoogleLanguageCode || 'es-ES';
        const sampleRate = appRecogConf.asyncSttAudioSampleRate || 8000;
        const encoding: keyof typeof google.cloud.speech.v1.RecognitionConfig.AudioEncoding = 'MULAW';

        this.logger.warn(`Starting Google Speech transcription stream.`);
        this.logger.info(`Async STT Config: Lang: ${languageCode}, Rate: ${sampleRate}, Encoding: ${encoding}`);

        const streamingConfig: google.cloud.speech.v1.IStreamingRecognitionConfig = {
            config: {
                encoding: encoding,
                sampleRateHertz: sampleRate,
                languageCode: languageCode,
                // model: 'telephony', // Consider making this configurable
                enableAutomaticPunctuation: true,
            },
            interimResults: true, // We can decide if we want to log these
        };

        this.recognizeStream = this.speechClient.streamingRecognize(streamingConfig)
            .on('error', (err: Error) => {
                this.logger.error(`Google Speech stream error: ${err.message}`, err);
                this.stopTranscriptionStream();
            })
            .on('data', (data: google.cloud.speech.v1.IStreamingRecognizeResponse) => {
                if (data.results && data.results[0] && data.results[0].alternatives && data.results[0].alternatives[0]) {
                    const transcript = data.results[0].alternatives[0].transcript;
                    const isFinal = data.results[0].isFinal;

                    if (transcript) {
                        this.logger.debug(`[${isFinal ? 'FINAL' : 'INTERIM'}] Async STT: "${transcript}"`);
                        if (isFinal && transcript.trim()) {
                            this.logger.warn(`[Async STT] Final transcript: "${transcript}"`);
                            logConversationToRedis(this.callId, {
                                actor: 'caller',
                                type: 'async_transcript_result',
                                content: transcript,
                            }).catch(e => this.logger.error(`RedisLog Error (Google Speech final): ${e.message}`));

                            // Also extract and save parameters from the async transcript
                            extractAndSaveParameters(this.callId, transcript, this.logger).catch(e => {
                                this.logger.error(`Error extracting/saving parameters from async transcript: ${e.message}`);
                            });
                        }
                    }
                }
            })
            .on('end', () => {
                this.logger.info('Google Speech stream ended.');
                this.recognizeStream = null;
            });

        // This stream is now ready to receive audio chunks.
    }

    public sendAudio(audioChunk: Buffer): void {
        if (this.recognizeStream) {
            try {
                this.recognizeStream.write(audioChunk);
            } catch (error) {
                this.logger.error('Error writing audio to Google Speech stream:', error);
            }
        }
    }

    public stopTranscriptionStream(): void {
        if (this.recognizeStream) {
            this.logger.info('Stopping Google Speech transcription stream.');
            this.recognizeStream.end();
            this.recognizeStream = null;
        }
    }
}

export default GoogleSpeechService;
