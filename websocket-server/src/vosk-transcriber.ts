import WebSocket from 'ws';
import { LoggerInstance } from './types';

interface VoskConfig {
  action: 'configure';
  sample_rate: number;
  words_per_message?: number; // Optional: Number of words per partial result message
}

interface VoskMessage {
  text?: string; // Final transcript
  partial?: string; // Partial transcript
  result?: Array<{ // For final result with word timings
    conf: number;
    start: number;
    end: number;
    word: string;
  }>;
}

interface VoskTranscriberParams {
  callId: string;
  audioBuffer: Buffer; // This will be the complete audio for the turn for async transcription
  sampleRate: number;
  voskServerUrl: string;
  callLogger: LoggerInstance;
}

export async function transcribeWithVosk(params: VoskTranscriberParams): Promise<string | null> {
  const { callId, audioBuffer, sampleRate, voskServerUrl, callLogger } = params;
  const logger = callLogger.child({ component: 'VoskTranscriber' });

  logger.info(`[${callId}] Attempting to connect to Vosk server at ${voskServerUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(voskServerUrl);
    let finalTranscript: string | null = null;

    ws.on('open', async () => {
      logger.info(`[${callId}] Connected to Vosk server. Configuring...`);
      const configMessage: VoskConfig = {
        action: 'configure',
        sample_rate: sampleRate,
        // words_per_message: 5 // Example: get partial results more frequently
      };
      ws.send(JSON.stringify(configMessage));
      logger.debug(`[${callId}] Sent Vosk config: ${JSON.stringify(configMessage)}`);

      // Send the entire audio buffer in one go, as this is async transcription of a completed turn.
      // Vosk server typically expects chunks, but for a single buffer, sending it all should work.
      // If the buffer is very large, chunking might be necessary, but let's try direct send first.
      // The Python example sends in chunks within a loop.
      // For simplicity with a single buffer, we'll send it and then EOF.
      // However, the test.py script sends config, then chunks, then EOF.
      // Let's adapt to send audio data then EOF.

      // Vosk server expects raw audio data after configuration.
      // The audioBuffer is already raw PCM or uLaw.
      // If it's uLaw, Vosk might need to be configured for it or it needs conversion.
      // Assuming PCM for now as per common Vosk setups.
      // If audioBuffer is uLaw, it MUST be converted to PCM s16le first.
      // For this initial implementation, we assume audioBuffer is PCM s16le.
      // This needs to be ensured by the caller or handled here if ASYNC_STT_AUDIO_FORMAT is 'mulaw'.

      logger.info(`[${callId}] Sending audio data to Vosk (buffer length: ${audioBuffer.length} bytes).`);
      ws.send(audioBuffer);

      // Send EOF message
      const eofMessage = { eof: 1 };
      ws.send(JSON.stringify(eofMessage));
      logger.info(`[${callId}] Sent EOF to Vosk.`);
    });

    ws.on('message', (data: WebSocket.Data) => {
      const messageStr = data.toString();
      logger.debug(`[${callId}] Received message from Vosk: ${messageStr}`);
      try {
        const voskResponse = JSON.parse(messageStr) as VoskMessage;

        if (voskResponse.text) { // Final hypothesis
          finalTranscript = voskResponse.text;
          logger.info(`[${callId}] Vosk final transcript: "${finalTranscript}"`);
          // Since we sent EOF, the next message with 'text' should be the final one.
          // We can resolve here, but let's wait for the close event to be sure,
          // or if Vosk server confirms EOF processing.
          // For now, if .text is present, we assume it's the final for this simple case.
          ws.close(); // Close the connection after receiving the final transcript.
          resolve(finalTranscript);
        } else if (voskResponse.partial) {
          logger.info(`[${callId}] Vosk partial transcript: "${voskResponse.partial}"`);
        } else if (voskResponse.result) {
            // This is another form of final result, often with word timings
            const fullText = voskResponse.result.map(r => r.word).join(' ');
            if (fullText) {
                finalTranscript = fullText;
                logger.info(`[${callId}] Vosk final result (from words): "${finalTranscript}"`);
                ws.close();
                resolve(finalTranscript);
            }
        }
      } catch (e: any) {
        logger.error(`[${callId}] Error parsing Vosk message: ${e.message}. Data: ${messageStr}`);
      }
    });

    ws.on('error', (error: Error) => {
      logger.error(`[${callId}] Vosk WebSocket error: ${error.message}`);
      reject(error);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      logger.info(`[${callId}] Vosk WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
      if (finalTranscript) {
        resolve(finalTranscript);
      } else {
        // If closed without a final transcript (e.g., after an error or if no speech was detected by Vosk)
        logger.warn(`[${callId}] Vosk connection closed without a final transcript being captured.`);
        resolve(null); // Resolve with null if no transcript was obtained
      }
    });

    // Timeout for the entire operation
    const operationTimeout = setTimeout(() => {
      logger.error(`[${callId}] Vosk transcription operation timed out after 30 seconds.`);
      ws.terminate(); // Force close the WebSocket
      reject(new Error("Vosk transcription timed out"));
    }, 30000); // 30 seconds timeout

    // Clear timeout if resolved/rejected/closed earlier
    const clearOpTimeout = () => clearTimeout(operationTimeout);
    ws.on('close', clearOpTimeout);
    // If promise resolves or rejects, also clear timeout
    // This needs to be handled by wrapping resolve/reject or ensuring they are called before timeout hits.
    // The current structure with resolve/reject in listeners should be fine.
  });
}
