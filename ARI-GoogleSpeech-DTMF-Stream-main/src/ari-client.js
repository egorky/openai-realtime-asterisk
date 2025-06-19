/**
 * @fileoverview Main Asterisk ARI client module.
 * Handles ARI connections, Stasis application logic for call processing,
 * speech-to-text integration, VAD, DTMF handling, and configuration management.
 */
const Ari = require('ari-client');
const winston = require('winston');
const dotenv = require('dotenv');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSpeechStream, transcribeAudioFile } = require('./speech-service');
const RtpServer = require('./rtp-server');

/**
 * Asynchronously adds a channel to a bridge with a retry mechanism.
 *
 * @async
 * @function addChannelWithRetry
 * @param {import('ari-client').Bridge} bridge - The bridge object to add the channel to.
 * @param {string} channelId - The ID of the channel to add.
 * @param {winston.Logger} callLogger - The logger instance for call-specific logging.
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {number} retryDelayMs - Delay in milliseconds between retries.
 * @param {string} operationName - A descriptive name for the operation for logging purposes.
 * @returns {Promise<void>} A promise that resolves when the channel is added successfully.
 * @throws {Error} If adding the channel fails after all retries or due to an unexpected error.
 */
async function addChannelWithRetry(bridge, channelId, callLogger, maxRetries, retryDelayMs, operationName) {
  callLogger.info(`[${operationName}] Attempting to add channel ${channelId} to bridge ${bridge.id}.`);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bridge.addChannel({ channel: channelId });
      callLogger.info(`[${operationName}] Successfully added channel ${channelId} to bridge ${bridge.id} on attempt ${attempt}.`);
      return;
    } catch (error) {
      callLogger.warn(`[${operationName}] Attempt ${attempt} to add channel ${channelId} to bridge ${bridge.id} failed: ${error.message}`);
      if (error.message.includes("Channel not in Stasis application") && attempt < maxRetries) {
        callLogger.info(`[${operationName}] Retrying in ${retryDelayMs}ms... (Attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      } else {
        callLogger.error(`[${operationName}] Final attempt to add channel ${channelId} to bridge ${bridge.id} failed or error not retryable. Error: ${error.message}`);
        throw error; // Re-throw the error if max retries reached or error is not the specific one
      }
    }
  }
}

/**
 * Maximum number of RTP packets to buffer for VAD pre-speech audio.
 * Assuming 20ms packets, 300 packets is approx 6 seconds of audio.
 * @const {number}
 */
const MAX_VAD_BUFFER_PACKETS = 300;

dotenv.config();

/**
 * Base configuration loaded from `config/default.json`.
 * This object holds the default settings for the application.
 * @type {object}
 */
let baseConfig;
try {
  const configFile = fs.readFileSync('./config/default.json', 'utf-8');
  baseConfig = JSON.parse(configFile);
} catch (error) {
  console.error('Failed to load config/default.json: ' + error.message);
  process.exit(1);
}

/**
 * Retrieves call-specific configuration by layering defaults, environment variables, and Asterisk channel variables.
 * @async
 * @function getCallSpecificConfig
 * @param {object} channel - The ARI channel object for the current call.
 * @param {object} baseConfig - The base configuration loaded from `default.json`.
 * @param {object} envVars - An object containing environment variables (typically `process.env`).
 * @param {winston.Logger} callLogger - Logger instance specific to the current call for contextual logging.
 * @returns {Promise<object>} A promise that resolves to the call-specific configuration object,
 * structured similarly to `baseConfig` but with values overridden by environment or dialplan variables.
 */
async function getCallSpecificConfig(channel, baseConfig, envVars, callLogger) {
  const callConfig = {
    asterisk: {},
    audio: {},
    appRecognitionConfig: {},
    googleSpeech: { diarizationConfig: {}, enableSpokenPunctuation: {}, enableSpokenEmojis: {} },
    dtmfConfig: {}
  };

  /**
   * Helper to get a configuration value with precedence: Dialplan > Environment > Default.
   * It fetches a variable's value by checking the Asterisk dialplan, then environment variables,
   * and finally falling back to a default value. It also handles type conversion.
   * @async
   * @private
   * @param {string|null} dialplanName - The name of the Asterisk dialplan variable (e.g., 'APP_AUDIO_GREETINGPATH').
   * @param {string|null} envName - The name of the environment variable (e.g., 'AUDIO_GREETING_PATH').
   * @param {*} defaultValue - The default value if not found in dialplan or environment.
   * @param {string} [type='string'] - The expected data type of the variable ('string', 'boolean', 'integer', 'float').
   * @returns {Promise<*>} The resolved configuration value, converted to the specified type.
   */
  const getVar = async (dialplanName, envName, defaultValue, type = 'string') => {
    let value;
    let source = 'default';

    // 1. Try Dialplan
    if (dialplanName) {
      try {
        const varName = (typeof dialplanName === 'object' && dialplanName.variable) ? dialplanName.variable : dialplanName;
        const dpVar = await channel.getChannelVar({ variable: varName });
        if (dpVar && dpVar.value !== undefined && dpVar.value !== null && dpVar.value !== '') {
          value = dpVar.value;
          source = 'dialplan';
        }
      } catch (e) {
        callLogger.debug(`Dialplan variable ${dialplanName} not found or error: ${e.message}`);
      }
    }

    // 2. Try Environment Variable
    if (value === undefined && envName && envVars[envName] !== undefined && envVars[envName] !== '') {
      value = envVars[envName];
      source = 'env';
    }

    // 3. Use Default Value
    if (value === undefined) {
      value = defaultValue;
      source = 'default';
    }

    // Type Conversion
    try {
      if (type === 'boolean') {
        if (typeof value === 'string') {
          value = value.toLowerCase() === 'true' || value === '1';
        } else {
          value = Boolean(value);
        }
      } else if (type === 'integer') {
        value = parseInt(value, 10);
        if (isNaN(value)) throw new Error('Not a valid integer');
      } else if (type === 'float') {
        value = parseFloat(value);
        if (isNaN(value)) throw new Error('Not a valid float');
      } else if (type === 'string') {
        value = value !== null && value !== undefined ? String(value) : String(defaultValue);
      }
    } catch (e) {
        callLogger.warn(`Type conversion error for ${dialplanName || envName}: value='${value}', type='${type}'. Error: ${e.message}. Using default: ${defaultValue}`);
        if (type === 'boolean') value = Boolean(defaultValue);
        else if (type === 'integer') value = parseInt(defaultValue, 10);
        else if (type === 'float') value = parseFloat(defaultValue);
        else value = String(defaultValue);
        source = 'default_after_conversion_error';
    }
    callLogger.debug(`Config var: '${dialplanName || envName}' | Resolved value: '${value}' (type: ${type}) from source: '${source}' (Default was: '${defaultValue}')`);
    return value;
  };

  // Populate asterisk config
  callConfig.asterisk.rtpHostIp = await getVar('APP_ASTERISK_RTPHOSTIP', 'RTP_HOST_IP', (baseConfig.asterisk && baseConfig.asterisk.rtpHostIp) || '127.0.0.1', 'string');

  // Populate audio config
  callConfig.audio.greetingPath = await getVar('APP_AUDIO_GREETINGPATH', 'AUDIO_GREETING_PATH', (baseConfig.audio && baseConfig.audio.greetingPath) || '', 'string');
  callConfig.audio.captureAudioEnabled = await getVar('APP_AUDIO_CAPTUREAUDIOENABLED', 'AUDIO_CAPTURE_ENABLED', (baseConfig.audio && baseConfig.audio.captureAudioEnabled === true), 'boolean');
  callConfig.audio.waitingPath = await getVar('APP_AUDIO_WAITINGPATH', 'AUDIO_WAITING_PATH', (baseConfig.audio && baseConfig.audio.waitingPath) || '', 'string');
  callConfig.audio.captureAudioPath = await getVar('APP_AUDIO_CAPTUREAUDIOPATH', 'AUDIO_CAPTURE_PATH', (baseConfig.audio && baseConfig.audio.captureAudioPath) || './recordings', 'string');
  callConfig.audio.forceWaitingAudio = await getVar('APP_AUDIO_FORCEWAITINGAUDIO', 'AUDIO_FORCE_WAITING_AUDIO', (baseConfig.audio && baseConfig.audio.forceWaitingAudio === true), 'boolean');
  callConfig.audio.waitingAudioMode = await getVar('APP_AUDIO_WAITINGAUDIOMODE', 'AUDIO_WAITING_AUDIO_MODE', (baseConfig.audio && baseConfig.audio.waitingAudioMode) || 'playAndTransfer', 'string');

  // Populate appRecognitionConfig
  callConfig.appRecognitionConfig.bargeInDelaySeconds = await getVar('APP_APPRECOGNITION_BARGEINDELAYSECONDS', 'BARGE_IN_DELAY_SECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.bargeInDelaySeconds) || 0.5, 'float');
  callConfig.appRecognitionConfig.enableFallbackBatchTranscription = await getVar('APP_APPRECOGNITION_ENABLEFALLBACKBATCHTRANSCRIPTION', 'ENABLE_FALLBACK_BATCH_TRANSCRIPTION', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.enableFallbackBatchTranscription === true) || false, 'boolean');
  callConfig.appRecognitionConfig.recognitionActivationMode = await getVar('APP_APPRECOGNITION_RECOGNITIONACTIVATIONMODE', 'RECOGNITION_ACTIVATION_MODE', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.recognitionActivationMode) || "fixedDelay", 'string');
  callConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds = await getVar('APP_APPRECOGNITION_NOSPEECHBEGINTIMEOUTSECONDS', 'NO_SPEECH_BEGIN_TIMEOUT_SECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds) || 5.0, 'float');
  callConfig.appRecognitionConfig.initialGoogleStreamIdleTimeoutSeconds = await getVar('APP_APPRECOGNITION_INITIALGOOGLESTREAMIDLETIMEOUTSECONDS', 'INITIAL_GOOGLE_STREAM_IDLE_TIMEOUT_SECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.initialGoogleStreamIdleTimeoutSeconds) || 10.0, 'float');
  callConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds = await getVar('APP_APPRECOGNITION_SPEECHENDSILENCETIMEOUTSECONDS', 'SPEECH_END_SILENCE_TIMEOUT_SECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds) || 1.5, 'float');
  callConfig.appRecognitionConfig.maxRecognitionDurationSeconds = await getVar('APP_APPRECOGNITION_MAXRECOGNITIONDURATIONSECONDS', 'MAX_RECOGNITION_DURATION_SECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.maxRecognitionDurationSeconds) || 30.0, 'float');
  callConfig.appRecognitionConfig.vadSilenceThresholdMs = await getVar('APP_APPRECOGNITION_VADSILENCETHRESHOLDMS', 'APP_APPRECOGNITION_VADSILENCETHRESHOLDMS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadSilenceThresholdMs) || 2500, 'integer');
  callConfig.appRecognitionConfig.vadTalkThreshold = await getVar('APP_APPRECOGNITION_VADTALKTHRESHOLD', 'APP_APPRECOGNITION_VADTALKTHRESHOLD', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadTalkThreshold) || 256, 'integer');
  callConfig.appRecognitionConfig.vadRecogActivation = await getVar('APP_APPRECOGNITION_VADRECOGACTIVATION', 'APP_APPRECOGNITION_VADRECOGACTIVATION', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadRecogActivation) || "vadMode", 'string');
  callConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds = await getVar('APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS', 'APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds) || 10.0, 'float');
  callConfig.appRecognitionConfig.vadActivationDelaySeconds = await getVar('APP_APPRECOGNITION_VADACTIVATIONDELAYSECONDS', 'APP_APPRECOGNITION_VADACTIVATIONDELAYSECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadActivationDelaySeconds) || 0.0, 'float');
  callConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds = await getVar('APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS', 'APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS', (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds) || 0.0, 'float');

  // Populate googleSpeech config
  const googleSpeechBaseCfg = baseConfig.googleSpeech || {};
  const dtmfBaseConfig = baseConfig.dtmfConfig || {};

  callConfig.googleSpeech.model = await getVar('APP_GOOGLESPEECH_MODEL', 'APP_GOOGLESPEECH_MODEL', googleSpeechBaseCfg.model || '', 'string');
  callConfig.googleSpeech.diarizationConfig.minSpeakerCount = await getVar('APP_GOOGLESPEECH_DIARIZATIONCONFIG_MINSPEAKERCOUNT', 'APP_GOOGLESPEECH_DIARIZATIONCONFIG_MINSPEAKERCOUNT', (googleSpeechBaseCfg.diarizationConfig && googleSpeechBaseCfg.diarizationConfig.minSpeakerCount) || 2, 'integer');
  callConfig.googleSpeech.diarizationConfig.maxSpeakerCount = await getVar('APP_GOOGLESPEECH_DIARIZATIONCONFIG_MAXSPEAKERCOUNT', 'APP_GOOGLESPEECH_DIARIZATIONCONFIG_MAXSPEAKERCOUNT', (googleSpeechBaseCfg.diarizationConfig && googleSpeechBaseCfg.diarizationConfig.maxSpeakerCount) || 6, 'integer');
  callConfig.googleSpeech.diarizationConfig.enableSpeakerDiarization = await getVar('APP_GOOGLESPEECH_DIARIZATIONCONFIG_ENABLESPEAKERDIARIZATION', 'APP_GOOGLESPEECH_DIARIZATIONCONFIG_ENABLESPEAKERDIARIZATION', (googleSpeechBaseCfg.diarizationConfig && googleSpeechBaseCfg.diarizationConfig.enableSpeakerDiarization === true) || false, 'boolean');
  callConfig.googleSpeech.enableSpokenPunctuation.value = await getVar('APP_GOOGLESPEECH_ENABLESPOKENPUNCTUATION_VALUE', 'APP_GOOGLESPEECH_ENABLESPOKENPUNCTUATION_VALUE', (googleSpeechBaseCfg.enableSpokenPunctuation && googleSpeechBaseCfg.enableSpokenPunctuation.value === true) || false, 'boolean');
  callConfig.googleSpeech.enableSpokenEmojis.value = await getVar('APP_GOOGLESPEECH_ENABLESPOKENEMOJIS_VALUE', 'APP_GOOGLESPEECH_ENABLESPOKENEMOJIS_VALUE', (googleSpeechBaseCfg.enableSpokenEmojis && googleSpeechBaseCfg.enableSpokenEmojis.value === true) || false, 'boolean');

  // Special handling for languageCode
  const channelLang = await channel.getChannelVar({ variable: 'CHANNEL(language)' }).then(v => v.value).catch(() => null);
  const envAppDefaultLang = envVars['APP_GOOGLESPEECH_DEFAULTLANGUAGECODE'];
  const envDefaultLang = envVars['DEFAULT_LANGUAGE_CODE'];
  const baseDefaultLang = googleSpeechBaseCfg.defaultLanguageCode;

  if (channelLang && channelLang.trim() !== '') {
    callConfig.googleSpeech.languageCode = channelLang;
    callLogger.debug(`Config var: 'googleSpeech.languageCode' | Resolved value: '${channelLang}' from source: 'dialplan (CHANNEL(language))'`);
  } else if (envAppDefaultLang && envAppDefaultLang.trim() !== '') {
    callConfig.googleSpeech.languageCode = envAppDefaultLang;
    callLogger.debug(`Config var: 'googleSpeech.languageCode' | Resolved value: '${envAppDefaultLang}' from source: 'env (APP_GOOGLESPEECH_DEFAULTLANGUAGECODE)'`);
  } else if (envDefaultLang && envDefaultLang.trim() !== '') {
    callConfig.googleSpeech.languageCode = envDefaultLang;
    callLogger.debug(`Config var: 'googleSpeech.languageCode' | Resolved value: '${envDefaultLang}' from source: 'env (DEFAULT_LANGUAGE_CODE)'`);
  } else if (baseDefaultLang && baseDefaultLang.trim() !== '') {
    callConfig.googleSpeech.languageCode = baseDefaultLang;
    callLogger.debug(`Config var: 'googleSpeech.languageCode' | Resolved value: '${baseDefaultLang}' from source: 'baseConfig'`);
  } else {
    callConfig.googleSpeech.languageCode = 'en-US'; // Ultimate default
    callLogger.debug(`Config var: 'googleSpeech.languageCode' | Resolved value: 'en-US' from source: 'ultimate_default'`);
  }

  callConfig.googleSpeech.defaultLanguageCode = await getVar('APP_GOOGLESPEECH_DEFAULTLANGUAGECODE', 'APP_GOOGLESPEECH_DEFAULTLANGUAGECODE', googleSpeechBaseCfg.defaultLanguageCode || 'en-US', 'string');
  callConfig.googleSpeech.useEnhanced = await getVar('APP_GOOGLESPEECH_USEENHANCED', 'APP_GOOGLESPEECH_USEENHANCED', googleSpeechBaseCfg.useEnhanced === true, 'boolean');
  callConfig.googleSpeech.separateRecognitionPerChannel = await getVar('APP_GOOGLESPEECH_SEPARATERECOGNITIONPERCHANNEL', 'APP_GOOGLESPEECH_SEPARATERECOGNITIONPERCHANNEL', googleSpeechBaseCfg.separateRecognitionPerChannel === true, 'boolean');
  callConfig.googleSpeech.encoding = await getVar('APP_GOOGLESPEECH_ENCODING', 'APP_GOOGLESPEECH_ENCODING', googleSpeechBaseCfg.encoding || 'MULAW', 'string');
  callConfig.googleSpeech.sampleRateHertz = await getVar('APP_GOOGLESPEECH_SAMPLERATEHERTZ', 'APP_GOOGLESPEECH_SAMPLERATEHERTZ', googleSpeechBaseCfg.sampleRateHertz || 8000, 'integer');
  callConfig.googleSpeech.audioChannelCount = await getVar('APP_GOOGLESPEECH_AUDIOCHANNELCOUNT', 'APP_GOOGLESPEECH_AUDIOCHANNELCOUNT', googleSpeechBaseCfg.audioChannelCount || 1, 'integer');
  callConfig.googleSpeech.enableAutomaticPunctuation = await getVar('APP_GOOGLESPEECH_ENABLEAUTOMATICPUNCTUATION', 'APP_GOOGLESPEECH_ENABLEAUTOMATICPUNCTUATION', googleSpeechBaseCfg.enableAutomaticPunctuation === true, 'boolean');
  callConfig.googleSpeech.enableWordTimeOffsets = await getVar('APP_GOOGLESPEECH_ENABLEWORDTIMEOFFSETS', 'APP_GOOGLESPEECH_ENABLEWORDTIMEOFFSETS', googleSpeechBaseCfg.enableWordTimeOffsets === true, 'boolean');
  callConfig.googleSpeech.enableWordConfidence = await getVar('APP_GOOGLESPEECH_ENABLEWORDCONFIDENCE', 'APP_GOOGLESPEECH_ENABLEWORDCONFIDENCE', googleSpeechBaseCfg.enableWordConfidence === true, 'boolean');
  callConfig.googleSpeech.interimResults = await getVar('APP_GOOGLESPEECH_INTERIMRESULTS', 'GOOGLE_SPEECH_INTERIMRESULTS', googleSpeechBaseCfg.interimResults === true, 'boolean');
  callConfig.googleSpeech.singleUtterance = await getVar('APP_GOOGLESPEECH_SINGLEUTTERANCE', 'GOOGLE_SPEECH_SINGLEUTTERANCE', googleSpeechBaseCfg.singleUtterance === true, 'boolean');
  callConfig.googleSpeech.enableVoiceActivityEvents = await getVar('APP_GOOGLESPEECH_ENABLEVOICEACTIVITYEVENTS', 'GOOGLE_SPEECH_ENABLEVOICEACTIVITYEVENTS', googleSpeechBaseCfg.enableVoiceActivityEvents === true, 'boolean');
  callConfig.googleSpeech.maxAlternatives = await getVar('APP_GOOGLESPEECH_MAXALTERNATIVES', 'GOOGLE_SPEECH_MAXALTERNATIVES', googleSpeechBaseCfg.maxAlternatives || 1, 'integer');
  callConfig.googleSpeech.profanityFilter = await getVar('APP_GOOGLESPEECH_PROFANITYFILTER', 'GOOGLE_SPEECH_PROFANITYFILTER', googleSpeechBaseCfg.profanityFilter === true, 'boolean');
  callConfig.googleSpeech.credentialsPath = await getVar('APP_GOOGLESPEECH_CREDENTIALSPATH', 'GOOGLE_CREDENTIALS_PATH', googleSpeechBaseCfg.credentialsPath || (envVars['GOOGLE_APPLICATION_CREDENTIALS'] || ''), 'string');
  callConfig.googleSpeech.enableVoiceActivityTimeout = await getVar('APP_GOOGLESPEECH_ENABLEVOICEACTIVITYTIMEOUT', 'GOOGLE_SPEECH_ENABLEVOICEACTIVITYTIMEOUT', googleSpeechBaseCfg.enableVoiceActivityTimeout === true, 'boolean');
  callConfig.googleSpeech.voiceActivityTimeout = {};
  callConfig.googleSpeech.voiceActivityTimeout.speechStartTimeoutSeconds = await getVar('APP_GOOGLESPEECH_VOICEACTIVITYTIMEOUT_SPEECHSTARTTIMEOUTSECONDS', 'GOOGLE_SPEECH_VOICEACTIVITYTIMEOUT_SPEECHSTARTTIMEOUTSECONDS', (googleSpeechBaseCfg.voiceActivityTimeout && googleSpeechBaseCfg.voiceActivityTimeout.speechStartTimeoutSeconds) || 10.0, 'float');
  callConfig.googleSpeech.voiceActivityTimeout.speechEndTimeoutSeconds = await getVar('APP_GOOGLESPEECH_VOICEACTIVITYTIMEOUT_SPEECHENDTIMEOUTSECONDS', 'GOOGLE_SPEECH_VOICEACTIVITYTIMEOUT_SPEECHENDTIMEOUTSECONDS', (googleSpeechBaseCfg.voiceActivityTimeout && googleSpeechBaseCfg.voiceActivityTimeout.speechEndTimeoutSeconds) || 1.5, 'float');

  // Populate dtmfConfig
  callConfig.dtmfConfig.enableDtmfRecognition = await getVar('APP_DTMF_ENABLED', 'DTMF_ENABLED', dtmfBaseConfig.hasOwnProperty('enableDtmfRecognition') ? dtmfBaseConfig.enableDtmfRecognition : true, 'boolean');
  callLogger.debug(`DTMF Config: enableDtmfRecognition set to ${callConfig.dtmfConfig.enableDtmfRecognition}`);
  callConfig.dtmfConfig.dtmfInterDigitTimeoutSeconds = await getVar('APP_DTMF_INTERDIGITTIMEOUTSECONDS', 'DTMF_INTERDIGIT_TIMEOUT_SECONDS', dtmfBaseConfig.hasOwnProperty('dtmfInterDigitTimeoutSeconds') ? dtmfBaseConfig.dtmfInterDigitTimeoutSeconds : 3.0, 'float');
  callLogger.debug(`DTMF Config: dtmfInterDigitTimeoutSeconds set to ${callConfig.dtmfConfig.dtmfInterDigitTimeoutSeconds}`);
  callConfig.dtmfConfig.dtmfFinalTimeoutSeconds = await getVar('APP_DTMF_FINALTIMEOUTSECONDS', 'DTMF_FINAL_TIMEOUT_SECONDS', dtmfBaseConfig.hasOwnProperty('dtmfFinalTimeoutSeconds') ? dtmfBaseConfig.dtmfFinalTimeoutSeconds : 5.0, 'float');
  callLogger.debug(`DTMF Config: dtmfFinalTimeoutSeconds set to ${callConfig.dtmfConfig.dtmfFinalTimeoutSeconds}`);

  return callConfig;
}

/**
 * Global logging configuration.
 * Defines default logging levels and enablement for console and file transports.
 * @type {{level: string, enabled: boolean, fileLoggingEnabled?: boolean, filePath?: string, fileLevel?: string}}
 */
const loggingConfig = {
  level: process.env.LOG_LEVEL || baseConfig.logging.level || 'info',
  enabled: baseConfig.logging && baseConfig.logging.enabled !== undefined ? baseConfig.logging.enabled : true,
};

// Validate Console Log Level
const consoleLogConfigLevel = process.env.LOG_LEVEL || (baseConfig.logging && baseConfig.logging.level);
const validatedConsoleLogLevel = (consoleLogConfigLevel && typeof winston.config.npm.levels[consoleLogConfigLevel] === 'number')
                               ? consoleLogConfigLevel
                               : 'info';
loggingConfig.level = validatedConsoleLogLevel;

// File Logging Configuration
const rawFileLoggingEnabled = process.env.LOG_FILE_ENABLED || (baseConfig.logging && baseConfig.logging.fileLoggingEnabled);
const fileLoggingEnabled = typeof rawFileLoggingEnabled === 'string'
                           ? rawFileLoggingEnabled.toLowerCase() === 'true'
                           : rawFileLoggingEnabled === true;

const logFilePath = process.env.LOG_FILE_PATH ||
                    (baseConfig.logging && baseConfig.logging.filePath) ||
                    './app.log';

const rawLogFileLevel = process.env.LOG_FILE_LEVEL || (baseConfig.logging && baseConfig.logging.fileLevel);
const validatedLogFileLevel = (rawLogFileLevel && typeof winston.config.npm.levels[rawLogFileLevel] === 'number')
                            ? rawLogFileLevel
                            : 'info';
loggingConfig.fileLoggingEnabled = fileLoggingEnabled; // Store effective boolean
loggingConfig.filePath = logFilePath;
loggingConfig.fileLevel = validatedLogFileLevel;


/**
 * Winston logger transports configuration.
 * Includes a console transport and an optional file transport based on `loggingConfig`.
 * @type {Array<winston.transport>}
 */
const loggerTransports = [
  new winston.transports.Console({
    silent: !(loggingConfig.enabled === true),
    level: loggingConfig.level
  })
];

/**
 * @type {boolean}
 * @description Flag indicating if file logging was successfully initialized.
 */
let actualFileLoggingSuccessfullyInitialized = false;
if (loggingConfig.fileLoggingEnabled) {
  try {
    const logDir = path.dirname(loggingConfig.filePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`Log directory created: ${logDir}`);
    }
    fs.accessSync(logDir, fs.constants.W_OK);

    loggerTransports.push(
      new winston.transports.File({
        filename: loggingConfig.filePath,
        level: loggingConfig.fileLevel,
      })
    );
    actualFileLoggingSuccessfullyInitialized = true;
  } catch (err) {
    console.error(`Error setting up file logging for ${loggingConfig.filePath} (check permissions/path): ${err.message}. File logging will be disabled.`);
  }
}

// Determine overall logger level based on active transports
const activeLevels = [];
if (loggingConfig.enabled === true) {
    activeLevels.push(loggingConfig.level);
}
if (actualFileLoggingSuccessfullyInitialized === true) {
    activeLevels.push(loggingConfig.fileLevel);
}

/**
 * @type {string}
 * @description The most verbose logging level among all active transports.
 */
let overallLogLevel = 'info';
if (activeLevels.length > 0) {
    activeLevels.sort((a, b) => winston.config.npm.levels[a] - winston.config.npm.levels[b]); // Sorts from most verbose to least
    overallLogLevel = activeLevels[0]; // The first one is the most verbose (lowest numerical value)
}

/**
 * Main application logger instance.
 * Configured with console and optional file transport.
 * Its level is set to the most verbose among enabled transports.
 * @type {winston.Logger}
 */
const logger = winston.createLogger({
  level: overallLogLevel,
  // format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: loggerTransports,
});

// Custom formatter to preprocess GOOGLE_DATA_PAYLOAD messages
const customGoogleDataFormatter = winston.format((info) => {
  if (info.message === 'GOOGLE_DATA_PAYLOAD' && info.googleResponse) {
    info.processedGooglePayload = true;
    info.rawGoogleResponse = JSON.stringify(info.googleResponse, null, 2);
    // Keep original message, level, timestamp, callId, callerNumber for the printf formatter
  }
  return info;
})();

// Custom printf formatter to handle the final output
const customPrintf = winston.format.printf(info => {
  if (info.processedGooglePayload) {
    const { timestamp, level, callId, callerNumber, message, rawGoogleResponse } = info;
    let logString = `${timestamp} ${level.toUpperCase()}`;
    if (callId) logString += ` [callId: ${callId}]`;
    if (callerNumber) logString += ` [callerNumber: ${callerNumber}]`;
    logString += `: ${message}${os.EOL}${rawGoogleResponse}`;
    return logString;
  }

  // Default JSON-like formatting for other messages
  // Collect all properties except the ones we handle specially or are Winston internals
  const { level, message, timestamp, processedGooglePayload, rawGoogleResponse, ...rest } = info;
  const metadata = { ...rest }; // This will include callId, callerNumber from child loggers

  // Reconstruct a JSON string similar to winston.format.json()
  // Ensure consistent order of fields for better readability if possible, though not strictly necessary
  const output = {
    level: level.toUpperCase(),
    message,
    ...metadata, // Spread child logger metadata here
    timestamp,
  };
  return JSON.stringify(output);
});

// Apply the new format
logger.format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }), // Automatically include stack traces
  customGoogleDataFormatter,
  winston.format.splat(), // Handles %s, %d, etc.
  customPrintf
);

logger.info(`Global logger initialized. Console logging effective level: ${loggingConfig.enabled ? loggingConfig.level : 'disabled'}.`);
if (actualFileLoggingSuccessfullyInitialized) {
    logger.info(`File logging enabled: Writing to ${loggingConfig.filePath} at level ${loggingConfig.fileLevel}`);
} else if (loggingConfig.fileLoggingEnabled && !actualFileLoggingSuccessfullyInitialized) {
    logger.warn(`File logging was configured to be enabled but failed to initialize. Check previous console errors for details. Path: ${loggingConfig.filePath}`);
} else {
    logger.info('File logging is disabled by configuration.');
}

if (!(loggingConfig.enabled === true) && !actualFileLoggingSuccessfullyInitialized) {
  console.log('All logging (console and file) is disabled or failed to initialize.');
}

/**
 * Global Asterisk ARI connection configuration.
 * Loaded from environment variables or `baseConfig`.
 * @type {{ariUrl: string, ariUsername: string, ariPassword: string, ariAppName: string, rtpHostIp: string}}
 */
const asteriskConfig = {
  ariUrl: process.env.ASTERISK_ARI_URL || baseConfig.asterisk.ariUrl,
  ariUsername: process.env.ASTERISK_ARI_USERNAME || baseConfig.asterisk.ariUsername,
  ariPassword: process.env.ASTERISK_ARI_PASSWORD || baseConfig.asterisk.ariPassword,
  ariAppName: process.env.ASTERISK_ARI_APP_NAME || baseConfig.asterisk.ariAppName,
  rtpHostIp: process.env.RTP_HOST_IP || baseConfig.asterisk.rtpHostIp || '127.0.0.1',
};

/**
 * Global audio settings (defaults that can be overridden per call).
 * Loaded from environment variables or `baseConfig`.
 * @type {{greetingPath: string, waitingPath: string, captureAudioEnabled: boolean, captureAudioPath: string}}
 */
const audioConfig = {
  greetingPath: process.env.AUDIO_GREETING_PATH || baseConfig.audio.greetingPath,
  waitingPath: process.env.AUDIO_WAITING_PATH || (baseConfig.audio && baseConfig.audio.waitingPath) || '',
  captureAudioEnabled: process.env.AUDIO_CAPTURE_ENABLED === 'true' || baseConfig.audio.captureAudioEnabled === true,
  captureAudioPath: process.env.AUDIO_CAPTURE_PATH || baseConfig.audio.captureAudioPath || './recordings',
};

/**
 * Global application recognition behavior settings (defaults that can be overridden per call).
 * Loaded from environment variables or `baseConfig`.
 * @type {object}
 */
const appRecognitionConfig = {
    recognitionActivationMode: process.env.RECOGNITION_ACTIVATION_MODE || baseConfig.appRecognitionConfig.recognitionActivationMode || "fixedDelay",
    bargeInDelaySeconds: parseFloat(process.env.BARGE_IN_DELAY_SECONDS || baseConfig.appRecognitionConfig.bargeInDelaySeconds || '0.5'),
    noSpeechBeginTimeoutSeconds: parseFloat(process.env.NO_SPEECH_BEGIN_TIMEOUT_SECONDS || baseConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds || '5.0'),
    initialGoogleStreamIdleTimeoutSeconds: parseFloat(process.env.INITIAL_GOOGLE_STREAM_IDLE_TIMEOUT_SECONDS || baseConfig.appRecognitionConfig.initialGoogleStreamIdleTimeoutSeconds || '10.0'),
    speechEndSilenceTimeoutSeconds: parseFloat(process.env.SPEECH_END_SILENCE_TIMEOUT_SECONDS || baseConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds || '1.5'),
    maxRecognitionDurationSeconds: parseFloat(process.env.MAX_RECOGNITION_DURATION_SECONDS || baseConfig.appRecognitionConfig.maxRecognitionDurationSeconds || '30.0'),
    enableFallbackBatchTranscription: process.env.ENABLE_FALLBACK_BATCH_TRANSCRIPTION === 'true' || (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.enableFallbackBatchTranscription === true) || false,
    vadSilenceThresholdMs: parseInt(process.env.APP_APPRECOGNITION_VADSILENCETHRESHOLDMS || (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadSilenceThresholdMs) || '2500', 10),
    vadTalkThreshold: parseInt(process.env.APP_APPRECOGNITION_VADTALKTHRESHOLD || (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadTalkThreshold) || '256', 10),
    vadRecogActivation: process.env.APP_APPRECOGNITION_VADRECOGACTIVATION || (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadRecogActivation) || "vadMode",
    vadMaxWaitAfterPromptSeconds: parseFloat(process.env.APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS || (baseConfig.appRecognitionConfig && baseConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds) || '10.0'),
    // vadInitialSilenceDelaySeconds and vadActivationDelaySeconds are primarily resolved per-call in getCallSpecificConfig
};

/**
 * Base Google Speech configuration (defaults that can be overridden per call).
 * This is a direct reference to the `googleSpeech` section of `baseConfig`.
 * @type {object}
 */
const googleSpeechBaseConfig = baseConfig.googleSpeech;

// Ensure audio capture directory exists if enabled globally
if (audioConfig.captureAudioEnabled) {
    try { fs.mkdirSync(audioConfig.captureAudioPath, { recursive: true }); }
    catch (e) { logger.error(`Failed to create audio capture directory ${audioConfig.captureAudioPath}: ${e.message}`); audioConfig.captureAudioEnabled = false; }
}

logger.info(`Logger initialized at level: ${loggingConfig.level}`);
// Log global (non-call-specific) parts of appRecognitionConfig here
logger.info(`App Recognition Config (Global Defaults): Mode=${appRecognitionConfig.recognitionActivationMode}, BargeInDelay=${appRecognitionConfig.bargeInDelaySeconds}s, NoSpeechBeginTimeout=${appRecognitionConfig.noSpeechBeginTimeoutSeconds}s, InitialGoogleStreamIdle=${appRecognitionConfig.initialGoogleStreamIdleTimeoutSeconds}s, EndSilenceTimeout=${appRecognitionConfig.speechEndSilenceTimeoutSeconds}s, MaxDuration=${appRecognitionConfig.maxRecognitionDurationSeconds}s, EnableFallbackBatch=${appRecognitionConfig.enableFallbackBatchTranscription}, VADSilenceMs=${appRecognitionConfig.vadSilenceThresholdMs}, VADTalkThreshold=${appRecognitionConfig.vadTalkThreshold}, VADRecogActivation=${appRecognitionConfig.vadRecogActivation}, VADMaxWaitPromptSec=${appRecognitionConfig.vadMaxWaitAfterPromptSeconds}`);
if (audioConfig.captureAudioEnabled) { logger.info(`AUDIO CAPTURE ENABLED (Global Default): Path=${audioConfig.captureAudioPath}`); }

if (appRecognitionConfig.enableFallbackBatchTranscription && !audioConfig.captureAudioEnabled) {
    logger.warn("FallbackBatchTranscription is enabled (Global Default), but captureAudioEnabled is false (Global Default). Fallback will not function unless overridden per call. Please enable audio capture.");
}

/**
 * Initializes the ARI client, connects to Asterisk, and sets up event handlers for the Stasis application.
 * @async
 * @function initAriClient
 * @param {AppObject} app - The main application object to store the ARI client instance.
 * @throws {Error} If connection to ARI fails.
 */
async function initAriClient(app) {
  try {
    logger.info(`Connecting to ARI: ${asteriskConfig.ariUrl}, App: ${asteriskConfig.ariAppName}`);
    const client = await Ari.connect(asteriskConfig.ariUrl, asteriskConfig.ariUsername, asteriskConfig.ariPassword);
    logger.info('ARI connection successful.');
    app.ariClient = client;
    /**
     * Set of active external media channel IDs to prevent processing them as new calls.
     * Used because snoop channels and external media channels also trigger StasisStart.
     * @type {Set<string>}
     */
    const activeExternalMediaChannelIds = new Set();

    /**
     * Handles the StasisStart event from ARI, triggered when a new call enters the Stasis application.
     * This is the main entry point for call processing logic, including setting up media,
     * handling VAD, DTMF, speech recognition, and cleanup.
     * @param {object} event - The StasisStart event object from ARI.
     * @param {import('ari-client').Channel} channel - The ARI channel object representing the incoming call.
     * @listens StasisStart
     */
    client.on('StasisStart', async (event, channel) => {
      const callerIdNumber = (event.channel.caller && event.channel.caller.number) ? event.channel.caller.number : 'Unknown';
      /**
       * Logger instance specific to this call, including callId and callerNumber.
       * @type {winston.Logger}
       */
      const callLogger = logger.child({ callId: channel.id, callerNumber: callerIdNumber });

      const callConfig = await getCallSpecificConfig(channel, baseConfig, process.env, callLogger);
      callLogger.info("Call specific config loaded: %j", callConfig);

      if (!callConfig.dtmfConfig.enableDtmfRecognition) {
        callLogger.info('DTMF recognition is disabled by configuration for this call.');
      }

      const callerIdForFile = (event.channel.caller && event.channel.caller.number) ? event.channel.caller.number.replace(/[^a-zA-Z0-9.-]/g, '_') : channel.id.replace(/[^a-zA-Z0-9.-]/g, '_');
      callLogger.info(`StasisStart: Name: ${channel.name}, Caller: ${callerIdNumber} (file ID: ${callerIdForFile}), App: ${event.application}`);

      // Ignore calls from snoop channels or UnicastRTP (our own external media channels)
      if (channel.name.startsWith('UnicastRTP/') || activeExternalMediaChannelIds.has(channel.id) || (!event.channel.caller || !event.channel.caller.number)) {
        callLogger.debug(`StasisStart for non-primary/media channel ${channel.id}. Answering if needed and ignoring further processing.`);
        try { if (channel.state === 'RINGING' || channel.state === 'RING') await channel.answer(); } catch (e) { /* ignore if already answered or hung up */ }
        return;
      }

      // Initialize call-specific state variables
      /** @type {RtpServer|null} Instance of the RTP server for receiving audio. */
      let rtpServer = null;
      /** @type {import('ari-client').Channel|null} External media channel used for RTP. */
      let externalMediaChannel = null;
      /** @type {import('stream').Writable|null} Google Speech API stream. */
      let speechStream = null;
      /** @type {import('ari-client').Bridge|null} Bridge for the user channel and playback. */
      let user_bridge = null;
      /** @type {import('ari-client').Channel|null} Snoop channel for capturing audio. */
      let snoop_channel = null;
      /** @type {import('ari-client').Bridge|null} Bridge for snoop and external media channels. */
      let snoop_bridge = null;
      /** @type {import('ari-client').Playback|null} Main playback object for greetings. */
      let mainPlayback = null;
      /** @type {import('ari-client').Playback|null} Playback object for waiting audio during fallback. */
      let waitingPlayback = null; // For fallback waiting audio
      /** @type {import('ari-client').Playback|null} Playback object for forced waiting audio post-recognition. */
      let postRecognitionWaitingPlayback = null; // For forced waiting audio
      /** @type {string} Stores the final transcription result. */
      let finalTranscription = '';
      /** @type {string} Stores the last interim transcription result. */
      let lastInterimTranscription = '';
      /** @type {boolean} Flag indicating if the main prompt playback was stopped due to an interim result or speech activity. */
      let promptPlaybackStoppedForInterim = false;
      /** @type {boolean} Flag indicating if fallback batch transcription has been attempted. */
      let fallbackAttempted = false;
      /** @type {Error|null} Stores any error from the Google Speech stream. */
      let googleStreamError = null;
      /** @type {boolean} Flag indicating if Google streaming is currently active. */
      let googleStreamingActive = false;
      /** @type {boolean} Flag indicating if the Google Speech stream is in the process of ending gracefully. */
      let isGoogleStreamEnding = false;
      /** @type {fs.WriteStream|null} File stream for capturing raw audio. */
      let audioFileStream = null;
      /** @type {string} Path to the captured audio file. */
      let audioFilePath = '';
      /** @type {string} Language code used for the current speech recognition session. */
      let languageForSpeech = callConfig.googleSpeech.languageCode || 'en-US';

      // VAD specific state
      /** @type {boolean} Flag indicating if speech has been detected by VAD (Asterisk's ChannelTalkingStarted). */
      let vadSpeechDetected = false;
      /** @type {Function|null} Handler for the ChannelTalkingStarted event. */
      let channelTalkingStartedHandler = null;
      /** @type {Function|null} Handler for the ChannelTalkingFinished event. */
      let channelTalkingFinishedHandler = null;
      /** @type {Array<Buffer>} Buffer for storing audio packets during VAD before Google stream activation. */
      let vadAudioBuffer = [];
      /** @type {boolean} Flag indicating if VAD audio buffering is currently active. */
      let isVADBufferingActive = false;
      /** @type {boolean} Flag indicating if the VAD audio buffer is currently being flushed to Google Speech. */
      let isFlushingVADBuffer = false;
      /** @type {boolean} Flag indicating that the VAD buffer should be flushed once Google Speech signals readiness (e.g., SPEECH_ACTIVITY_BEGIN). */
      let pendingVADBufferFlush = false;
      /** @type {NodeJS.Timeout|null} Timer for VAD max wait after prompt. */
      let vadMaxWaitAfterPromptTimer = null;
      /** @type {NodeJS.Timeout|null} Timer for the VAD general activation delay. */
      let vadActivationDelayTimer = null;
      /** @type {boolean} Flag indicating if the general VAD activation delay has completed. */
      let vadActivationDelayCompleted = false;
      /** @type {NodeJS.Timeout|null} Timer for the VAD initial silence delay from call start. */
      let vadInitialSilenceDelayTimer = null;
      /** @type {boolean} Flag indicating if the VAD initial silence delay has completed. */
      let vadInitialSilenceDelayCompleted = false;
      /** @type {boolean} Flag indicating if speech became active (ChannelTalkingStarted) during an active VAD delay period and did not explicitly finish (ChannelTalkingFinished) during a VAD delay. */
      let vadSpeechActiveDuringDelay = false;
      /**
       * @type {boolean}
       * @description Flag to ensure that VAD-based recognition (either via ChannelTalkingStarted or 'afterPrompt' logic)
       * is triggered only once after all initial VAD delays (vadInitialSilenceDelaySeconds, vadActivationDelaySeconds) have been processed.
       * Prevents redundant activations if multiple qualifying VAD events or conditions occur.
       */
      let vadRecognitionTriggeredAfterInitialDelay = false;

      // Application timers
      /** @type {NodeJS.Timeout|null} Timer for barge-in activation in fixedDelay mode. */
      let bargeInActivationTimer = null;
      /** @type {NodeJS.Timeout|null} Timer for detecting no speech after Google stream starts. */
      let noSpeechBeginTimer = null;
      /** @type {NodeJS.Timeout|null} Timer for detecting if Google stream is idle after connection. */
      let initialGoogleStreamIdleTimer = null;
      /** @type {NodeJS.Timeout|null} Timer for detecting silence after speech ends to finalize transcription. */
      let speechEndSilenceTimer = null;
      /** @type {NodeJS.Timeout|null} Timer for the maximum allowed duration of the recognition attempt. */
      let maxRecognitionDurationTimer = null;

      /** @type {boolean} Flag indicating if speech activity has begun (either via Google's SPEECH_ACTIVITY_BEGIN or an interim result). */
      let speechHasBegun = false;
      /** @type {boolean} Flag to prevent multiple invocations of fullCleanup. */
      let isCleanupCalled = false;
      // let callerChannelBridged = false; // This variable seems unused, consider removing if confirmed.

      // DTMF specific state
      /** @type {string} Buffer for collecting DTMF digits. */
      let collectedDtmfDigits = '';
      /** @type {NodeJS.Timeout|null} Timer for inter-digit DTMF timeout. */
      let dtmfInterDigitTimer = null;
      /** @type {NodeJS.Timeout|null} Timer for final DTMF input timeout. */
      let dtmfFinalTimer = null;
      /** @type {boolean} Flag indicating if DTMF input mode is currently active. */
      let dtmfModeActive = false;
      /** @type {boolean} Flag indicating if speech recognition has been disabled due to DTMF input. */
      let speechRecognitionDisabledDueToDtmf = false;
      /** @type {boolean} Flag indicating if an active speech recognition stream was interrupted by DTMF. */
      let dtmfInterruptedSpeech = false;

      /**
       * Clears all active application-level timers for the current call.
       * @function cleanupTimers
       * @private
       */
      const cleanupTimers = () => {
        callLogger.debug('cleanupTimers: Clearing all known application-specific timers...');
        if (bargeInActivationTimer) clearTimeout(bargeInActivationTimer); bargeInActivationTimer = null;
        if (noSpeechBeginTimer) clearTimeout(noSpeechBeginTimer); noSpeechBeginTimer = null;
        if (initialGoogleStreamIdleTimer) clearTimeout(initialGoogleStreamIdleTimer); initialGoogleStreamIdleTimer = null;
        if (speechEndSilenceTimer) clearTimeout(speechEndSilenceTimer); speechEndSilenceTimer = null;
        if (maxRecognitionDurationTimer) clearTimeout(maxRecognitionDurationTimer); maxRecognitionDurationTimer = null;
        if (vadActivationDelayTimer) clearTimeout(vadActivationDelayTimer); vadActivationDelayTimer = null;
        if (vadInitialSilenceDelayTimer) clearTimeout(vadInitialSilenceDelayTimer); vadInitialSilenceDelayTimer = null;
        if (vadMaxWaitAfterPromptTimer) { clearTimeout(vadMaxWaitAfterPromptTimer); vadMaxWaitAfterPromptTimer = null; callLogger.debug('Cleared vadMaxWaitAfterPromptTimer in cleanupTimers.');}
        if (dtmfInterDigitTimer) clearTimeout(dtmfInterDigitTimer); dtmfInterDigitTimer = null;
        if (dtmfFinalTimer) clearTimeout(dtmfFinalTimer); dtmfFinalTimer = null;
      };

      /**
       * Performs comprehensive cleanup of all resources associated with the current call.
       * This includes stopping playbacks, destroying streams, bridges, channels, and timers.
       * It also handles setting final channel variables and deciding whether to hang up or continue in dialplan.
       * @async
       * @function fullCleanup
       * @private
       * @param {boolean} [hangup=false] - If true, the main channel will be hung up.
       * @param {string} [reason="normal"] - A reason string for logging the cleanup trigger.
       */
      const fullCleanup = async (hangup = false, reason = "normal") => {
          if (isCleanupCalled) { callLogger.debug(`Cleanup already in progress (reason: ${reason}).`); return; }
          isCleanupCalled = true; // This MUST be the first operation.
          cleanupTimers(); // Call immediately after setting isCleanupCalled.
          callLogger.info(`Cleanup, reason: ${reason}, hangup: ${hangup}. Google Streaming: ${googleStreamingActive}, Speech begun: ${speechHasBegun}`);
          callLogger.debug('Cleanup: All application timers have been cleared via cleanupTimers().');

          // Remove channel-specific listeners to prevent them from firing during/after cleanup
          if (channel) { // Check if channel object exists, it might be destroyed already
            if (channelTalkingStartedHandler) {
                channel.removeListener('ChannelTalkingStarted', channelTalkingStartedHandler);
                callLogger.debug('Attempted removal of ChannelTalkingStarted listener during cleanup.');
            }
            if (channelTalkingFinishedHandler) {
                channel.removeListener('ChannelTalkingFinished', channelTalkingFinishedHandler);
                callLogger.debug('Attempted removal of ChannelTalkingFinished listener during cleanup.');
            }
            // DTMF listener is anonymous, rely on its internal isCleanupCalled check (added in this step).
          }

          isVADBufferingActive = false;
          pendingVADBufferFlush = false;
          if (vadAudioBuffer && vadAudioBuffer.length > 0 && !isFlushingVADBuffer) {
              callLogger.debug(`Clearing ${vadAudioBuffer.length} audio packets from VAD buffer during cleanup (flush was not completed).`);
              vadAudioBuffer = [];
          }
          isFlushingVADBuffer = false;
          // vadMaxWaitAfterPromptTimer is now cleared in cleanupTimers()

          if (mainPlayback && !mainPlayback.destroyed) { try { await mainPlayback.stop(); } catch (e) { if(!e.message.includes("not found")) callLogger.warn(`Cleanup: Error stopping mainPlayback: ${e.message}`); } }
          if (waitingPlayback && !waitingPlayback.destroyed) { try { await waitingPlayback.stop(); } catch (e) { if(!e.message.includes("not found")) callLogger.warn(`Cleanup: Error stopping waitingPlayback: ${e.message}`); } }
          if (postRecognitionWaitingPlayback && !postRecognitionWaitingPlayback.destroyed) {
            callLogger.debug(`Stopping postRecognitionWaitingPlayback (${postRecognitionWaitingPlayback.id}) during cleanup.`);
            try { await postRecognitionWaitingPlayback.stop(); } catch (e) { if(!e.message.includes("not found")) callLogger.warn(`Cleanup: Error stopping postRecognitionWaitingPlayback: ${e.message}`); }
          }
          if (speechStream && !speechStream.destroyed) {
              speechStream.removeAllListeners();
              if (!googleStreamError && speechHasBegun && !hangup && !speechStream.writableEnded &&
                  ["final_transcript_received", "app_speech_end_silence_timeout", "app_silence_after_interim", "google_speech_activity_end"].includes(reason)) {
                  callLogger.info(`Attempting graceful .end() of Google Speech stream (reason: ${reason}).`);
                  try {
                      speechStream.end();
                      callLogger.debug(`speechStream state after .end() in cleanup: writableEnded=${speechStream.writableEnded}, writable=${speechStream.writable}, destroyed=${speechStream.destroyed}`);
                  } catch (se) {
                      callLogger.warn(`Error calling .end() on speechStream during cleanup: ${se.message}. Will attempt destroy.`);
                  }
              }
              if (!speechStream.destroyed) {
                  callLogger.debug(`Preparing to call speechStream.destroy(). State before destroy: writableEnded=${speechStream.writableEnded}, writable=${speechStream.writable}, destroyed=${speechStream.destroyed}, googleError=${!!googleStreamError}, reason=${reason}`);
                  try {
                      speechStream.destroy();
                      callLogger.debug(`speechStream state after .destroy() call: writableEnded=${speechStream.writableEnded}, writable=${speechStream.writable}, destroyed=${speechStream.destroyed}`);
                  } catch (destroyError) {
                      callLogger.warn(`Error calling speechStream.destroy(): ${destroyError.message}. State at error: writableEnded=${speechStream.writableEnded}, writable=${speechStream.writable}, destroyed=${speechStream.destroyed}`);
                  }
              } else {
                  callLogger.debug(`speechStream was already destroyed before explicit destroy step in cleanup.`);
              }
              speechStream = null;
          } else if (speechStream && speechStream.destroyed) {
              callLogger.debug(`speechStream found to be already destroyed at the start of speechStream cleanup block.`);
              speechStream = null;
          }
          googleStreamingActive = false;

        let streamingTranscriptForFallbackCheck = finalTranscription;
        const reasonsToUseInterimAsSuccessfulStreaming = new Set(["google_stream_write_after_end_handled"]);
        if ((!streamingTranscriptForFallbackCheck || streamingTranscriptForFallbackCheck.trim() === '') &&
            lastInterimTranscription && lastInterimTranscription.trim() !== '') {
            if (reasonsToUseInterimAsSuccessfulStreaming.has(reason)) {
                callLogger.info(`Using last interim transcript ('${lastInterimTranscription}') as effective streaming result due to cleanup reason '${reason}'. Fallback to batch might be skipped.`);
                streamingTranscriptForFallbackCheck = lastInterimTranscription;
            }
        }
        const effectivelyEmptyStreamingResultAfterInterimCheck = !streamingTranscriptForFallbackCheck || streamingTranscriptForFallbackCheck.trim() === '';
        const cleanupReasonsForFallback = new Set([
            "app_google_no_final_result_timeout", "app_google_no_final_result_timeout_interim",
            "google_stream_write_after_end_handled", "max_duration_timeout", "google_stream_ended_uncontrolled",
            "app_no_speech_begin_timeout", "app_initial_google_stream_idle_timeout",
            "google_stream_error", "google_stream_critical_error"
        ]);

        if (callConfig.appRecognitionConfig.enableFallbackBatchTranscription && callConfig.audio.captureAudioEnabled &&
            !dtmfModeActive && effectivelyEmptyStreamingResultAfterInterimCheck && audioFilePath &&
            fs.existsSync(audioFilePath) && cleanupReasonsForFallback.has(reason)) {
            if (!fallbackAttempted) {
                fallbackAttempted = true;
                callLogger.info(`Attempting fallback batch transcription (attempt 1). Reason: ${reason}. Streaming transcript was empty.`);
                await tryOfflineRecognition(audioFilePath, languageForSpeech, channel);
                if (finalTranscription && finalTranscription.trim() !== '') {
                    callLogger.info(`Fallback transcription resulted in: "${finalTranscription}"`);
                } else {
                    callLogger.info(`Fallback transcription did not yield a usable result.`);
                    if (!finalTranscription) finalTranscription = '';
                }
            } else {
                callLogger.info(`Fallback batch transcription already attempted. Skipping duplicate attempt.`);
            }
        } else {
            if (callConfig.appRecognitionConfig.enableFallbackBatchTranscription && callConfig.audio.captureAudioEnabled && !fallbackAttempted) {
                if (!effectivelyEmptyStreamingResultAfterInterimCheck) {
                    callLogger.info(`Fallback not attempted. Effective streaming transcript (final or error-interim) was not empty: "${streamingTranscriptForFallbackCheck}"`);
                } else if (!audioFilePath || !fs.existsSync(audioFilePath)) {
                    callLogger.info(`Fallback not attempted. Audio file path invalid ('${audioFilePath}') or file does not exist.`);
                } else if (!cleanupReasonsForFallback.has(reason)) {
                    callLogger.info(`Fallback not attempted. Reason '${reason}' not in designated list for general fallback.`);
                } else if (dtmfModeActive) {
                    callLogger.info('Fallback batch transcription skipped as DTMF input was active.');
                } else {
                     callLogger.info(`Fallback not attempted due to other unmet conditions (DTMF Active: ${dtmfModeActive}, Enabled: ${callConfig.appRecognitionConfig.enableFallbackBatchTranscription}, Capture: ${callConfig.audio.captureAudioEnabled}, EffectiveStreamEmpty: ${effectivelyEmptyStreamingResultAfterInterimCheck}, Path: ${audioFilePath}, Exists: ${audioFilePath ? fs.existsSync(audioFilePath) : 'N/A'}, ReasonOK: ${cleanupReasonsForFallback.has(reason)}).`);
                }
            } else if (callConfig.appRecognitionConfig.enableFallbackBatchTranscription && fallbackAttempted) {
                 // Already logged
            } else if (callConfig.appRecognitionConfig.enableFallbackBatchTranscription && dtmfModeActive) {
                 callLogger.info('Fallback batch transcription skipped as DTMF input was active (and other prerequisites may or may not have been met).');
            } else if (callConfig.appRecognitionConfig.enableFallbackBatchTranscription) {
                 callLogger.info(`Fallback batch transcription prerequisites (e.g. capture disabled or no audio path) not met. Skipping fallback.`);
            }
        }

        if (fallbackAttempted && channel && !channel.destroyed && callConfig.audio.waitingPath && callConfig.audio.waitingPath.trim() !== '') {
            callLogger.info(`Playing waiting prompt '${callConfig.audio.waitingPath}' while finalizing batch transcription processing.`);
            const localWaitingPlayback = client.Playback();
            const waitingPlaybackPromise = new Promise((resolvePlayback) => {
                let failedListener = null;
                const cleanupWaitingListeners = () => {
                    if (failedListener) client.removeListener('PlaybackFailed', failedListener);
                    localWaitingPlayback.removeListener('PlaybackFinished', onFinished);
                    localWaitingPlayback.removeListener('PlaybackStopped', onStopped);
                };
                const onFinished = () => { callLogger.debug(`Waiting playback ${localWaitingPlayback.id} finished.`); cleanupWaitingListeners(); resolvePlayback(); };
                const onStopped = () => { callLogger.debug(`Waiting playback ${localWaitingPlayback.id} stopped.`); cleanupWaitingListeners(); resolvePlayback(); };
                failedListener = (evt, instance) => {
                    if (instance && instance.id === localWaitingPlayback.id) {
                        callLogger.warn(`Waiting playback ${localWaitingPlayback.id} failed: ${evt.playback ? evt.playback.failure_reason : 'Unknown reason'}`);
                        cleanupWaitingListeners(); resolvePlayback();
                    }
                };
                localWaitingPlayback.once('PlaybackFinished', onFinished);
                localWaitingPlayback.once('PlaybackStopped', onStopped);
                client.on('PlaybackFailed', failedListener);
            });
            try {
                if (channel && !channel.destroyed) {
                    await channel.play({ media: `sound:${callConfig.audio.waitingPath}` }, localWaitingPlayback);
                    await waitingPlaybackPromise;
                } else {
                     callLogger.warn(`Channel became invalid before waiting prompt could be played.`);
                }
            } catch (playError) {
                callLogger.warn(`Error initiating waiting prompt: ${playError.message}`);
            }
        }

          const interimFallbackReasons = new Set([
              "google_stream_write_after_end_handled", "app_google_no_final_result_timeout",
              "app_google_no_final_result_timeout_interim", "max_duration_timeout",
              "google_stream_ended_uncontrolled", "app_initial_google_stream_idle_timeout",
              "app_no_speech_begin_timeout", "app_speech_end_silence_timeout",
              "google_stream_error_post_graceful_end", "google_stream_error_post_graceful_end_general"
          ]);

          if (channel && !channel.destroyed) {
              let transcriptionToSet = finalTranscription;
              if (!transcriptionToSet && lastInterimTranscription) {
                  callLogger.info(`Final transcript empty. Reason for cleanup: '${reason}'. Checking if interim fallback is applicable.`);
                  if (interimFallbackReasons.has(reason)) {
                      callLogger.info(`Using last interim transcript ('${lastInterimTranscription}') as fallback for SPEECH_TEXT due to reason: '${reason}'.`);
                      transcriptionToSet = lastInterimTranscription;
                  } else {
                      callLogger.info(`Interim transcript ('${lastInterimTranscription}') available but reason '${reason}' not in fallback list. SPEECH_TEXT will be empty or use existing value if not final.`);
                  }
              }
              if (transcriptionToSet) {
                  callLogger.info(`Setting SPEECH_TEXT to: "${transcriptionToSet}"`);
                  try { await channel.setChannelVar({ variable: 'SPEECH_TEXT', value: transcriptionToSet }); }
                  catch (e) { callLogger.warn(`Error setting SPEECH_TEXT to "${transcriptionToSet}": ${e.message}`); }
              } else {
                  callLogger.info(`No final or suitable interim transcript available. Setting SPEECH_TEXT to empty string.`);
                  try { await channel.setChannelVar({ variable: 'SPEECH_TEXT', value: '' }); }
                  catch (e) { callLogger.warn('Error setting empty SPEECH_TEXT', e); }
              }
          } else {
              callLogger.warn(`Channel is destroyed or null. Cannot set SPEECH_TEXT.`);
          }

          if (rtpServer) {
              rtpServer.removeAllListeners('audioPacketForGoogle');
              try { await rtpServer.stop(); } catch(e) {callLogger.warn(`Cleanup: Error stopping RTP server`, e);}
              rtpServer = null;
          }
          if (snoop_channel && !snoop_channel.destroyed) {
            try { callLogger.info(`Hanging up snoop channel ${snoop_channel.id} during cleanup.`); await snoop_channel.hangup(); }
            catch (e) { callLogger.warn(`Cleanup: Error hanging up snoop_channel ${snoop_channel.id}`, e); }
            snoop_channel = null;
          }
          if (snoop_bridge) {
            try { if (!snoop_bridge.destroyed) { callLogger.info(`Destroying snoop_bridge ${snoop_bridge.id} during cleanup.`); await snoop_bridge.destroy(); } }
            catch (e) { callLogger.warn(`Cleanup: Error during snoop_bridge cleanup ${snoop_bridge.id}`, e); }
            snoop_bridge = null;
          }
          if (user_bridge) {
            try { if (!user_bridge.destroyed) { callLogger.info(`Destroying user_bridge ${user_bridge.id} during cleanup.`); await user_bridge.destroy(); } }
            catch (e) { callLogger.warn(`Cleanup: Error during user_bridge cleanup ${user_bridge.id}`, e); }
            user_bridge = null;
          }
          if (externalMediaChannel && !externalMediaChannel.destroyed) {
            try { callLogger.info(`Hanging up externalMediaChannel ${externalMediaChannel.id} during cleanup.`); await externalMediaChannel.hangup(); activeExternalMediaChannelIds.delete(externalMediaChannel.id); }
            catch(e) {callLogger.warn(`Cleanup: Error hanging up extMediaChannel`, e);}
            externalMediaChannel = null;
          }
          if (audioFileStream && !audioFileStream.destroyed) { audioFileStream.end(() => callLogger.info(`Audio capture file ${audioFilePath} closed.`)); audioFileStream = null; }
          else if (audioFilePath && !audioFileStream) { callLogger.debug(`Audio capture file ${audioFilePath} was already closed or stream not active.`);}

          if (hangup && channel && !channel.destroyed) {
              callLogger.info(`Hanging up main channel due to ${reason}.`);
              try { await channel.hangup(); } catch (e) {callLogger.warn(`Cleanup: Error hanging up main channel: ${e.message}`);}
          } else if (!hangup && channel && !channel.destroyed) {
              callLogger.info(`Recognition finished (reason: ${reason}). Returning control to Asterisk dialplan.`);
              try {
                if (hangup && callConfig.audio.waitingAudioMode === 'playAndTransfer' && channel && !channel.destroyed) {
                    try {
                        const forcedVar = await channel.getChannelVar({ variable: 'FORCED_WAITING_AUDIO_ACTIVE' });
                        if (forcedVar && forcedVar.value === 'true') {
                            callLogger.debug('Clearing FORCED_WAITING_AUDIO_ACTIVE channel variable due to hangup.');
                            await channel.setChannelVar({ variable: 'FORCED_WAITING_AUDIO_ACTIVE', value: 'false' });
                        }
                    } catch (e) { callLogger.warn(`Error clearing FORCED_WAITING_AUDIO_ACTIVE channel variable during hangup`, e); }
                }
                if (channel && !channel.destroyed && channel.state === 'Up') {
                    if (callConfig.audio.forceWaitingAudio && callConfig.audio.waitingPath && callConfig.audio.waitingPath.trim() !== '') {
                        const rawWaitingPath = callConfig.audio.waitingPath;
                        const audioFiles = rawWaitingPath.split(',').map(file => file.trim()).filter(file => file !== '');
                        if (audioFiles.length === 0) {
                            callLogger.warn("forceWaitingAudio is true, but no valid audio files found in waitingPath after parsing. Skipping post-recognition waiting audio.");
                        } else {
                            const selectedAudioPath = audioFiles[Math.floor(Math.random() * audioFiles.length)];
                            callLogger.info(`Selected post-recognition waiting audio: ${selectedAudioPath} (from list: ${rawWaitingPath}). Mode: ${callConfig.audio.waitingAudioMode}.`);
                            postRecognitionWaitingPlayback = client.Playback();
                            let postRecFailedListener = null;
                            const postRecPlayPromise = new Promise((resolve) => {
                                const cleanupPostRecListeners = () => {
                                    if (postRecFailedListener) client.removeListener('PlaybackFailed', postRecFailedListener);
                                    if (postRecognitionWaitingPlayback) {
                                        postRecognitionWaitingPlayback.removeListener('PlaybackFinished', onPostRecFinished);
                                        postRecognitionWaitingPlayback.removeListener('PlaybackStopped', onPostRecStopped);
                                    }
                                };
                                const onPostRecFinished = () => { callLogger.debug(`Post-recognition waiting playback ${postRecognitionWaitingPlayback ? postRecognitionWaitingPlayback.id : 'N/A'} finished.`); cleanupPostRecListeners(); resolve('finished'); };
                                const onPostRecStopped = () => { callLogger.debug(`Post-recognition waiting playback ${postRecognitionWaitingPlayback ? postRecognitionWaitingPlayback.id : 'N/A'} stopped.`); cleanupPostRecListeners(); resolve('stopped'); };
                                postRecFailedListener = (evt, instance) => {
                                    if (instance && postRecognitionWaitingPlayback && instance.id === postRecognitionWaitingPlayback.id) {
                                        callLogger.warn(`Post-recognition waiting playback ${postRecognitionWaitingPlayback.id} failed: ${evt.playback ? evt.playback.failure_reason : 'Unknown reason'}`);
                                        cleanupPostRecListeners(); resolve('failed');
                                    }
                                };
                                if (postRecognitionWaitingPlayback) {
                                    postRecognitionWaitingPlayback.once('PlaybackFinished', onPostRecFinished);
                                    postRecognitionWaitingPlayback.once('PlaybackStopped', onPostRecStopped);
                                    client.on('PlaybackFailed', postRecFailedListener);
                                } else { callLogger.error("postRecognitionWaitingPlayback was null before adding listeners."); resolve('error_no_playback_object'); }
                            });
                            try {
                                if (callConfig.audio.waitingAudioMode === 'playFullBeforeDialplan') {
                                    callLogger.info("Playing full post-recognition waiting audio before returning to dialplan.");
                                    if (postRecognitionWaitingPlayback && !postRecognitionWaitingPlayback.destroyed) {
                                        await channel.play({ media: `sound:${selectedAudioPath}` }, postRecognitionWaitingPlayback);
                                        await postRecPlayPromise;
                                        callLogger.info("Full post-recognition waiting audio finished.");
                                    } else { callLogger.warn("postRecognitionWaitingPlayback invalid for playFullBeforeDialplan before play."); }
                                } else if (callConfig.audio.waitingAudioMode === 'playAndTransfer') {
                                    callLogger.info("Starting post-recognition waiting audio and returning to dialplan (playAndTransfer mode).");
                                    if (postRecognitionWaitingPlayback && !postRecognitionWaitingPlayback.destroyed) {
                                        channel.play({ media: `sound:${selectedAudioPath}` }, postRecognitionWaitingPlayback)
                                            .catch(e => callLogger.warn(`Error starting post-recognition waiting audio for playAndTransfer`, e));
                                        await channel.setChannelVar({ variable: 'FORCED_WAITING_AUDIO_ACTIVE', value: 'true' });
                                    } else { callLogger.warn("postRecognitionWaitingPlayback invalid for playAndTransfer before play."); }
                                } else { callLogger.warn(`Unknown waitingAudioMode for post-recognition: ${callConfig.audio.waitingAudioMode}. Not playing audio.`); }
                            } catch (playError) { callLogger.error(`Error during post-recognition waiting audio playback`, playError); }
                        }
                    }
                    callLogger.info(`Attempting to continue channel in dialplan.`);
                    await channel.continueInDialplan();
                    callLogger.info(`Successfully instructed channel to continue in dialplan.`);
                } else {
                    callLogger.warn(`Channel is not in 'Up' state (state: ${channel ? channel.state : 'N/A'}) or destroyed. Cannot continue in dialplan. It might have been hung up by other party or another process.`);
                }
              } catch (e) { callLogger.error('Error attempting to continue channel in dialplan or during post-recognition audio', e); }
          }
          callLogger.info(`Cleanup actions complete`);
      };

      /**
       * Attempts to perform offline (batch) speech recognition on the captured audio file.
       * This is typically used as a fallback if streaming recognition fails.
       * Sets appropriate channel variables based on the outcome.
       * @async
       * @function tryOfflineRecognition
       * @private
       * @param {string} filePathToTranscribe - Path to the captured audio file.
       * @param {string} languageForSpeechToTry - The language code to use for transcription.
       * @param {object} channelForVar - The ARI channel object for setting variables.
       */
      const tryOfflineRecognition = async (filePathToTranscribe, languageForSpeechToTry, channelForVar) => {
          if (!callConfig.appRecognitionConfig.enableFallbackBatchTranscription) {
              callLogger.info(`Fallback batch transcription is disabled. Skipping for file: ${filePathToTranscribe}`);
              await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_STATUS', value: 'disabled' }).catch(e => { callLogger.warn(`Error setting SPEECH_FALLBACK_STATUS: ${e.message}` );});
              return;
          }
          if (!callConfig.audio.captureAudioEnabled || !filePathToTranscribe) {
              callLogger.warn(`Audio capture was not enabled or filePath is missing for fallback transcription. File: ${filePathToTranscribe}`);
              await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_STATUS', value: 'no_audio_file' }).catch(e => { callLogger.warn(`Error setting SPEECH_FALLBACK_STATUS: ${e.message}` );});
              return;
          }

          callLogger.info(`Attempting fallback batch transcription for: ${filePathToTranscribe}`);
          if (audioFileStream && !audioFileStream.destroyed) {
              callLogger.info(`Closing active audio capture file stream before batch transcription.`);
              await new Promise(resolve => audioFileStream.end(resolve));
              audioFileStream = null;
              callLogger.info(`Audio capture file ${filePathToTranscribe} closed for batch processing.`);
          } else {
              callLogger.debug(`Audio file stream for ${filePathToTranscribe} already closed or not active.`);
          }

          await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_ATTEMPT', value: 'true' }).catch(e => { callLogger.warn(`Error setting SPEECH_FALLBACK_ATTEMPT: ${e.message}` );});

          try {
              const transcript = await transcribeAudioFile(callLogger, filePathToTranscribe, languageForSpeechToTry, callConfig.googleSpeech);
              if (transcript && transcript.trim().length > 0) {
                  callLogger.info(`Fallback batch transcription successful. Transcript: "${transcript}"`);
                  finalTranscription = transcript;
                  await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_TRANSCRIPT', value: transcript }).catch(e => { callLogger.warn(`Error setting SPEECH_FALLBACK_TRANSCRIPT: ${e.message}` );});
                  await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_STATUS', value: 'success' }).catch(e => { callLogger.warn(`Error setting SPEECH_FALLBACK_STATUS: ${e.message}` );});
              } else {
                  callLogger.warn(`Fallback batch transcription for ${filePathToTranscribe} resulted in an empty transcript.`);
              await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_STATUS', value: 'empty_result' }).catch(e => { callLogger.warn(`Error setting SPEECH_FALLBACK_STATUS`, e );});
              }
          } catch (e) {
              callLogger.error(`Error during fallback batch transcription for ${filePathToTranscribe}`, e);
              await channelForVar.setChannelVar({ variable: 'SPEECH_FALLBACK_STATUS', value: 'error' }).catch(err => { callLogger.warn(`Error setting SPEECH_FALLBACK_STATUS`, err );});
          }
      };

      /**
       * @async
       * @function activateGoogleStreamingAndRecognitionLogic
       * @description Activates the connection to Google Speech-to-Text and starts the recognition process.
       * This involves setting up the speech stream, attaching listeners for data, errors, and end events,
       * and managing application-level timers related to speech recognition.
       * It ensures that necessary resources like bridges and media channels are ready before proceeding.
       * @param {boolean} [isBargeInByTimer=false] - Indicates if activation is due to a barge-in timer expiring.
       * @returns {Promise<void>}
       */
      const activateGoogleStreamingAndRecognitionLogic = async (isBargeInByTimer = false) => {
    if (speechRecognitionDisabledDueToDtmf) {
      callLogger.info('Speech recognition activation skipped as DTMF input has been received.');
      return;
    }
    if (dtmfFinalTimer && !dtmfModeActive) {
        clearTimeout(dtmfFinalTimer);
        dtmfFinalTimer = null;
        callLogger.debug('Initial DTMF final timer cleared due to speech activation before DTMF input.');
    }
    if (!isBargeInByTimer && bargeInActivationTimer) {
        callLogger.info(`Speech detected or non-timer activation; clearing pending bargeInActivationTimer.`);
        clearTimeout(bargeInActivationTimer);
        bargeInActivationTimer = null;
    }

    if (googleStreamingActive) {
        callLogger.debug(`activateGoogleStreamingAndRecognitionLogic called but Google streaming already active.`);
        return;
    }
    if (isCleanupCalled) {
        callLogger.warn(`activateGoogleStreamingAndRecognitionLogic called but cleanup already in progress. Aborting activation.`);
        return;
    }

    // Ensure essential resources are ready before proceeding.
    if (!rtpServer || !rtpServer.isReady()) {
        callLogger.error('Cannot activate Google streaming: RTP Server is not ready.');
        await fullCleanup(true, "rtp_server_not_ready_for_google_stream");
        return;
    }
    if (!snoop_bridge || snoop_bridge.destroyed) {
        callLogger.error(`Cannot activate Google streaming: snoop_bridge (${snoop_bridge ? snoop_bridge.id : 'null'}) is not ready or destroyed.`);
        await fullCleanup(true, "snoop_bridge_not_ready_for_google_stream");
        return;
    }
    if (!externalMediaChannel || externalMediaChannel.destroyed) {
        callLogger.error(`Cannot activate Google streaming: externalMediaChannel (${externalMediaChannel ? externalMediaChannel.id : 'null'}) is not ready or destroyed.`);
        await fullCleanup(true, "extmedia_not_ready_for_google_stream");
        return;
    }

    callLogger.info(`Activating Google streaming and recognition logic. IsBargeInByTimer: ${isBargeInByTimer}`);
    googleStreamingActive = true;

    try {
        languageForSpeech = callConfig.googleSpeech.languageCode;
        callLogger.info(`Using language for speech: ${languageForSpeech}`);

        speechStream = createSpeechStream( callLogger, callConfig.googleSpeech,
          (data) => {
            if (isCleanupCalled || googleStreamError || finalTranscription) return;
            callLogger.info('GOOGLE_DATA_PAYLOAD', { googleResponse: data });
            if (initialGoogleStreamIdleTimer) { clearTimeout(initialGoogleStreamIdleTimer); initialGoogleStreamIdleTimer = null; }
            if (speechEndSilenceTimer && data.speechEventType !== 'SPEECH_ACTIVITY_END') { clearTimeout(speechEndSilenceTimer); speechEndSilenceTimer = null; }
            if (data.error) { callLogger.error('Google API error in data callback', data.error); return; } // data.error is already an object
            if (data.speechEventType) {
              if (data.speechEventType === 'SPEECH_ACTIVITY_BEGIN') {
                callLogger.info(`SPEECH_ACTIVITY_BEGIN received.`);
                if (!speechHasBegun) {
                    speechHasBegun = true;
                    if (noSpeechBeginTimer) { clearTimeout(noSpeechBeginTimer); noSpeechBeginTimer = null; }
                    callLogger.info(`Marking speechHasBegun = true due to SPEECH_ACTIVITY_BEGIN.`);
                }

                // Corrected VAD audio buffer handling
                let flushNeeded = pendingVADBufferFlush || (callConfig.appRecognitionConfig.recognitionActivationMode === 'vad' && vadAudioBuffer.length > 0);

                if (isFlushingVADBuffer) {
                    callLogger.debug("VAD: SPEECH_ACTIVITY_BEGIN received, but a flush is already in progress. Current VAD buffering state: " + isVADBufferingActive);
                    // Do not proceed with another flush logic here. isVADBufferingActive should have been set to false by the ongoing flush.
                } else if (flushNeeded) {
                    callLogger.info(`VAD: SPEECH_ACTIVITY_BEGIN. Flushing ${vadAudioBuffer.length} packets. Disabling further VAD buffering.`);
                    isVADBufferingActive = false; // <<< KEY CHANGE: Disable BEFORE flush loop
                    pendingVADBufferFlush = false;

                    if (vadAudioBuffer.length > 0) {
                        isFlushingVADBuffer = true; // Guard this flush operation
                        const tempBuffer = [...vadAudioBuffer];
                        vadAudioBuffer = [];       // <<< KEY CHANGE: Clear immediately

                        callLogger.info(`VAD: Starting flush of ${tempBuffer.length} packets.`);
                        for (const bufferedPayload of tempBuffer) {
                            if (speechStream && speechStream.writable && !speechStream.destroyed) {
                                try { speechStream.write(bufferedPayload); }
                                catch (writeError) { callLogger.error('VAD: Error writing buffered audio to Google stream', writeError); break; }
                            } else { callLogger.warn('VAD: Speech stream not writable while flushing buffer.'); break; }
                        }
                        isFlushingVADBuffer = false;
                        callLogger.info("VAD: Finished flushing audio buffer.");
                    } else {
                        callLogger.info("VAD: SPEECH_ACTIVITY_BEGIN indicated flush, but buffer was empty. VAD buffering disabled.");
                        // isVADBufferingActive is already false, vadAudioBuffer is already empty or should be.
                    }
                } else { // No flush needed (pendingVADBufferFlush is false and vadAudioBuffer is empty)
                    callLogger.debug("VAD: SPEECH_ACTIVITY_BEGIN. No VAD buffer flush needed. Disabling VAD buffering if it was active.");
                    if (isVADBufferingActive) {
                        isVADBufferingActive = false;
                        vadAudioBuffer = []; // Ensure cleared
                        callLogger.info("VAD: Buffering was active but no flush performed on SPEECH_ACTIVITY_BEGIN. Disabled and cleared buffer now.");
                    }
                }

                if (!promptPlaybackStoppedForInterim && mainPlayback && !mainPlayback.destroyed && mainPlayback.state === 'playing') {
                    callLogger.info(`Stopping mainPlayback ${mainPlayback.id} due to SPEECH_ACTIVITY_BEGIN. Current state: ${mainPlayback.state}`);
                    const stopResult = mainPlayback.stop();
                    if (stopResult && typeof stopResult.then === 'function') {
                         callLogger.debug(`mainPlayback.stop() returned a Promise on SPEECH_ACTIVITY_BEGIN, handling async.`);
                         stopResult.catch(e => callLogger.warn(`Error stopping mainPlayback on SPEECH_ACTIVITY_BEGIN: ${e.message}`));
                    }
                    promptPlaybackStoppedForInterim = true;
                    callLogger.info(`Set promptPlaybackStoppedForInterim = true due to SPEECH_ACTIVITY_BEGIN.`);
                } else {
                    if (promptPlaybackStoppedForInterim) callLogger.debug(`SPEECH_ACTIVITY_BEGIN received, but prompt playback was already stopped (promptPlaybackStoppedForInterim=true).`);
                    else if (!mainPlayback || mainPlayback.destroyed || mainPlayback.state !== 'playing') callLogger.debug(`SPEECH_ACTIVITY_BEGIN received, but mainPlayback not active/playing (State: ${mainPlayback ? mainPlayback.state : 'N/A'}). No stop action needed.`);
                }
              } else if (data.speechEventType === 'SPEECH_ACTIVITY_END') {
                callLogger.info(`Google detected SPEECH_ACTIVITY_END. Application will rely on its own speechEndSilenceTimer or maxRecognitionDurationTimer to close the stream.`);
                if (speechHasBegun) {
                    if (speechEndSilenceTimer) { clearTimeout(speechEndSilenceTimer); callLogger.debug(`Cleared existing speechEndSilenceTimer due to Google SPEECH_ACTIVITY_END. Will restart it.`); }
                    callLogger.info(`Starting/Resetting app's speechEndSilenceTimer (${callConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds}s) after Google SPEECH_ACTIVITY_END, waiting for potential further speech or final transcript.`);
                    speechEndSilenceTimer = setTimeout(() => {
                        callLogger.warn(`App Timeout: Silence after Google's SPEECH_ACTIVITY_END and no further results or speech within ${callConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds}s. Proceeding to cleanup.`);
                        if (channel && !channel.destroyed) channel.setChannelVar({ variable: 'APP_SILENCE_POST_GOOGLE_SPEECH_ACTIVITY_END', value: 'true' }).catch(e => { callLogger.warn(`Error setting APP_SILENCE_POST_GOOGLE_SPEECH_ACTIVITY_END: ${e.message}`); });
                        fullCleanup(false, "app_silence_after_google_speech_activity_end");
                    }, callConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds * 1000);
                } else { callLogger.warn("Google SPEECH_ACTIVITY_END received but speechHasBegun is false. This is unusual. Stream will likely be closed by other timeouts (e.g., initialGoogleStreamIdleTimer or maxRecognitionDurationTimer).");}
              }
            }
            if (data.results && data.results.length > 0) {
                const res = data.results[0];
                if (res.alternatives && res.alternatives.length > 0) {
                    const transcript = res.alternatives[0].transcript;
                    if (res.isFinal) {
                        callLogger.info(`Final transcript: "${transcript}"`);
                        finalTranscription = transcript;
                        fullCleanup(false, "final_transcript_received");
                    } else {
                        callLogger.info(`Interim: "${transcript}"`);
                        lastInterimTranscription = transcript;
                        if (!promptPlaybackStoppedForInterim && mainPlayback && !mainPlayback.destroyed) {
                            callLogger.info(`Attempting to stop mainPlayback ${mainPlayback.id} due to interim result. Current mainPlayback.state: ${mainPlayback.state}`);
                            const stopResult = mainPlayback.stop();
                            if (stopResult && typeof stopResult.then === 'function') {
                                 callLogger.debug(`mainPlayback.stop() returned a Promise on interim result, handling async.`);
                                 stopResult.catch(e => callLogger.warn(`Error stopping mainPlayback on interim result: ${e.message}`));
                            }
                            promptPlaybackStoppedForInterim = true;
                            callLogger.info(`Set promptPlaybackStoppedForInterim = true due to interim result.`);
                        }
                        if (!speechHasBegun) {
                            callLogger.info(`Marking speechHasBegun = true due to interim result.`);
                            speechHasBegun = true;
                            if (noSpeechBeginTimer) { clearTimeout(noSpeechBeginTimer); noSpeechBeginTimer = null; }
                        }
                        if (speechStream && !speechStream.writableEnded) {
                            if (speechEndSilenceTimer) { clearTimeout(speechEndSilenceTimer); }
                            speechEndSilenceTimer = setTimeout(() => {
                                callLogger.warn(`App Timeout: Silence after interim result. Ending Google Stream.`);
                                if (channel && !channel.destroyed) channel.setChannelVar({ variable: 'SPEECH_END_SILENCE_TIMEOUT_INTERIM', value: 'true' }).catch(e => { callLogger.warn(`Error setting SPEECH_END_SILENCE_TIMEOUT_INTERIM: ${e.message}` ); });
                                if (speechStream && !speechStream.destroyed && !speechStream.writableEnded) { isGoogleStreamEnding = true; speechStream.end(); }
                                if (speechEndSilenceTimer) clearTimeout(speechEndSilenceTimer); // Clear previous shorter one
                                speechEndSilenceTimer = setTimeout(() => {
                                    if (isCleanupCalled) { callLogger.debug('Google no-final-result-timeout_interim: Timer expired, but cleanup already called. Ignoring.'); return; }
                                    callLogger.warn(`App Timeout: Google did not send isFinal after stream.end() (interim silence).`);
                                    fullCleanup(false, "app_google_no_final_result_timeout_interim");
                                }, callConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds * 1000); // Wait a bit longer for final
                            }, callConfig.appRecognitionConfig.speechEndSilenceTimeoutSeconds * 1000);
                        }
                    }
                }
            }
          },
          (error) => {
            if (dtmfInterruptedSpeech) {
              callLogger.warn(`Google stream error after DTMF interruption (likely expected, e.g., 'write after end' or 'DTMF_INTERRUPT_FORCED_DESTROY'): ${error.message}. Treating as controlled stop.`);
              googleStreamError = null;
              if (error.message.includes('DTMF_INTERRUPT_FORCED_DESTROY')) callLogger.info('Error was the one deliberately emitted for DTMF interruption by forced destroy.');
              return;
            }
            callLogger.error('Google stream error', error); // Pass the full error object
            googleStreamError = error; // Keep storing it if needed for logic, but it's logged above.
            if (speechStream) callLogger.debug(`Stream properties on error: destroyed=${speechStream.destroyed}, writable=${speechStream.writable}, readable=${speechStream.readable}, writableEnded=${speechStream.writableEnded}, readableEnded=${speechStream.readableEnded}, writableFinished=${speechStream.writableFinished}, readableFinished=${speechStream.readableFinished}`);
            else callLogger.debug(`Stream properties on error: speechStream object is null.`);
            callLogger.debug(`State flags on error: googleStreamingActive=${googleStreamingActive}, isCleanupCalled=${isCleanupCalled}`);

            if (isCleanupCalled) { callLogger.warn(`Google stream error occurred but cleanup is already in progress. Error: ${error.message}`, { error }); return; }

            if (error.message.includes('write after end')) {
                callLogger.warn(`'write after end' error (non-DTMF related). Proceeding with non-hanging cleanup.`, { error });
                fullCleanup(false, "google_stream_write_after_end_handled");
            } else if (finalTranscription && finalTranscription.trim() !== '') {
                callLogger.warn(`Google stream error occurred after a final transcription (non-DTMF related). Proceeding with non-hanging cleanup. Error: ${error.message}`, { error });
                fullCleanup(false, "google_stream_error_post_final_transcription");
            } else {
                const isErrorAfterGracefulEndGeneral = speechStream && speechStream.writableEnded && (error.message.includes('already ended') || error.message.includes('Stream is not writable'));
                if (isErrorAfterGracefulEndGeneral) {
                    callLogger.warn(`Google stream error seems to be a general post-graceful-end issue (non-DTMF related). Proceeding with non-hanging cleanup. Error: ${error.message}`, { error });
                    fullCleanup(false, "google_stream_error_post_graceful_end_general");
                } else {
                    callLogger.error(`Critical Google stream error (non-DTMF related) before final transcription or specific graceful end. Forcing hangup. Error: ${error.message}`, { error });
                    fullCleanup(true, "google_stream_critical_error");
                }
            }
          },
          () => {
            if (dtmfInterruptedSpeech) { callLogger.info("Google stream 'end' event received after DTMF interruption. This is expected and handled."); return; }
            callLogger.info(`Google stream raw 'end' event.`);
            if (speechStream) callLogger.debug(`Stream properties on 'end': destroyed=${speechStream.destroyed}, writable=${speechStream.writable}, readable=${speechStream.readable}, writableEnded=${speechStream.writableEnded}, readableEnded=${speechStream.readableEnded}, writableFinished=${speechStream.writableFinished}, readableFinished=${speechStream.readableFinished}`);
            else callLogger.debug(`Stream properties on 'end': speechStream object is null.`);
            callLogger.debug(`State flags on 'end': googleStreamingActive=${googleStreamingActive}, isCleanupCalled=${isCleanupCalled}, finalTranscriptionPresent=${!!finalTranscription}, googleStreamErrorPresent=${!!googleStreamError}`);
            if (!isCleanupCalled && !finalTranscription && !googleStreamError && googleStreamingActive) {
                callLogger.warn(`Google stream ended cleanly (non-DTMF related) but without a final transcript and no prior error. Reason: google_stream_ended_uncontrolled.`);
                fullCleanup(false, "google_stream_ended_uncontrolled");
            } else {
                callLogger.info(`Google stream 'end' event handled (non-DTMF related). Cleanup already called or final/error already processed. isCleanupCalled: ${isCleanupCalled}, finalTranscription: ${!!finalTranscription}, googleStreamError: ${!!googleStreamError}`);
            }
          },
          languageForSpeech
        );

        if (!rtpServer) { await fullCleanup(true, "rtp_server_null_on_google_activation"); return; }

        rtpServer.removeAllListeners('audioPacketForGoogle');
        rtpServer.on('audioPacketForGoogle', (audioPayload) => {
            if (googleStreamingActive && speechStream && !speechStream.writableEnded && !speechStream.destroyed && !googleStreamError && !isGoogleStreamEnding) {
                try { speechStream.write(audioPayload); }
                catch (writeError) {
                    callLogger.error('ERROR writing to Google stream', writeError); // Pass full error object
                    googleStreamError = writeError; // Keep for logic if needed
                }
            } else {
                if (speechStream) callLogger.debug(`Skipped writing to Google stream. Conditions: googleStreamingActive=${googleStreamingActive}, speechStreamExists=true, writableEnded=${speechStream.writableEnded}, writable=${speechStream.writable}, destroyed=${speechStream.destroyed}, googleStreamError=${!!googleStreamError}, isGoogleStreamEnding=${isGoogleStreamEnding}${googleStreamError ? ` (Msg: ${googleStreamError.message})` : ''}`);
                else callLogger.debug(`Skipped writing to Google stream. Conditions: googleStreamingActive=${googleStreamingActive}, speechStreamExists=false, googleStreamError=${!!googleStreamError}, isGoogleStreamEnding=${isGoogleStreamEnding}${googleStreamError ? ` (Msg: ${googleStreamError.message})` : ''}`);
            }
        });

        callLogger.info(`Google streaming active. Starting app VAD timers.`);
        if (noSpeechBeginTimer) clearTimeout(noSpeechBeginTimer);
        noSpeechBeginTimer = setTimeout(async () => {
            if (!speechHasBegun && !isCleanupCalled) {
                callLogger.warn(`App Timeout: No SPEECH_ACTIVITY_BEGIN (noSpeechBeginTimeoutSeconds).`);
                await channel.setChannelVar({ variable: 'NO_SPEECH_BEGIN_TIMEOUT', value: 'true' }).catch(e => {});
                if (callConfig.audio.captureAudioEnabled && audioFilePath) {
                    tryOfflineRecognition(audioFilePath, languageForSpeech, channel).catch(e => callLogger.error(`tryOfflineRecognition (no_speech_begin_timeout) threw an error`, e));
                }
                fullCleanup(true, "app_no_speech_begin_timeout");
            }
        }, callConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds * 1000);

        if (initialGoogleStreamIdleTimer) clearTimeout(initialGoogleStreamIdleTimer);
        initialGoogleStreamIdleTimer = setTimeout(async () => {
             if (!speechHasBegun && !isCleanupCalled) {
                callLogger.warn(`App Timeout: Google stream idle (initialGoogleStreamIdleTimeoutSeconds).`);
                await channel.setChannelVar({ variable: 'INITIAL_STREAM_IDLE_TIMEOUT', value: 'true' }).catch(e => {});
                if (callConfig.audio.captureAudioEnabled && audioFilePath) {
                    tryOfflineRecognition(audioFilePath, languageForSpeech, channel).catch(e => callLogger.error(`tryOfflineRecognition (initial_stream_idle) threw an error`, e));
                }
                fullCleanup(true, "app_initial_google_stream_idle_timeout");
             }
        }, callConfig.appRecognitionConfig.initialGoogleStreamIdleTimeoutSeconds * 1000);

    } catch (err) { callLogger.error('Error activating Google streaming', err); await fullCleanup(true, "google_streaming_activation_error"); }
  };

  try {
    callLogger.info(`Answering user channel`);
    await channel.answer();

    let primaryChannelStasisEnded = false; // Flag to prevent double cleanup

    channel.once('StasisEnd', async (endEvent, endedChannel) => {
        if (primaryChannelStasisEnded) {
            // callLogger.debug(`StasisEnd for primary channel ${channel.id} already processed or cleanup initiated.`);
            return;
        }
        primaryChannelStasisEnded = true;
        callLogger.warn(`Primary channel ${channel.id} received StasisEnd event. This might be due to external hangup (e.g., SIP timeout, Asterisk CLI hangup). Initiating application cleanup for this call.`);
        if (!isCleanupCalled) {
            await fullCleanup(false, "primary_channel_stasis_ended_event");
        } else {
            callLogger.info(`StasisEnd for primary channel ${channel.id} received, but cleanup was already in progress or called.`);
        }
    });

    // Conditional VAD Startup Delays (Initial Silence & General Activation)
    // These timers and their completion flags are only initialized and set to false if
    // VAD mode is "vad" AND vadRecogActivation is "vadMode" AND the respective delay > 0.
    // Otherwise, the completion flags are defaulted to true, bypassing these specific startup delays.
    if (callConfig.appRecognitionConfig.recognitionActivationMode === 'vad' &&
        callConfig.appRecognitionConfig.vadRecogActivation === 'vadMode') {

        callLogger.info('VAD mode with vadRecogActivation="vadMode". Initializing VAD startup delay timers and flags.');

        // VAD Initial Silence Delay
        if (callConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds > 0) {
            callLogger.info(`VAD Initial Silence Delay: Will wait ${callConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds}s before VAD logic becomes responsive to speech or prompt end.`);
            vadInitialSilenceDelayCompleted = false; // Only false if timer will run
            if (vadInitialSilenceDelayTimer) clearTimeout(vadInitialSilenceDelayTimer);
            vadInitialSilenceDelayTimer = setTimeout(async () => {
                if (isCleanupCalled) { callLogger.debug('VAD Initial Silence Delay: Timer expired, but cleanup already called. Ignoring.'); return; }
                callLogger.info('VAD Initial Silence Delay: Timer expired. VAD logic now responsive.');
                callLogger.info('VAD Initial Silence Delay: Timer expired.');
                vadInitialSilenceDelayCompleted = true;
                vadInitialSilenceDelayTimer = null;

                if (vadInitialSilenceDelayCompleted && vadActivationDelayCompleted) {
                    callLogger.debug('VAD Initial Silence Delay: All relevant VAD startup delays (Initial Silence & General Activation) are now complete.');

                    if (vadSpeechActiveDuringDelay && !isCleanupCalled && !googleStreamingActive && !vadRecognitionTriggeredAfterInitialDelay) {
                        callLogger.info('VAD Initial Silence Delay: Delays complete, speech was active during these delays. Attempting to activate recognition.');
                        vadSpeechDetected = true; // Ensure this is set as we are acting on vadSpeechActiveDuringDelay
                        vadRecognitionTriggeredAfterInitialDelay = true; // Mark that VAD path has triggered

                        if (mainPlayback && mainPlayback.state === 'playing' && !promptPlaybackStoppedForInterim) {
                            callLogger.info(`VAD Initial Silence Delay: Barge-in: Stopping prompt ${mainPlayback.id} and activating Google Stream.`);
                            try {
                                // Ensure playback object is still valid before stopping
                                const currentPlayback = await client.playbacks.get({playbackId: mainPlayback.id}).catch(() => null);
                                if (currentPlayback && currentPlayback.state === 'playing') {
                                    await mainPlayback.stop();
                                } else {
                                    callLogger.info(`VAD Initial Silence Delay: MainPlayback ${mainPlayback.id} was not in a stoppable state. Proceeding with activation.`);
                                }
                            } catch (e) {
                                callLogger.warn(`VAD Initial Silence Delay: Error stopping mainPlayback ${mainPlayback.id} for barge-in: ${e.message}`);
                            }
                            promptPlaybackStoppedForInterim = true;
                            await activateGoogleStreamingAndRecognitionLogic(false);
                        } else if (mainPlayback && (mainPlayback.state === 'finished' || mainPlayback.state === 'stopped' || mainPlayback.destroyed)) {
                            callLogger.info('VAD Initial Silence Delay: Prompt already finished/stopped. Activating Google Stream.');
                            await activateGoogleStreamingAndRecognitionLogic(false);
                        } else if (!mainPlayback || mainPlayback.destroyed) {
                            callLogger.info('VAD Initial Silence Delay: No prompt or prompt destroyed. Activating Google Stream.');
                            await activateGoogleStreamingAndRecognitionLogic(false);
                        } else {
                             callLogger.info('VAD Initial Silence Delay: Speech active, but prompt state is unusual (' + (mainPlayback ? mainPlayback.state : 'null') + ', promptPlaybackStoppedForInterim: ' + promptPlaybackStoppedForInterim + '). Deferring specific action or activating if not already streaming.');
                             // If prompt is playing but promptPlaybackStoppedForInterim is true, it means something else stopped it (e.g. interim result from Google).
                             // Or if it's in a state other than 'playing', 'finished', 'stopped', 'destroyed'.
                             // We should probably still activate here if not already streaming and other conditions met.
                             if (!googleStreamingActive && !isCleanupCalled && vadRecognitionTriggeredAfterInitialDelay) { // Check vadRecognitionTriggeredAfterInitialDelay because we set it true above
                                await activateGoogleStreamingAndRecognitionLogic(false);
                             } else {
                                callLogger.debug('VAD Initial Silence Delay: Conditions for immediate activation in unusual prompt state not fully met, or already streaming/cleaned up.');
                             }
                        }
                        // If recognition was activated by this path, remove TALK_DETECT
                        if (googleStreamingActive) { // Check if activateGoogleStreamingAndRecognitionLogic actually made it active
                            callLogger.info('VAD Initial Silence Delay: Removing TALK_DETECT post-activation.');
                            try { if (channel && !channel.destroyed) await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }); }
                            catch(e){ callLogger.error(`VAD Initial Silence Delay: Error removing TALK_DETECT`,e);}
                        }
                    } else if (vadSpeechActiveDuringDelay && (googleStreamingActive || vadRecognitionTriggeredAfterInitialDelay)) {
                        callLogger.debug('VAD Initial Silence Delay: Speech was active, but Google streaming already active or VAD recognition previously triggered by another path. No action needed here.');
                    } else if (!vadSpeechActiveDuringDelay && mainPlayback && (mainPlayback.state === 'finished' || mainPlayback.state === 'stopped' || mainPlayback.destroyed)) {
                        callLogger.info('VAD Initial Silence Delay: User was not speaking (or speech stopped) when delay ended, and prompt is finished. Evaluating post-prompt logic.');
                        await handlePostPromptVADLogic();
                    } else if (!vadSpeechActiveDuringDelay) {
                        callLogger.info('VAD Initial Silence Delay: User was not speaking (or speech stopped) when delay ended. Waiting for prompt to finish or new speech.');
                        // No immediate action if prompt is still playing; wait for prompt to end (which calls handlePostPromptVADLogic)
                        // or a new ChannelTalkingStarted event.
                    }
                } else if (vadInitialSilenceDelayCompleted && !vadActivationDelayCompleted) {
                     callLogger.debug('VAD Initial Silence Delay: Timer expired, but General Activation delay is still pending. VAD logic will be fully evaluated when general activation delay completes.');
                } else { // This case implies !vadInitialSilenceDelayCompleted which should not happen here, or !vadActivationDelayCompleted if initial was already true
                     callLogger.debug('VAD Initial Silence Delay: Timer expired, but a VAD delay is still pending or condition not met. No immediate action on VAD logic here.');
                }
            }, callConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds * 1000);
        } else {
            vadInitialSilenceDelayCompleted = true;
            callLogger.info(`VAD Initial Silence Delay: No delay configured or not applicable (delay <= 0). VAD logic responsive immediately.`);
        }

        // VAD General Activation Delay
        if (callConfig.appRecognitionConfig.vadActivationDelaySeconds > 0) {
            callLogger.info(`VAD Activation Delay (General): Will wait ${callConfig.appRecognitionConfig.vadActivationDelaySeconds}s before VAD event reactions are fully active.`);
            vadActivationDelayCompleted = false; // Only false if timer will run
            if (vadActivationDelayTimer) clearTimeout(vadActivationDelayTimer);
            vadActivationDelayTimer = setTimeout(async () => {
                if (isCleanupCalled) { callLogger.debug('VAD Activation Delay: Timer expired, but cleanup already called. Ignoring.'); return; }
                callLogger.info('VAD Activation Delay (General): Timer expired. VAD event reactions now active.');
                vadActivationDelayCompleted = true;
                vadActivationDelayTimer = null;
                if (vadInitialSilenceDelayCompleted && vadActivationDelayCompleted) {
                    callLogger.debug('VAD General Activation Delay: Timer expired AND Initial Silence delay also completed. All VAD startup delays are now finished.');
                    if (vadSpeechActiveDuringDelay && !isCleanupCalled && !googleStreamingActive && !vadRecognitionTriggeredAfterInitialDelay) {
                        callLogger.info('VAD General Activation Delay: Speech was active during VAD delays and did not explicitly finish. Proceeding with recognition.');
                        if (mainPlayback && mainPlayback.state === 'playing' && !promptPlaybackStoppedForInterim) {
                            callLogger.info(`VAD General Activation Delay: Barge-in: Stopping prompt and activating Google Stream.`);
                            await mainPlayback.stop();
                            promptPlaybackStoppedForInterim = true;
                            vadSpeechDetected = true;
                            vadRecognitionTriggeredAfterInitialDelay = true;
                            await activateGoogleStreamingAndRecognitionLogic(false);
                            if (googleStreamingActive) {
                                callLogger.info('VAD: Live streaming (due to speech during completed general activation delay). Disabling VAD buffering. Marking buffer for flush.');
                                isVADBufferingActive = false;
                                pendingVADBufferFlush = true;
                            }
                            callLogger.info('VAD: Removing TALK_DETECT post-activation (speech during general activation delay).');
                            try { if (channel && !channel.destroyed) await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }); }
                            catch(e){ callLogger.error(`VAD: Error removing TALK_DETECT (speech during general activation delay)`, e);}
                        } else if (mainPlayback && (mainPlayback.state === 'finished' || mainPlayback.state === 'stopped' || mainPlayback.destroyed)) {
                            callLogger.debug('VAD General Activation Delay: Delays complete, speech active during delays, prompt finished. Calling handlePostPromptVADLogic.');
                            await handlePostPromptVADLogic();
                        } else if (!mainPlayback || mainPlayback.destroyed) {
                            callLogger.info('VAD General Activation Delay: Delays complete, speech active during delays, no prompt active. Directly activating recognition.');
                            vadSpeechDetected = true;
                            vadRecognitionTriggeredAfterInitialDelay = true;
                            await activateGoogleStreamingAndRecognitionLogic(false);
                            if (googleStreamingActive) {
                                 callLogger.info('VAD: Live streaming (due to speech during completed general activation delay, no prompt). Disabling VAD buffering. Marking buffer for flush.');
                                 isVADBufferingActive = false;
                                 pendingVADBufferFlush = true;
                            }
                            callLogger.info('VAD: Removing TALK_DETECT post-activation (speech during general activation delay, no prompt).');
                            try { if (channel && !channel.destroyed) await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }); }
                            catch(e){ callLogger.error(`VAD: Error removing TALK_DETECT (speech during general activation delay, no prompt)`, e);}
                        }
                    } else if (mainPlayback && (mainPlayback.destroyed || mainPlayback.state === 'finished' || mainPlayback.state === 'stopped')) {
                        callLogger.info('VAD General Activation Delay: All delays completed, prompt finished. Evaluating standard post-prompt VAD logic.');
                        await handlePostPromptVADLogic();
                    } else if (googleStreamingActive || vadRecognitionTriggeredAfterInitialDelay) {
                        callLogger.debug('VAD General Activation Delay: All delays completed. However, Google streaming is already active or VAD recognition was already triggered. No further VAD-specific action needed here.');
                    } else {
                        callLogger.debug('VAD General Activation Delay: All delays completed. Prompt might still be playing, and no continuous speech was detected *during the delay periods*. Waiting for prompt to finish or standard ChannelTalkingStarted.');
                    }
                }
            }, callConfig.appRecognitionConfig.vadActivationDelaySeconds * 1000);
        } else {
            vadActivationDelayCompleted = true;
            callLogger.info(`VAD Activation Delay (General): No delay configured or not applicable. VAD event reactions active immediately regarding this delay.`);
        }
    } else {
        // Not vadMode or not VAD at all: these delays are not applicable, so flags are true.
        callLogger.info('VAD mode is not "vadMode" or VAD is not active. VAD startup delays (initial silence/general activation) are bypassed.');
        vadInitialSilenceDelayCompleted = true;
        vadActivationDelayCompleted = true;
    }

    if (callConfig.appRecognitionConfig.recognitionActivationMode === 'vad') {
        callLogger.info('VAD mode enabled. Setting up TALK_DETECT (if not already done).');
        isVADBufferingActive = true;
        vadAudioBuffer = [];
        const silenceMs = callConfig.appRecognitionConfig.vadSilenceThresholdMs;
        const talkThreshold = callConfig.appRecognitionConfig.vadTalkThreshold;
        const talkDetectValue = `${silenceMs},${talkThreshold}`;
        try {
            await channel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
            callLogger.info(`TALK_DETECT(set) applied with value: ${talkDetectValue}. Channel ID: ${channel.id}`);

            /**
             * Handles the `ChannelTalkingStarted` event from Asterisk when VAD mode is active.
             * This function is responsible for initiating the Google Speech stream if VAD conditions are met.
             * It respects `vadInitialSilenceDelayCompleted` and `vadActivationDelayCompleted` flags,
             * deferring action if these delays are still active.
             * It also uses `vadRecognitionTriggeredAfterInitialDelay` to ensure recognition is started only once via VAD.
             * @async
             * @private
             * @param {object} event - The `ChannelTalkingStarted` event object.
             * @param {object} chan - The channel object associated with the event.
             */
            channelTalkingStartedHandler = async (event, chan) => {
                if (isCleanupCalled) { callLogger.debug('VAD: ChannelTalkingStarted event ignored, cleanup already called.'); return; }
                if (chan.id !== channel.id) return;

                // ADD/VERIFY THIS BLOCK - START
                if (callConfig.appRecognitionConfig.recognitionActivationMode === 'vad' &&
                    callConfig.appRecognitionConfig.vadRecogActivation === 'afterPrompt' &&
                    mainPlayback && mainPlayback.state === 'playing' && !promptPlaybackStoppedForInterim) {

                    callLogger.info(`VAD: ChannelTalkingStarted event received for 'afterPrompt' mode while prompt '${mainPlayback.id}' is still playing. Deferring activation. Speech noted.`);
                    vadSpeechDetected = true; // Note that speech occurred, for potential use by handlePostPromptVADLogic
                    return; // IMPORTANT: Exit handler, do not proceed to activate.
                }
                // ADD/VERIFY THIS BLOCK - END

                // If any VAD startup delay is still active, just note that speech occurred.
                // The actual decision to activate recognition will be made when the timers expire,
                // or by this handler if it's called again after delays complete.
                if (!vadInitialSilenceDelayCompleted || !vadActivationDelayCompleted) {
                    callLogger.info('VAD: ChannelTalkingStarted event received, but one or more VAD startup delays (initial_silence/general_activation) are still active. Marking vadSpeechActiveDuringDelay = true.');
                    vadSpeechActiveDuringDelay = true;
                    // vadSpeechDetected is also set to true here to indicate that a speech event *did* occur,
                    // which might be checked by delay timer callbacks.
                    vadSpeechDetected = true;
                    return; // Defer full processing until all delays are complete.
                }

                // All VAD startup delays (initial silence and general activation) are completed.
                // Now, proceed with standard VAD logic (if not returned already by 'afterPrompt' check).

                // Existing checks for VAD startup delays (initial_silence/general_activation)
                if (!vadInitialSilenceDelayCompleted) {
                    callLogger.info('VAD: ChannelTalkingStarted event received, but VAD initial silence delay is still active. Marking vadSpeechActiveDuringDelay = true.');
                    vadSpeechActiveDuringDelay = true;
                    vadSpeechDetected = true; // Note that speech happened
                    return; // Defer further processing
                }
                if (!vadActivationDelayCompleted) {
                    callLogger.info('VAD: ChannelTalkingStarted event received (initial silence delay completed), but VAD general activation delay is still active. Marking vadSpeechActiveDuringDelay = true.');
                    vadSpeechActiveDuringDelay = true;
                    vadSpeechDetected = true; // Note that speech happened
                    return; // Defer further processing
                }

                // If already streaming or VAD path has already triggered, ignore.
                if (googleStreamingActive || vadRecognitionTriggeredAfterInitialDelay) {
                    callLogger.debug(`VAD: ChannelTalkingStarted event for channel ${channel.id} ignored: Google streaming is already active OR VAD recognition was already triggered by a VAD path.`);
                    return;
                }

                callLogger.info(`VAD: ChannelTalkingStarted event processed for channel ${channel.id} (All VAD startup delays completed, no prior VAD recognition trigger, not 'afterPrompt' during active prompt). Activating recognition.`);
                vadSpeechDetected = true;
                vadRecognitionTriggeredAfterInitialDelay = true; // Mark that VAD path (this handler) has triggered

                // Stop prompt if it's playing (barge-in for 'vadMode')
                // This should not run for 'afterPrompt' because of the earlier check.
                if (mainPlayback && mainPlayback.id && !mainPlayback.destroyed && mainPlayback.state === 'playing' && !promptPlaybackStoppedForInterim) {
                    callLogger.info(`VAD: Stopping mainPlayback ${mainPlayback.id} due to ChannelTalkingStarted (barge-in for vadMode).`);
                    try {
                        // Ensure playback object is still valid before stopping
                        const currentPlayback = await client.playbacks.get({playbackId: mainPlayback.id}).catch(() => null);
                        if (currentPlayback && currentPlayback.state === 'playing') {
                           await mainPlayback.stop();
                        } else {
                           callLogger.info(`VAD: MainPlayback ${mainPlayback.id} was not in a stoppable state during ChannelTalkingStarted. No stop action taken for barge-in.`);
                        }
                    } catch (e) {
                        if (e.message.toLowerCase().includes("playback not found") || e.message.toLowerCase().includes("does not exist")) {
                            callLogger.warn(`VAD: Error stopping mainPlayback ${mainPlayback.id} for barge-in (likely already stopped or finished)`, e);
                        } else {
                            callLogger.error(`VAD: Critical error stopping mainPlayback ${mainPlayback.id} for barge-in`, e);
                        }
                    }
                    promptPlaybackStoppedForInterim = true;
                } else {
                    if (mainPlayback && mainPlayback.state !== 'playing') callLogger.debug(`VAD: mainPlayback was not playing (state: ${mainPlayback.state}) when ChannelTalkingStarted received. No barge-in stop needed for vadMode.`);
                    else if (promptPlaybackStoppedForInterim) callLogger.debug(`VAD: mainPlayback already stopped for interim result/other reason. No barge-in stop needed for vadMode.`);
                    else callLogger.debug(`VAD: mainPlayback not active or ID missing when ChannelTalkingStarted received. No barge-in stop needed for vadMode.`);
                }

                // Clear any pending timers that might conflict
                if (bargeInActivationTimer) { clearTimeout(bargeInActivationTimer); bargeInActivationTimer = null; callLogger.debug('VAD: Cleared bargeInActivationTimer due to ChannelTalkingStarted.'); }
                if (vadMaxWaitAfterPromptTimer) { clearTimeout(vadMaxWaitAfterPromptTimer); vadMaxWaitAfterPromptTimer = null; callLogger.debug('VAD: Cleared vadMaxWaitAfterPromptTimer due to ChannelTalkingStarted.'); }

                // Activate Google Streaming
                callLogger.info('VAD: Activating Google streaming due to ChannelTalkingStarted (all delays complete, not afterPrompt during prompt).');
                await activateGoogleStreamingAndRecognitionLogic(false);
                if (googleStreamingActive) {
                    callLogger.info('VAD: Live streaming initiated by ChannelTalkingStarted. Disabling VAD buffering. Marking buffer for flush if necessary.');
                    isVADBufferingActive = false;
                    pendingVADBufferFlush = true;
                }

                // Remove TALK_DETECT as it's no longer needed
                callLogger.info('VAD: Removing TALK_DETECT from channel post-activation by ChannelTalkingStarted.');
                try {
                    if (channel && !channel.destroyed) {
                        await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
                        callLogger.info('VAD: TALK_DETECT(remove) applied.');
                    }
                } catch (e) {
                    callLogger.error(`VAD: Error removing TALK_DETECT`, e);
                }
            };
            channelTalkingFinishedHandler = (event, chan) => {
                if (isCleanupCalled) { callLogger.debug('VAD: ChannelTalkingFinished event ignored, cleanup already called.'); return; }
                if (chan.id !== channel.id) return;

                if (!vadInitialSilenceDelayCompleted || !vadActivationDelayCompleted) {
                    callLogger.info('VAD: ChannelTalkingFinished event received while VAD delays were active. Marking vadSpeechActiveDuringDelay = false.');
                    vadSpeechActiveDuringDelay = false;
                    // If speech finished *during* the delay, then vadSpeechDetected should also be false
                    // so that when delays complete, we don't mistakenly think speech is still ongoing from that earlier event.
                    vadSpeechDetected = false;
                }
                callLogger.info(`VAD: ChannelTalkingFinished event received for channel ${channel.id}. Silence duration: ${event.duration}`);
            };
            channel.on('ChannelTalkingStarted', channelTalkingStartedHandler);
            channel.on('ChannelTalkingFinished', channelTalkingFinishedHandler);
            callLogger.info('Subscribed to ChannelTalkingStarted and ChannelTalkingFinished events for VAD.');
        } catch (e) { callLogger.error('Error setting TALK_DETECT(set) or subscribing to VAD events', e); }
    }

    if (callConfig.dtmfConfig.enableDtmfRecognition) {
      channel.on('ChannelDtmfReceived', async (event, channelDtmf) => {
        if (isCleanupCalled) { callLogger.debug(`DTMF digit '${event.digit}' received, but cleanup in progress. Ignoring.`); return; }
        callLogger.info(`DTMF digit '${event.digit}' received. Buffer before: '${collectedDtmfDigits}'`);
        collectedDtmfDigits += event.digit;
        callLogger.info(`Buffer after appending: '${collectedDtmfDigits}'. Setting dtmfModeActive.`);
        dtmfModeActive = true;
        speechRecognitionDisabledDueToDtmf = true;
        isVADBufferingActive = false;
        if (pendingVADBufferFlush) { callLogger.info('DTMF received: Clearing pendingVADBufferFlush and VAD audio buffer.'); pendingVADBufferFlush = false; vadAudioBuffer = []; }
        if (mainPlayback && !mainPlayback.destroyed) { callLogger.info('DTMF received, stopping mainPlayback.'); try { await mainPlayback.stop(); promptPlaybackStoppedForInterim = true; } catch (e) { callLogger.warn('Error stopping mainPlayback on DTMF', e); } }
        if (waitingPlayback && !waitingPlayback.destroyed) { callLogger.info('DTMF received, stopping waitingPlayback.'); try { await waitingPlayback.stop(); } catch (e) { callLogger.warn('Error stopping waitingPlayback on DTMF', e); } }
        if (postRecognitionWaitingPlayback && !postRecognitionWaitingPlayback.destroyed) { callLogger.info('DTMF received, stopping postRecognitionWaitingPlayback.'); try { await postRecognitionWaitingPlayback.stop(); } catch (e) { callLogger.warn('Error stopping postRecognitionWaitingPlayback on DTMF', e); } }
        if (googleStreamingActive) {
          callLogger.info('DTMF received, stopping active Google Speech stream. Marking as DTMF interrupted.');
          dtmfInterruptedSpeech = true;
          googleStreamingActive = false;
          isGoogleStreamEnding = true;
          if (speechStream && !speechStream.destroyed) {
            if (!speechStream.writableEnded) { speechStream.end(); callLogger.debug('Called speechStream.end() due to DTMF interruption.'); }
            else { callLogger.debug(`Speech stream was writableEnded=${speechStream.writableEnded} but not destroyed. Forcing destroy due to DTMF.`); speechStream.destroy(new Error('DTMF_INTERRUPT_FORCED_DESTROY')); }
          }
          cleanupTimers();
          speechHasBegun = false;
        }
        if (dtmfInterDigitTimer) clearTimeout(dtmfInterDigitTimer);
        dtmfInterDigitTimer = setTimeout(async () => {
          callLogger.info('DTMF inter-digit timeout reached. Waiting for final timeout or more digits.');
          if (dtmfInterDigitTimer) clearTimeout(dtmfInterDigitTimer);
          dtmfInterDigitTimer = null;
        }, callConfig.dtmfConfig.dtmfInterDigitTimeoutSeconds * 1000);
        if (dtmfFinalTimer) clearTimeout(dtmfFinalTimer);
        dtmfFinalTimer = setTimeout(async () => {
          callLogger.info(`DTMF final timeout reached. Collected digits: ${collectedDtmfDigits}`);
          if (dtmfFinalTimer) clearTimeout(dtmfFinalTimer); dtmfFinalTimer = null;
          if (dtmfInterDigitTimer) clearTimeout(dtmfInterDigitTimer); dtmfInterDigitTimer = null;
          if (dtmfModeActive && collectedDtmfDigits.length > 0) {
            if (channel && !channel.destroyed) {
              try { await channel.setChannelVar({ variable: 'DTMF_DIGITS', value: collectedDtmfDigits }); callLogger.info(`DTMF_DIGITS set to: ${collectedDtmfDigits}`); }
              catch (e) { callLogger.warn('Error setting DTMF_DIGITS', e); }
            }
            finalTranscription = '';
            callLogger.debug('Ensured finalTranscription is empty due to DTMF completion.');
          } else { callLogger.info('DTMF final timeout reached, but no DTMF digits were collected or DTMF mode not active.'); }
          fullCleanup(false, "dtmf_final_timeout");
        }, callConfig.dtmfConfig.dtmfFinalTimeoutSeconds * 1000);
      });
      callLogger.info('Subscribed to ChannelDtmfReceived events.');
    }

    callLogger.info(`Creating user_bridge`);
    user_bridge = await client.bridges.create({type: 'mixing', name: `user_bridge_${channel.id}`});
    callLogger.info(`Adding user channel ${channel.id} to user_bridge ${user_bridge.id}`);
    await user_bridge.addChannel({channel: channel.id});

    mainPlayback = client.Playback();
    let onPlaybackFailedHandler = null;
    const playbackFinishedPromise = new Promise((resolve, reject) => {
        const resolveAndCleanup = (status) => { if (onPlaybackFailedHandler) client.removeListener('PlaybackFailed', onPlaybackFailedHandler); resolve(status); };
        onPlaybackFailedHandler = (evt, instance) => { if (instance && instance.id === mainPlayback.id) { client.removeListener('PlaybackFailed', onPlaybackFailedHandler); reject(new Error(`Main playback ${mainPlayback.id} failed.`)); } };
        mainPlayback.once('PlaybackFinished', () => resolveAndCleanup('finished'));
        mainPlayback.once('PlaybackStopped', () => resolveAndCleanup('stopped'));
        client.on('PlaybackFailed', onPlaybackFailedHandler);
    });

    rtpServer = new RtpServer(callLogger, callConfig.asterisk.rtpHostIp);
    const rtpServerAddress = await rtpServer.start(0);
    const externalHostPort = `${rtpServerAddress.host}:${rtpServerAddress.port}`;
    const audioFormatForExternalMedia = callConfig.googleSpeech.encoding === 'MULAW' ? 'ulaw' : 'slin16';

    const snoopId = `${channel.id}_snoop_${Date.now()}`;
    callLogger.info(`Creating snoop channel with ID ${snoopId} for user channel ${channel.id} with app ${asteriskConfig.ariAppName} and spy 'in'.`);
    try {
        snoop_channel = await client.channels.snoopChannelWithId({channelId: channel.id, snoopId: snoopId, app: asteriskConfig.ariAppName, spy: 'in'});
        callLogger.info(`Snoop channel ${snoop_channel.id} created`);
    } catch (snoopErr) {
        callLogger.error('Failed to create snoop channel', snoopErr);
        await fullCleanup(true, "snoop_channel_creation_failed"); return;
    }

    callLogger.info(`Creating snoop_bridge`);
    try {
        snoop_bridge = await client.bridges.create({type: 'mixing', name: `snoop_bridge_${channel.id}`});
        callLogger.info(`Snoop_bridge ${snoop_bridge.id} created.`);
    } catch (bridgeErr) {
        callLogger.error('Failed to create snoop_bridge', bridgeErr);
        await fullCleanup(true, "snoop_bridge_creation_failed"); return;
    }

    callLogger.info(`Creating externalMediaChannel for app ${asteriskConfig.ariAppName} to ${externalHostPort}`);
    try {
        externalMediaChannel = await client.channels.externalMedia({ app: asteriskConfig.ariAppName, external_host: externalHostPort, format: audioFormatForExternalMedia, encapsulation: 'rtp' });
        activeExternalMediaChannelIds.add(externalMediaChannel.id);
        callLogger.info(`ExternalMediaChannel ${externalMediaChannel.id} created.`);
    } catch (extMediaErr) {
        callLogger.error('Failed to create externalMediaChannel', extMediaErr);
        await fullCleanup(true, "external_media_channel_creation_failed"); return;
    }

    try {
        await addChannelWithRetry(snoop_bridge, externalMediaChannel.id, callLogger, 5, 200, "externalMediaChannel to snoop_bridge");
    } catch (addExtErr) {
        callLogger.error(`Failed to add externalMediaChannel ${externalMediaChannel.id} to snoop_bridge ${snoop_bridge.id} after retries`, addExtErr);
        await fullCleanup(true, "add_extmedia_to_snoop_bridge_failed"); return;
    }

    try {
        await addChannelWithRetry(snoop_bridge, snoop_channel.id, callLogger, 5, 200, "snoop_channel to snoop_bridge");
    } catch (addSnoopErr) {
        callLogger.error(`Failed to add snoop_channel ${snoop_channel.id} to snoop_bridge ${snoop_bridge.id} after retries`, addSnoopErr);
        if (snoop_channel && !snoop_channel.destroyed) { try { await snoop_channel.hangup(); } catch (e) { callLogger.warn(`Error hanging up snoop_channel after failing to add to bridge`, e); } }
        await fullCleanup(true, "add_snoop_to_snoop_bridge_failed"); return;
    }

    callLogger.info(`Media path setup: UserBridge ${user_bridge.id}, RtpServer on ${externalHostPort}, SnoopChannel ${snoop_channel.id}, ExtMediaChannel ${externalMediaChannel.id}, SnoopBridge ${snoop_bridge.id}.`);

    if (rtpServer) {
         rtpServer.on('audioPacket', (audioPayload) => {
            if (callConfig.audio.captureAudioEnabled) {
                if (!audioFileStream) {
                    audioFilePath = path.join(callConfig.audio.captureAudioPath, `${callerIdForFile}_${Date.now()}_full.raw`);
                    try {
                        fs.mkdirSync(callConfig.audio.captureAudioPath, { recursive: true });
                        audioFileStream = fs.createWriteStream(audioFilePath);
                        callLogger.info(`Full audio capture started to: ${audioFilePath}`);
                    } catch (e) { callLogger.error(`Failed to create full audio capture file ${audioFilePath}`, e); audioFileStream = null; }
                }
                if (audioFileStream && !audioFileStream.destroyed) audioFileStream.write(audioPayload);
            }
            if (callConfig.appRecognitionConfig.recognitionActivationMode === 'vad' && isVADBufferingActive) {
                vadAudioBuffer.push(audioPayload);
                if (vadAudioBuffer.length > MAX_VAD_BUFFER_PACKETS) vadAudioBuffer.shift();
            }
            if (googleStreamingActive && rtpServer) {
                 if (callConfig.appRecognitionConfig.recognitionActivationMode !== 'vad' || (vadSpeechDetected && !isFlushingVADBuffer)) {
                    rtpServer.emit('audioPacketForGoogle', audioPayload);
                }
            }
        });
         rtpServer.on('error', (err) => { if (!googleStreamingActive && !isCleanupCalled) { fullCleanup(true, "early_rtp_server_error");} });
    }

    callLogger.info(`Playing greeting '${callConfig.audio.greetingPath}'`);
    channel.play({ media: `sound:${callConfig.audio.greetingPath}` }, mainPlayback)
      .catch(e => { if (onPlaybackFailedHandler) client.removeListener('PlaybackFailed', onPlaybackFailedHandler); fullCleanup(true, "greeting_playback_start_failed"); });

    maxRecognitionDurationTimer = setTimeout(() => { fullCleanup(true, "max_duration_timeout"); }, callConfig.appRecognitionConfig.maxRecognitionDurationSeconds * 1000);

    if (callConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
        if (callConfig.appRecognitionConfig.recognitionActivationMode === "immediate") {
             if (!googleStreamingActive && !isCleanupCalled) { // Ensure not already activated by VAD if VAD is somehow on
                await activateGoogleStreamingAndRecognitionLogic(false);
             }
        } else if (callConfig.appRecognitionConfig.recognitionActivationMode === "fixedDelay") {
            if (callConfig.appRecognitionConfig.bargeInDelaySeconds > 0) {
                bargeInActivationTimer = setTimeout(async () => {
                    if (isCleanupCalled || (channel && channel.destroyed)) {
                        callLogger.debug('fixedDelay: bargeInActivationTimer expired, but cleanup called or channel destroyed. Ignoring.');
                        return;
                    }

                    callLogger.info(`fixedDelay: bargeInActivationTimer expired. Attempting to activate Google streaming (isBargeInByTimer=true).`);
                    if (!googleStreamingActive) {
                        await activateGoogleStreamingAndRecognitionLogic(true); // true indicates it's by this timer
                    } else {
                        callLogger.debug('fixedDelay: bargeInActivationTimer expired, but Google streaming is already active. No new activation needed.');
                    }
                }, callConfig.appRecognitionConfig.bargeInDelaySeconds * 1000);
            } else { // bargeInDelaySeconds <= 0
                 callLogger.info(`fixedDelay: bargeInDelaySeconds is <= 0. Attempting immediate activation.`);
                 if (!isCleanupCalled && !googleStreamingActive) {
                    await activateGoogleStreamingAndRecognitionLogic(false); // isBargeInByTimer = false for immediate
                 } else if (googleStreamingActive) {
                    callLogger.debug('fixedDelay: bargeInDelaySeconds <= 0, but Google streaming already active.');
                 } else { // isCleanupCalled must be true
                    callLogger.debug('fixedDelay: bargeInDelaySeconds <= 0, but cleanup already called.');
                 }
            }
        }
    }

    const playbackStatus = await playbackFinishedPromise;
    callLogger.info(`Greeting playback status: ${playbackStatus}. Google streaming active: ${googleStreamingActive}, Cleanup called: ${isCleanupCalled}. Mode: ${callConfig.appRecognitionConfig.recognitionActivationMode}`);

    /**
     * Handles VAD logic after the initial prompt playback has finished or been stopped.
     * This function centralizes the decision-making for post-prompt VAD actions,
     * ensuring that all relevant delay timers (`vadInitialSilenceDelayTimer`, `vadActivationDelayTimer`)
     * have completed before proceeding. It also checks `vadRecognitionTriggeredAfterInitialDelay`
     * to prevent redundant activations if speech was already handled by `ChannelTalkingStarted`.
     * @async
     * @private
     */
    const handlePostPromptVADLogic = async () => {
        if (isCleanupCalled) {
            callLogger.info('VAD Post-Prompt: Cleanup already called, skipping post-prompt VAD logic.');
            return;
        }
        if (callConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
            return; // Not VAD mode
        }

        // Handle "afterPrompt" VAD activation first.
        if (callConfig.appRecognitionConfig.vadRecogActivation === 'afterPrompt') {
            callLogger.info('VAD Post-Prompt ("afterPrompt"): Activating recognition. APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS is ignored in this mode.');

            if (googleStreamingActive || vadRecognitionTriggeredAfterInitialDelay) {
                callLogger.info('VAD Post-Prompt ("afterPrompt"): Skipping activation as Google stream is already active or VAD recognition was already triggered.');
                return;
            }

            vadSpeechDetected = true; // Assuming speech will follow, or for consistency with other activation paths.
            vadRecognitionTriggeredAfterInitialDelay = true; // Mark that VAD path has triggered recognition.

            await activateGoogleStreamingAndRecognitionLogic(false);
            if (googleStreamingActive) {
                callLogger.info('VAD Post-Prompt ("afterPrompt"): Live streaming initiated. Disabling VAD buffering. Marking buffer for flush.');
                isVADBufferingActive = false;
                pendingVADBufferFlush = true;
            }

            callLogger.info('VAD Post-Prompt ("afterPrompt"): Removing TALK_DETECT from channel (if it was set).');
            try {
                if (channel && !channel.destroyed) {
                    await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
                    callLogger.info('VAD Post-Prompt ("afterPrompt"): TALK_DETECT(remove) applied.');
                }
            } catch (e) {
                callLogger.error('VAD Post-Prompt ("afterPrompt"): Error removing TALK_DETECT', e);
            }
            return; // IMPORTANT: Exit after handling "afterPrompt"
        }

        // The rest of the logic is now for vadRecogActivation === 'vadMode'

        // First, ensure all VAD startup delays are completed. If not, defer.
        if (!vadInitialSilenceDelayCompleted) {
            callLogger.info('VAD Post-Prompt ("vadMode"): Initial silence delay NOT YET completed. Deferring further post-prompt VAD logic until delay timer expires.');
            return;
        }
        if (!vadActivationDelayCompleted) {
            callLogger.info('VAD Post-Prompt ("vadMode"): General VAD activation delay NOT YET completed. Deferring further post-prompt VAD logic until delay timer expires.');
            return;
        }

        callLogger.info(`VAD Post-Prompt ("vadMode"): Evaluating. All startup delays complete. Prompt finished. Speech active during delay period: ${vadSpeechActiveDuringDelay}. Recognition already triggered: ${vadRecognitionTriggeredAfterInitialDelay}. Google streaming: ${googleStreamingActive}.`);

        // If recognition has already been triggered by VAD (e.g., by ChannelTalkingStarted after delays, or by delay timer itself), do nothing further here.
        if (vadRecognitionTriggeredAfterInitialDelay || googleStreamingActive) {
             callLogger.debug(`VAD Post-Prompt ("vadMode"): Recognition already triggered or Google streaming active. No further VAD action needed here.`);
             return;
        }

        // At this point, all startup delays are complete, prompt is finished, and VAD-based recognition has NOT yet been triggered.
        // The decision now depends on whether speech was active *during* the delay periods.

        if (vadSpeechActiveDuringDelay) {
            // Speech was active during the delays and didn't stop. Since delays and prompt are now finished, activate recognition.
            callLogger.info('VAD Post-Prompt ("vadMode"): Speech was active during VAD delays and did not stop. Activating recognition now as prompt is also finished.');
            if (!isCleanupCalled) {
                vadSpeechDetected = true; // Confirming speech was effectively detected for this path
                vadRecognitionTriggeredAfterInitialDelay = true;
                await activateGoogleStreamingAndRecognitionLogic(false);
                if (googleStreamingActive) {
                    callLogger.info('VAD Post-Prompt ("vadMode"): Live streaming initiated (due to speech during delays). Disabling VAD buffering. Marking buffer for flush.');
                    isVADBufferingActive = false;
                    pendingVADBufferFlush = true;
                }
                callLogger.info('VAD Post-Prompt ("vadMode"): Removing TALK_DETECT post-activation.');
                try { if (channel && !channel.destroyed) await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }); }
                catch(e){ callLogger.error(`VAD Post-Prompt ("vadMode"): Error removing TALK_DETECT`, e);}
            } else {
                callLogger.debug('VAD Post-Prompt ("vadMode"): Cleanup called, aborting activation even though speech was active during delay.');
            }
        } else {
            // vadSpeechActiveDuringDelay is false: User was silent when the initial delay(s) completed, or speech started and stopped during the delay.
            // Now that the prompt is also finished, we wait for a *new* ChannelTalkingStarted event.
            callLogger.info(`VAD Post-Prompt ("vadMode"): User was silent at the end of VAD delays (or speech stopped during delays). Prompt is now finished. Waiting for a new ChannelTalkingStarted event or vadMaxWaitAfterPromptSeconds timeout.`);

            if (callConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds > 0) {
                callLogger.info(`VAD Post-Prompt ("vadMode"): Starting vadMaxWaitAfterPromptTimer for ${callConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds}s.`);
                if (vadMaxWaitAfterPromptTimer) {
                    clearTimeout(vadMaxWaitAfterPromptTimer);
                }
                vadMaxWaitAfterPromptTimer = setTimeout(async () => {
                    if (isCleanupCalled) { // Explicit first check
                        callLogger.debug('VAD Post-Prompt ("vadMode"): vadMaxWaitAfterPromptTimer expired, but cleanup already called. Ignoring.');
                        return;
                    }
                    // Existing conditions, now isCleanupCalled is checked upfront
                    if (!vadSpeechDetected && !googleStreamingActive && !vadRecognitionTriggeredAfterInitialDelay && channel && !channel.destroyed) {
                        callLogger.warn(`VAD Post-Prompt ("vadMode"): Max wait time (${callConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds}s) after prompt expired. No new speech detected. Cleaning up.`);
                        try {
                            // Re-check channel before use, though isCleanupCalled should also guard channel operations indirectly.
                            if (channel && !channel.destroyed) {
                                await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
                                callLogger.info('VAD Post-Prompt ("vadMode"): TALK_DETECT(remove) applied due to max wait timeout.');
                            }
                        } catch (e) {
                            callLogger.error('VAD Post-Prompt ("vadMode"): Error removing TALK_DETECT on max wait timeout', e);
                        }
                        fullCleanup(false, "vad_max_wait_after_prompt_timeout");
                    } else {
                        callLogger.debug(`VAD Post-Prompt ("vadMode"): vadMaxWaitAfterPromptTimer expired, but conditions for cleanup not met (vadSpeechDetected=${vadSpeechDetected}, googleStreamingActive=${googleStreamingActive}, vadRecognitionTriggeredAfterInitialDelay=${vadRecognitionTriggeredAfterInitialDelay}). No action.`);
                    }
                }, callConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds * 1000);
            } else {
                callLogger.info('VAD Post-Prompt ("vadMode"): vadMaxWaitAfterPromptSeconds is 0 or less. Not starting wait timer. If no ChannelTalkingStarted occurs, call might hang until other timeouts.');
                // Potentially, if no speech and no timer, this could be a cleanup point if desired.
                // For now, it relies on ChannelTalkingStarted or other cleanup mechanisms.
            }
        }
    };

    await handlePostPromptVADLogic(); // Initial call after prompt finishes

    if (isCleanupCalled) {
        callLogger.info(`Cleanup was called during or after playback. Skipping post-playback activation logic.`);
    } else {
        if (callConfig.appRecognitionConfig.recognitionActivationMode !== 'vad') {
            if (callConfig.appRecognitionConfig.recognitionActivationMode === "fixedDelay") {
                if (googleStreamingActive) {
                    callLogger.info(`'fixedDelay' mode. Prompt finished/stopped, but Google streaming is already active. No action needed here.`);
                } else {
                    if (bargeInActivationTimer) {
                        callLogger.info(`Prompt finished/stopped. 'fixedDelay' mode. bargeInActivationTimer is still pending. Waiting for timer or subsequent speech to activate recognition.`);
                    } else {
                        callLogger.info(`Prompt finished/stopped. 'fixedDelay' mode. No pending bargeInActivationTimer and not streaming. Activating recognition now.`);
                        await activateGoogleStreamingAndRecognitionLogic(false);
                    }
                }
            } else {
                if (bargeInActivationTimer) { clearTimeout(bargeInActivationTimer); bargeInActivationTimer = null; }
                if (!googleStreamingActive) {
                    callLogger.info(`Prompt finished/stopped. Non-fixedDelay mode (e.g. 'immediate') and not streaming. Activating recognition now.`);
                    await activateGoogleStreamingAndRecognitionLogic(false);
                } else { callLogger.info(`Prompt finished/stopped. Non-fixedDelay mode. Google streaming already active. No action needed.`);}
            }
          }
        }
      } catch (err) {
        callLogger.error('Outer StasisStart error (after playback promise)', err);
        await fullCleanup(true, "outer_stasis_start_error_post_playback");
      }
    });
    client.on('StasisEnd', async (event, channel) => { logger.info(`StasisEnd: Channel ${channel.id} (State: ${channel.state}), Name: ${channel.name}.`); if (activeExternalMediaChannelIds.has(channel.id)) { activeExternalMediaChannelIds.delete(channel.id); } });
    client.on('WebSocketClose', (event) => {
      const message = `ARI WebSocket connection closed. Code: ${event.code}, Reason: '${event.reason}', Clean: ${event.wasClean}`;
      if (logger.isLevelEnabled('debug')) {
        logger.debug(`ARI WebSocket connection closed (debug): ${JSON.stringify(event)}`);
      }
      // Log as warn if not clean or if code is abnormal (typically > 1000, 1001 is going away which is normal)
      // Standard close codes: https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
      if (!event.wasClean || (event.code > 1001 && event.code !== 1005 && event.code !== 1006 )) { // 1005: No Status Rcvd, 1006: Abnormal Closure
        logger.warn(message);
      } else {
        logger.info(message);
      }
    });
    client.on('WebSocketError', (error) => {
      if (logger.isLevelEnabled('debug')) {
        logger.error('ARI WebSocket error (debug):', error); // Already passing full error
      } else {
        logger.error('ARI WebSocket error', error); // Pass full error
      }
    });

    await client.start(asteriskConfig.ariAppName);
    logger.info(`ARI application '${asteriskConfig.ariAppName}' started successfully.`);
  } catch (err) { logger.error('ARI client initialization failed', err); process.exit(1); }
}
module.exports = { initAriClient, logger };
