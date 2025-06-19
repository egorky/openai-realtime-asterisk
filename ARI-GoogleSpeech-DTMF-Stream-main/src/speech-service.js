/**
 * @fileoverview Service module for interacting with Google Cloud Speech-to-Text API.
 * Provides functions for creating streaming recognition requests and performing batch transcription.
 */
const fs = require('fs').promises; // For reading the audio file
const { SpeechClient } = require('@google-cloud/speech').v1p1beta1;
const dotenv = require('dotenv');

dotenv.config();

/**
 * Path to the Google Cloud service account key file.
 * Loaded from the GOOGLE_APPLICATION_CREDENTIALS environment variable.
 * @const {string|undefined}
 */
const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Note: A global logger is not initialized here to avoid circular dependencies
// or uninitialized logger issues. Logging within this module relies on a logger
// instance being passed into its functions.
// if (!keyFilename) {
//   console.warn('GOOGLE_APPLICATION_CREDENTIALS environment variable is not set. Speech service may not function.');
// }

/**
 * Google Cloud SpeechClient instance.
 * Initialized with credentials from the GOOGLE_APPLICATION_CREDENTIALS environment variable if set.
 * @const {SpeechClient}
 */
const speechClient = new SpeechClient({
  keyFilename: keyFilename, // Path to the service account key file, can be undefined if GOOGLE_APPLICATION_CREDENTIALS is set directly in env
});

/**
 * Creates and configures a recognize stream for Google Cloud Speech-to-Text API.
 * This stream is used for real-time speech recognition.
 *
 * @param {winston.Logger} logger - Logger instance for logging events and errors related to this stream.
 * @param {object} baseGoogleConfig - Base configuration object for Google Speech settings.
 *   @param {string} baseGoogleConfig.encoding - The encoding of the audio data (e.g., 'MULAW', 'LINEAR16').
 *   @param {number} baseGoogleConfig.sampleRateHertz - The sample rate of the audio in Hertz.
 *   @param {string} baseGoogleConfig.defaultLanguageCode - The default language code (e.g., 'en-US') to use if not overridden.
 *   @param {number} [baseGoogleConfig.maxAlternatives=1] - Maximum number of recognition hypotheses to return.
 *   @param {boolean} [baseGoogleConfig.profanityFilter=false] - Whether to filter profanities.
 *   @param {boolean} [baseGoogleConfig.enableWordTimeOffsets=false] - Whether to include word time offsets in results.
 *   @param {boolean} [baseGoogleConfig.enableWordConfidence=false] - Whether to include word confidence scores.
 *   @param {boolean} [baseGoogleConfig.enableAutomaticPunctuation=true] - Whether to enable automatic punctuation.
 *   @param {object} [baseGoogleConfig.enableSpokenPunctuation={value:false}] - Configuration for spoken punctuation.
 *     @param {boolean} baseGoogleConfig.enableSpokenPunctuation.value - Enable/disable spoken punctuation (e.g., "question mark").
 *   @param {object} [baseGoogleConfig.enableSpokenEmojis={value:false}] - Configuration for spoken emojis.
 *     @param {boolean} baseGoogleConfig.enableSpokenEmojis.value - Enable/disable spoken emojis.
 *   @param {string} [baseGoogleConfig.model='telephony'] - The speech recognition model to use.
 *   @param {boolean} [baseGoogleConfig.useEnhanced=false] - Whether to use an enhanced model if available for the primary model.
 *   @param {object} [baseGoogleConfig.diarizationConfig] - Speaker diarization configuration.
 *     @param {boolean} [baseGoogleConfig.diarizationConfig.enableSpeakerDiarization=false] - Enable speaker diarization.
 *     @param {number} [baseGoogleConfig.diarizationConfig.minSpeakerCount=2] - Minimum number of speakers for diarization.
 *     @param {number} [baseGoogleConfig.diarizationConfig.maxSpeakerCount=6] - Maximum number of speakers for diarization.
 *   @param {boolean} [baseGoogleConfig.interimResults=true] - Whether to receive interim (non-final) results.
 *   @param {boolean} [baseGoogleConfig.singleUtterance=false] - If true, the stream stops automatically after the first detected utterance.
 *   @param {boolean} [baseGoogleConfig.enableVoiceActivityEvents=true] - Whether to request VAD events (SPEECH_ACTIVITY_BEGIN/END) from Google.
 *   @param {boolean} [baseGoogleConfig.enableVoiceActivityTimeout=true] - App-level flag to determine if VAD timeouts should be sent to Google.
 *   @param {object} [baseGoogleConfig.voiceActivityTimeout] - VAD timeout settings, used if `enableVoiceActivityTimeout` is true.
 *     @param {number} [baseGoogleConfig.voiceActivityTimeout.speechStartTimeoutSeconds] - Seconds Google waits for speech to begin after stream activation.
 *     @param {number} [baseGoogleConfig.voiceActivityTimeout.speechEndTimeoutSeconds] - Seconds of silence Google observes after speech to consider an utterance complete.
 * @param {function(object):void} onData - Callback function invoked when transcription data is received from Google.
 *                                        The data object contains results, including transcripts and event types.
 * @param {function(Error):void} onError - Callback function invoked if an error occurs in the speech stream.
 * @param {function():void} onEnd - Callback function invoked when the speech stream has ended.
 * @param {string} [languageCodeOverride] - Optional language code (e.g., 'es-US') to override the `defaultLanguageCode`
 *                                          from `baseGoogleConfig` for this specific stream.
 * @returns {object} The Google Speech API recognize stream instance with event listeners attached. This stream is writable for audio data.
 */
function createSpeechStream(logger, baseGoogleConfig, onData, onError, onEnd, languageCodeOverride) {
  const effectiveLanguageCode = languageCodeOverride || baseGoogleConfig.defaultLanguageCode;
  logger.info(`Creating Google Speech stream with language: ${effectiveLanguageCode}, Encoding: ${baseGoogleConfig.encoding}, SampleRate: ${baseGoogleConfig.sampleRateHertz}`);

  const request = {
    config: {
      encoding: baseGoogleConfig.encoding,
      sampleRateHertz: baseGoogleConfig.sampleRateHertz,
      languageCode: effectiveLanguageCode,
      maxAlternatives: baseGoogleConfig.maxAlternatives,
      profanityFilter: baseGoogleConfig.profanityFilter,
      enableWordTimeOffsets: baseGoogleConfig.enableWordTimeOffsets,
      enableWordConfidence: baseGoogleConfig.enableWordConfidence,
      enableAutomaticPunctuation: baseGoogleConfig.enableAutomaticPunctuation,
      enableSpokenPunctuation: baseGoogleConfig.enableSpokenPunctuation,
      enableSpokenEmojis: baseGoogleConfig.enableSpokenEmojis,
      model: baseGoogleConfig.model,
      useEnhanced: baseGoogleConfig.useEnhanced,
      diarizationConfig: baseGoogleConfig.diarizationConfig,
    },
    interimResults: baseGoogleConfig.interimResults,
    singleUtterance: baseGoogleConfig.singleUtterance,
    enableVoiceActivityEvents: baseGoogleConfig.enableVoiceActivityEvents,
  };

  // Conditionally construct and add voiceActivityTimeout to request.config
  if (baseGoogleConfig.enableVoiceActivityTimeout === true && baseGoogleConfig.voiceActivityTimeout) {
    const googleVADConfig = {};
    const speechStartTimeoutFloat = baseGoogleConfig.voiceActivityTimeout.speechStartTimeoutSeconds;
    const speechEndTimeoutFloat = baseGoogleConfig.voiceActivityTimeout.speechEndTimeoutSeconds;

    if (typeof speechStartTimeoutFloat === 'number' && speechStartTimeoutFloat > 0) {
      googleVADConfig.speechStartTimeout = {
        seconds: Math.floor(speechStartTimeoutFloat),
        nanos: Math.round((speechStartTimeoutFloat - Math.floor(speechStartTimeoutFloat)) * 1e9)
      };
    }

    if (typeof speechEndTimeoutFloat === 'number' && speechEndTimeoutFloat > 0) {
      googleVADConfig.speechEndTimeout = {
        seconds: Math.floor(speechEndTimeoutFloat),
        nanos: Math.round((speechEndTimeoutFloat - Math.floor(speechEndTimeoutFloat)) * 1e9)
      };
    }

    if (Object.keys(googleVADConfig).length > 0) {
      request.config.voiceActivityTimeout = googleVADConfig;
      logger.info('Google VAD timeouts ENABLED with config: %j', googleVADConfig);
    } else {
      logger.info('Google VAD timeouts enabled in app config, but no valid timeout values were provided for Google API.');
    }
  } else {
    logger.info('Google VAD timeouts DISABLED by app configuration (not sending to Google API).');
    delete request.config.voiceActivityTimeout; // Ensure it's not sent if disabled
  }

  logger.debug('Google Speech API Request (config portion): %j', request.config);

  const recognizeStream = speechClient
    .streamingRecognize(request)
    .on('error', (error) => {
      logger.error('Google Speech API recognizeStream Error:', error);
      if (onError) onError(error);
    })
    .on('data', (data) => {
      if (onData) onData(data);
      if (data.speechEventType) {
        logger.info(`Google Speech Event received: ${data.speechEventType}`);
      }
    })
    .on('end', () => {
      logger.info('Google Speech API recognizeStream ended.');
      if (onEnd) onEnd();
    });

  logger.info('Google Speech recognize stream created and event listeners attached.');
  return recognizeStream;
}


/**
 * Transcribes an audio file using Google Cloud Speech-to-Text batch recognition.
 * This is typically used as a fallback if streaming recognition fails, yields no useful results,
 * or for processing pre-recorded audio.
 * @async
 * @param {winston.Logger} logger - Logger instance for logging events and errors related to this transcription.
 * @param {string} filePath - The local path to the audio file to transcribe.
 * @param {string} [languageCodeOverride] - Optional language code (e.g., 'es-US') to override the
 *                                          `defaultLanguageCode` from `baseGoogleConfig`.
 * @param {object} baseGoogleConfig - Base Google Speech configuration object.
 *   @param {string} baseGoogleConfig.encoding - The encoding of the audio data (e.g., 'MULAW', 'LINEAR16').
 *   @param {number} baseGoogleConfig.sampleRateHertz - The sample rate of the audio in Hertz.
 *   @param {string} baseGoogleConfig.defaultLanguageCode - The default language code to use.
 *   @param {boolean} [baseGoogleConfig.profanityFilter=false] - Whether to filter profanities.
 *   @param {boolean} [baseGoogleConfig.enableAutomaticPunctuation=true] - Whether to enable automatic punctuation.
 *   @param {string} [baseGoogleConfig.model='telephony'] - The speech recognition model.
 *   @param {boolean} [baseGoogleConfig.useEnhanced=false] - Whether to use an enhanced model.
 * @returns {Promise<string>} A promise that resolves with the transcribed text as a string.
 *                            Returns an empty string if transcription fails, the file is empty/unreadable,
 *                            or no speech is recognized.
 */
async function transcribeAudioFile(logger, filePath, languageCodeOverride, baseGoogleConfig) {
  logger.info(`Attempting batch transcription for audio file: ${filePath}`);

  let audioBytes;
  try {
    audioBytes = await fs.readFile(filePath);
  } catch (err) {
    logger.error(`Failed to read audio file ${filePath} for batch transcription: ${err.message}`);
    return '';
  }

  if (!audioBytes || audioBytes.length === 0) {
    logger.warn(`Audio file ${filePath} is empty. Skipping batch transcription.`);
    return '';
  }

  const effectiveLanguageCode = languageCodeOverride || baseGoogleConfig.defaultLanguageCode;
  logger.info(`Using language for batch speech: ${effectiveLanguageCode}, Encoding: ${baseGoogleConfig.encoding}, SampleRate: ${baseGoogleConfig.sampleRateHertz}`);

  const request = {
    config: {
      encoding: baseGoogleConfig.encoding,
      sampleRateHertz: baseGoogleConfig.sampleRateHertz,
      languageCode: effectiveLanguageCode,
      maxAlternatives: 1,
      profanityFilter: baseGoogleConfig.profanityFilter,
      enableAutomaticPunctuation: baseGoogleConfig.enableAutomaticPunctuation,
      model: baseGoogleConfig.model,
      useEnhanced: baseGoogleConfig.useEnhanced,
      // Diarization is generally more suited for streaming or longer audio.
      // If diarizationConfig is present in baseGoogleConfig and needed for batch, it could be added here.
      // diarizationConfig: baseGoogleConfig.diarizationConfig,
    },
    audio: {
      content: audioBytes.toString('base64'), // Audio content must be base64 encoded for the REST API like call
    },
  };
  logger.debug('Google Speech Batch API Request (config portion): %j', request.config);

  try {
    logger.info(`Sending batch transcription request to Google Speech for ${filePath}`);
    const [response] = await speechClient.recognize(request);
    logger.debug('Google Speech Batch API Response: %j', response);

    if (response && response.results && response.results.length > 0) {
      const topResult = response.results[0];
      if (topResult.alternatives && topResult.alternatives.length > 0) {
        const transcript = topResult.alternatives[0].transcript;
        if (transcript && transcript.trim().length > 0) {
          logger.info(`Batch transcription successful for ${filePath}. Transcript: "${transcript}"`);
          return transcript;
        } else {
          logger.info(`Batch transcription for ${filePath} resulted in an empty transcript (alternative was empty or whitespace).`);
        }
      } else {
        logger.info(`Batch transcription for ${filePath} returned no alternatives in the top result.`);
      }
    } else {
      logger.info(`Batch transcription for ${filePath} returned no results or results array was empty.`);
    }
  } catch (err) {
    logger.error(`Google Speech API error during batch transcription for ${filePath}: ${err.message}`, err.stack);
  }

  return ''; // Return empty string if no transcript or an error occurred
}

module.exports = {
  createSpeechStream,
  transcribeAudioFile,
};
