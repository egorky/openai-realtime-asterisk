# NodeJS ARI Speech-to-Text Application

## 1. Overview

This application is a Node.js-based Asterisk ARI (Asterisk REST Interface) client designed to integrate real-time speech-to-text capabilities into an Asterisk dialplan using Google Cloud Speech-to-Text API.

When a call is routed to this ARI application:
1.  It answers the call.
2.  Plays a configurable greeting message.
3.  Listens to the caller's speech, allowing for **barge-in** (caller can speak over the greeting).
4.  Streams the caller's audio in real-time to Google Speech-to-Text.
5.  Utilizes **Voice Activity Detection (VAD)** to determine when the caller starts and stops speaking (feature of Google Speech API).
6.  If the caller doesn't speak within a configurable timeout, the application notifies Asterisk.
7.  Once the caller finishes speaking, it may play a brief "waiting" message if fallback transcription is attempted.
8.  Receives the transcription from Google Speech.
9.  Returns the transcribed text (and timeout/status information) to the Asterisk dialplan as channel variables.
10. The Asterisk dialplan can then use this information for further call routing or actions.

## 2. Features

*   **ARI Integration:** Connects to Asterisk using `ari-client`.
*   **Google Cloud Speech-to-Text:** Uses `@google-cloud/speech` for streaming transcription.
*   **Dynamic Configuration:** Call-specific configuration via Asterisk Dialplan variables, environment variables, or defaults.
*   **Configurable Speech Parameters:** Extensive options for Google Speech (language, model, VAD behavior, etc.).
*   **Barge-in:** Callers can interrupt the initial greeting.
*   **Voice Activity Detection (VAD):**
    *   Leverages Google Speech API's VAD capabilities, including configurable timeouts.
    *   Supports Asterisk-side VAD (`TALK_DETECT`) to control when to start streaming to Google, including buffering initial audio.
*   **No-Speech Timeout:** Handles cases where the caller remains silent.
*   **Fallback Batch Transcription:** Option to perform batch transcription on captured audio if streaming fails or yields no result.
*   **Feedback Audio:** Plays a waiting prompt during fallback processing.
*   **Channel Variables:** Returns results (`SPEECH_TEXT`, `SPEECH_FALLBACK_STATUS`, etc.) to Asterisk.
*   **Configurable Logging:** Uses `winston` for detailed and configurable logging to console and optionally to a file. Call-specific logs include `callId` and `callerNumber`. File logging status is also reported in the logs.
*   **Detailed Dialplan Example:** Includes a sample `extensions.conf`.

## Voice Activity Detection (VAD)

This application supports Voice Activity Detection (VAD) to control when audio streaming to Google Speech begins. When VAD mode is enabled, the system waits for the caller to start speaking before initiating the speech recognition process. This can help in scenarios where there might be a delay before the caller speaks, reducing unnecessary streaming and API usage.

### Enabling VAD Mode

To enable VAD mode, set the following configuration variable:

*   **`RECOGNITION_ACTIVATION_MODE`**: Set to `"vad"`.
    *   Environment Variable: `RECOGNITION_ACTIVATION_MODE="vad"`
    *   `config/default.json`: `"recognitionActivationMode": "vad"` (within `appRecognitionConfig`)

### VAD Configuration Parameters

The following parameters control the VAD behavior and are configured under `appRecognitionConfig` in `config/default.json` or via corresponding environment variables (prefixed with `APP_APPRECOGNITION_`):

*   **`vadSilenceThresholdMs`**: The amount of silence (in milliseconds) after which Asterisk's `TALK_DETECT` function will consider the caller to have stopped speaking. This is used by Asterisk to trigger `ChannelTalkingFinished`.
    *   Default: `2500`
    *   Environment Variable: `APP_APPRECOGNITION_VADSILENCETHRESHOLDMS`
*   **`vadTalkThreshold`**: The energy level threshold (relative to Asterisk's internal calculations) above which audio is considered speech by `TALK_DETECT`. This is used by Asterisk to trigger `ChannelTalkingStarted`.
    *   Default: `256`
    *   Environment Variable: `APP_APPRECOGNITION_VADTALKTHRESHOLD`
*   **`vadRecogActivation`**: Determines when recognition should start if the initial prompt finishes and the caller hasn't spoken yet (only applicable in VAD mode).
    *   `"vadMode"` (default): Wait for VAD (Asterisk's `ChannelTalkingStarted` event) to detect speech, up to `vadMaxWaitAfterPromptSeconds`.
    *   `"afterPrompt"`: Start recognition immediately after the prompt finishes, even if VAD hasn't detected speech.
    *   Environment Variable: `APP_APPRECOGNITION_VADRECOGACTIVATION`
*   **`vadMaxWaitAfterPromptSeconds`**: If `vadRecogActivation` is `"vadMode"`, this is the maximum time (in seconds) the system will wait for the caller to start speaking *after* the initial prompt has finished (and after any `vadInitialSilenceDelaySeconds` or `vadActivationDelaySeconds` have completed). If no speech is detected, it may proceed to cleanup.
    *   Default: `10.0`
    *   Environment Variable: `APP_APPRECOGNITION_VADMAXWAITAFTERPROMPTSECONDS`
*   **`vadInitialSilenceDelaySeconds`**: If `recognitionActivationMode` is `"vad"` and `vadRecogActivation` is `"vadMode"`, this specifies an initial period (in seconds) from the call's start during which the VAD logic will not immediately react to speech detections (e.g., by starting Google Stream). Audio is still buffered. This helps avoid premature VAD activation on initial call noise.
    *   Default: `0.0`
    *   Environment Variable: `APP_APPRECOGNITION_VADINITIALSILENCEDELAYSECONDS`
*   **`vadActivationDelaySeconds`**: Also applicable when `recognitionActivationMode` is `"vad"` AND `vadRecogActivation` is `"vadMode"`, this is an additional general delay before VAD event reactions are fully processed. It works in conjunction with `vadInitialSilenceDelaySeconds`.
    *   During this delay:
        *   `TALK_DETECT` is active on the Asterisk channel.
        *   Incoming audio from the caller IS buffered by the application.
        *   If a `ChannelTalkingStarted` event occurs, the application notes that speech has started (`vadSpeechDetected = true`) but defers the primary reaction (like stopping prompts or activating Google streaming) until the delay completes.
        *   If the main greeting prompt finishes during this delay, the subsequent VAD logic (like starting `vadMaxWaitAfterPromptTimer` or immediate activation for `"afterPrompt"`) is also deferred until this delay completes.
    *   Once the delay timer expires (`vadActivationDelayCompleted = true`):
        *   If speech was detected *during* the delay, and the prompt has also finished, the application can then proceed to activate Google streaming.
        *   If the prompt finished *during* the delay and no speech was detected, the application can now start the `vadMaxWaitAfterPromptTimer` (for `"vadMode"`) or activate Google streaming (for `"afterPrompt"`).
    *   This delay helps prevent premature VAD reactions on noisy lines or if initial call setup artifacts might trigger `ChannelTalkingStarted` falsely.
    *   See `docs/variables.md` and `docs/timeout-management.md` for more details.
    *   Default: `0.0` (no delay)
    *   Environment Variable: `APP_APPRECOGNITION_VADACTIVATIONDELAYSECONDS`

### How VAD Works

1.  **Initialization**:
    *   When a call starts and `RECOGNITION_ACTIVATION_MODE="vad"`:
        *   Asterisk's `TALK_DETECT` function is enabled on the caller's channel using the configured `vadSilenceThresholdMs` and `vadTalkThreshold`.
        *   If `vadRecogActivation="vadMode"` and `vadActivationDelaySeconds > 0`, a timer starts. The system will buffer audio and note `ChannelTalkingStarted` events, but full processing of these events (like stopping prompts or starting Google Stream) is deferred until this delay completes. The `vadActivationDelayCompleted` flag tracks this state.

2.  **Prompting & Audio Buffering**:
    *   The system plays any initial greeting prompt.
    *   While waiting for speech (or for the `vadActivationDelaySeconds` to complete), incoming audio from the caller is buffered locally by the application (`vadAudioBuffer`). This ensures that the very beginning of the utterance is captured.

3.  **Speech Detection (`ChannelTalkingStarted`)**:
    *   If the caller starts speaking, Asterisk generates a `ChannelTalkingStarted` event.
    *   **If `vadActivationDelaySeconds` was active and has not yet completed**: The application sets an internal flag (`vadSpeechDetected = true`) but takes no immediate other action.
    *   **If `vadActivationDelayCompleted` is true (either no delay was configured, or it has passed)**:
        *   The application sets `vadSpeechDetected = true`.
        *   It stops any currently playing prompt.
        *   Any VAD-specific timers like `vadMaxWaitAfterPromptTimer` are cleared.
        *   It initiates the streaming connection to Google Speech (`activateGoogleStreamingAndRecognitionLogic`).
        *   The application then waits for Google to signal `SPEECH_ACTIVITY_BEGIN` or send an interim transcript. Once this occurs (or if `vadRecogActivation="afterPrompt"` forces it), the buffered audio (`vadAudioBuffer`) is flushed to Google, followed by live audio.
        *   `TALK_DETECT` is removed from the channel.

4.  **Post-Prompt Behavior (If No Speech During Prompt)**:
    *   This logic applies if the initial prompt finishes playing AND `vadActivationDelayCompleted` is true.
    *   If `ChannelTalkingStarted` has not yet been processed (i.e., `vadSpeechDetected` is false):
        *   If `vadRecogActivation` is `"afterPrompt"`: The application immediately behaves as if speech was detected (sets `vadSpeechDetected=true`, initiates Google streaming, prepares to flush buffer, removes `TALK_DETECT`).
        *   If `vadRecogActivation` is `"vadMode"`: The `vadMaxWaitAfterPromptTimer` (using `vadMaxWaitAfterPromptSeconds`) starts.
            *   If `ChannelTalkingStarted` occurs before this timer expires, recognition proceeds as per step 3. The timer is cleared.
            *   If the timer expires before speech, `TALK_DETECT` is removed, and the call proceeds to `fullCleanup` (potentially triggering fallback transcription).

5.  **DTMF Interaction**:
    *   If DTMF digits are received at any point while VAD is active (including during `vadActivationDelaySeconds`, while `vadMaxWaitAfterPromptTimer` is running, or while buffering audio before Google streaming is fully active):
        *   DTMF handling takes precedence.
        *   All VAD-specific timers (`vadActivationDelayTimer`, `vadMaxWaitAfterPromptTimer`) are cleared.
        *   Any pending VAD-based speech recognition is aborted. Audio buffering for VAD stops.
        *   The system proceeds with DTMF collection and logic, and speech recognition for that interaction is typically not performed.

## 3. Prerequisites

*   **Node.js:** Version 12.x or higher recommended.
*   **NPM:** Node Package Manager (comes with Node.js).
*   **Asterisk:** Version 13.8+ (preferably newer for better ARI support). ARI must be enabled and configured.
    *   Ensure `res_ari.so` module is loaded in Asterisk.
    *   Configure ARI in `ari.conf` (e.g., enable it, set user/password).
    *   Configure HTTP server in `http.conf` (e.g., enable it, set bind address/port).
*   **Google Cloud Platform (GCP) Account:**
    *   A GCP project with the **Cloud Speech-to-Text API** enabled.
    *   Service Account credentials (a JSON key file) with permissions to use the Speech-to-Text API. Download this JSON file.

## 4. Installation

1.  **Clone the repository (if applicable) or download the files.**
2.  **Navigate to the project directory:**
    ```bash
    cd path/to/your-ari-speech-app
    ```
3.  **Install dependencies:**
    ```bash
    npm install
    ```

## 5. Configuration Layers
The application uses a layered configuration system. Settings are resolved with the following precedence (highest to lowest):
1.  **Asterisk Dialplan Variables (Call-Specific)**
2.  **Environment Variables (System-Wide)**
3.  **`config/default.json` (Application Defaults)**

For a comprehensive list and detailed explanation of all configurable variables, including their Dialplan names, environment variable equivalents, `config/default.json` paths, types, default values, and supported settings, please see the **[Variable Documentation](./docs/variables.md)**.

For a detailed explanation of how the various application-level and Google VAD timeout settings interact, please see [Timeout Management and Interactions](./docs/timeout-management.md).

An overview of key configuration areas:

*   **Asterisk ARI Connection:** Settings for connecting to your Asterisk server's REST Interface (`ASTERISK_ARI_URL`, `ASTERISK_ARI_USERNAME`, etc.).
*   **Google Cloud Credentials:** Path to your Google Cloud service account JSON key file (`GOOGLE_APPLICATION_CREDENTIALS`).
*   **Logging:** Configuration for console and optional file logging (`LOG_LEVEL`, `LOG_FILE_ENABLED`, etc.).
*   **Recognition Behavior:** Parameters controlling how and when speech recognition activates, including Voice Activity Detection (VAD) settings (`RECOGNITION_ACTIVATION_MODE`, VAD thresholds, timeouts), barge-in behavior, and general speech detection timeouts.
*   **Audio Settings:** Paths for greeting and waiting prompts, audio capture settings for fallback transcription.
*   **Google Speech-to-Text Parameters:** Detailed settings for the Google Speech API, such as language, model, encoding, sample rate, and advanced features like punctuation, word confidence, and diarization.
*   **DTMF (Touch-Tone) Handling:** Configuration for detecting and managing DTMF input from the caller.

Please refer to **[docs/variables.md](./docs/variables.md)** for the complete reference.

## 6. DTMF Support

This application supports Dual-Tone Multi-Frequency (DTMF) signaling. For detailed configuration of DTMF settings (enabling/disabling, timeouts), please refer to the [DTMF Configuration section in the Variable Documentation](./docs/variables.md#dtmf-configuration).

Key features include:
- **DTMF Collection**: Captures digits pressed by the caller.
- **Interrupts Playback/Speech**: DTMF input will immediately interrupt any ongoing voice prompts (greeting, waiting audio) or active speech recognition sessions (including VAD buffering or active streaming to Google). VAD-related timers are cleared, and speech recognition is aborted for the current interaction.
- **Channel Variable**: The collected DTMF digits are stored in the Asterisk channel variable `DTMF_DIGITS`. Speech transcription variables (like `SPEECH_TEXT`) are typically cleared or not set if DTMF is the primary interaction.

## 7. Audio Prompts

The application utilizes several types of audio prompts, configurable via `config/default.json`, environment variables, or Asterisk dialplan variables. Paths should be relative to Asterisk's sounds directory (e.g., `sounds/your-prompt` for `/var/lib/asterisk/sounds/your-prompt.wav`).

*   **Greeting Audio (`audio.greetingPath`)**:
    *   Played when the call is first answered.
    *   Can be interrupted by the caller speaking (barge-in) or by DTMF input.

*   **Waiting Audio (`audio.waitingPath`)**:
    *   This prompt has two primary uses related to the "Forced Waiting Audio" feature and fallback batch transcription.
    *   **During Fallback Batch Transcription**: If `enableFallbackBatchTranscription` is true and a fallback attempt is made, a waiting prompt (from `audio.waitingPath`) is played to the caller *while* the batch transcription is processed by Google. This informs the caller that processing is still ongoing.
    *   **Forced Waiting Audio (Post-Recognition)**:
        *   Controlled by `audio.forceWaitingAudio` (boolean) and `audio.waitingAudioMode` (string: `"playFullBeforeDialplan"` or `"playAndTransfer"`).
        *   If `audio.forceWaitingAudio` is `true`, the audio file(s) specified in `audio.waitingPath` will be played *after* the main speech recognition attempt (if any) is complete and *before* control is returned to the Asterisk dialplan (if the Stasis app is not hanging up the call).
        *   `audio.waitingPath` can be a single file or a comma-separated list of files for random playback in this mode.
        *   **`"playFullBeforeDialplan"` Mode**: The application waits for the entire waiting audio to finish before returning to the dialplan.
        *   **`"playAndTransfer"` Mode**: The application starts playing the audio and immediately returns to the dialplan. It sets the channel variable `FORCED_WAITING_AUDIO_ACTIVE="true"`. The dialplan is then responsible for stopping this audio playback (e.g., using `StopPlaytones()`) when appropriate (e.g., agent answers) and can clear or update the `FORCED_WAITING_AUDIO_ACTIVE` variable.
        *   Refer to `docs/variables.md` for detailed configuration of these parameters.

You **must** replace placeholder text files (like `sounds/greeting.txt`, `sounds/waiting.txt`) with actual audio files in a format Asterisk can play (e.g., `.wav`, `.gsm`).

## 8. Running the Application

1.  **Ensure Asterisk is running and ARI is configured.**
2.  **Set up your `.env` file and other configurations as described above.**
3.  **Start the Node.js application:**
    ```bash
    node src/app.js
    ```
    You should see log messages indicating it's connecting to ARI and the application has started.

## 9. Asterisk Dialplan Setup

The file `asterisk/extensions.conf` contains a sample dialplan. You need to integrate this or similar logic into your main Asterisk dialplan configuration.

Key aspects:
*   It uses `Stasis(speech-to-text-app)` to send the call to this Node.js application. Ensure the application name matches `ASTERISK_ARI_APP_NAME`.
*   **Setting Dialplan Variables:** Before calling `Stasis()`, you can set the `APP_` variables:
    ```
    exten => s,n,Set(APP_AUDIO_GREETINGPATH=custom/my_specific_greeting)
    exten => s,n,Set(CHANNEL(language)=es-MX) ; To set language for this call
    exten => s,n,Set(APP_GOOGLESPEECH_ENABLEVOICEACTIVITYTIMEOUT=true)
    exten => s,n,Set(APP_GOOGLESPEECH_VOICEACTIVITYTIMEOUT_SPEECHSTARTTIMEOUTSECONDS=5.0)
    exten => s,n,Stasis(speech-to-text-app)
    ```
*   After the ARI application finishes, it checks for `SPEECH_TEXT` and other status variables.

Refer to the comments within `asterisk/extensions.conf` for more details.

## 10. Logging

*   Logging is handled by `winston`.
*   **Console Logging:**
    *   Log level can be set via the `LOG_LEVEL` environment variable in `.env` or `logging.level` in `config/default.json`.
    *   Console logging can be globally enabled/disabled via `logging.enabled` in `config/default.json`.
*   **File Logging (Global):**
    *   File logging can be enabled by setting `LOG_FILE_ENABLED=true` in the `.env` file or `logging.fileLoggingEnabled: true` in `config/default.json`.
    *   The log file path can be set via `LOG_FILE_PATH` in `.env` or `logging.filePath` in `config/default.json` (default: `./app.log`).
    *   The log level for the file can be set via `LOG_FILE_LEVEL` in `.env` or `logging.fileLevel` in `config/default.json` (default: `info`).
    *   The application will log status messages (to console, and to file if successfully enabled) indicating if file logging was initialized successfully (including the path and level) or if it failed to initialize, guiding troubleshooting.
*   **Log Format:** Logs are output to the console and file in JSON format, including a timestamp.
*   **Call-Specific Context:** For logs related to a specific call (i.e., those using the `callLogger`), the context will include:
    *   `callId`: The unique Asterisk channel ID for the call.
    *   `callerNumber`: The Caller ID number of the incoming call (if available, otherwise 'Unknown').

## 11. Troubleshooting

*   **ARI Connection Issues:**
    *   Verify Asterisk, ARI username/password (`.env` vs `ari.conf`), HTTP server (`http.conf`), and firewall.
*   **Google Authentication Errors:**
    *   Check `GOOGLE_APPLICATION_CREDENTIALS` path in `.env`, service account roles, and Speech-to-Text API enablement.
*   **Audio Issues / No Transcription:**
    *   Check Asterisk logs.
    *   Ensure `sampleRateHertz` and `encoding` (from `callConfig.googleSpeech`, ultimately sourced from Dialplan/ENV/default.json) match the audio format Asterisk is sending.
    *   Verify audio prompt files exist and are accessible by Asterisk.
    *   Enable `debug` logging (`LOG_LEVEL=debug` for console, and/or `LOG_FILE_LEVEL=debug` for file) for detailed messages.
*   **"Event for different app" warning:**
    *   Ensure `ASTERISK_ARI_APP_NAME` in `.env` matches the application name in `Stasis()`.

This README provides a good overview. For more detailed deep-dives into specific areas, further markdown files could be created in a `docs/` directory (e.g., `docs/CONFIGURATION.md`, `docs/DIALPLAN.md`).
