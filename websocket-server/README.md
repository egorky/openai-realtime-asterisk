# WebSocket Server for Asterisk ARI and OpenAI Realtime API Integration

## Overview

This WebSocket server acts as the backend engine connecting an Asterisk telephony server (via the Asterisk REST Interface - ARI) to OpenAI's Realtime API. Its primary role is to manage the lifecycle of calls, handle media streams, orchestrate interactions with the OpenAI API for speech-to-text and text-to-speech, and manage various operational modes for call handling and speech recognition. It also communicates with a frontend web application (see `webapp/`) for displaying call information, transcripts, and allowing session configuration.

## Architecture

The server is built using Node.js with Express and `ws` for WebSocket communication. Key components include:

1.  **`server.ts`**:
    *   Sets up the Express application and the main WebSocket server (`/logs` endpoint for frontend communication).
    *   Initializes and manages the `AriClientService`.
    *   Provides HTTP endpoints (e.g., `/tools` for function call schemas, `/public-url`).

2.  **`ari-client.ts` (`AriClientService` class)**:
    *   The core of the application, responsible for all interactions with Asterisk via ARI.
    *   Manages the state of each active call, including ARI resources (channels, bridges), RTP media setup, and call lifecycle.
    *   Implements various **operational modes** for speech recognition activation (Immediate, Fixed Delay, VAD).
    *   Handles DTMF input, interrupting speech recognition if necessary.
    *   Manages a complex system of **timers** to control call flow, timeouts for speech detection, and other interactions.
    *   Orchestrates when and how to start and stop the OpenAI speech stream via `sessionManager.ts`.
    *   Receives events from `sessionManager.ts` (e.g., speech started, interim/final transcripts, errors) and acts upon them to manage call state and timers.

3.  **`sessionManager.ts`**:
    *   Manages WebSocket connections to the OpenAI Realtime API for each active call.
    *   Handles the setup of the OpenAI session, including sending configuration parameters (model, audio formats, etc.).
    *   Forwards audio data received from `ari-client.ts` (originating from Asterisk) to OpenAI.
    *   Processes incoming messages (events) from OpenAI and calls appropriate methods in `ari-client.ts` to notify it of speech activity, transcripts, and errors.
    *   Handles function call processing logic.

**Interaction Flow:**
*   An incoming call on Asterisk is routed to the Stasis application managed by `ari-client.ts`.
*   `ari-client.ts` sets up media (RTP server, snoop channels) and determines the operational mode.
*   Based on the mode, `ari-client.ts` instructs `sessionManager.ts` to start an OpenAI session.
*   Audio flows from Asterisk -> RTP Server -> `ari-client.ts` -> `sessionManager.ts` -> OpenAI.
*   OpenAI events flow back OpenAI -> `sessionManager.ts` -> `ari-client.ts`.
*   `ari-client.ts` plays back audio responses from OpenAI via ARI.
*   `sessionManager.ts` (or `ari-client.ts` via `sessionManager`) sends logs and transcripts to the connected `webapp`.

## Configuration

The application uses a layered configuration approach:

1.  **`config/default.json`**: Provides the base set of default values for application behavior, timers, and modes.
2.  **Environment Variables**: Override values from `default.json`. These are the primary way to configure a deployment.
3.  **Asterisk Channel Variables** (Future TODO): For per-call overrides, specific channel variables set in the Asterisk dialplan could eventually override environment variables or defaults. This is not fully implemented in `ari-client.ts` for all parameters yet.

### `config/default.json` Structure

This file (located at `websocket-server/config/default.json`) defines the default operational parameters. Its structure typically includes:

```json
{
  "appConfig": {
    "appRecognitionConfig": {
      "recognitionActivationMode": "VAD", // VAD, IMMEDIATE, FIXED_DELAY
      "noSpeechBeginTimeoutSeconds": 3,
      "speechCompleteTimeoutSeconds": 5,
      "maxRecognitionDurationSeconds": 30,
      "greetingAudioPath": "sound:hello-world",
      "bargeInDelaySeconds": 0.5, // Used in FIXED_DELAY mode & VAD barge-in
      "initialOpenAIStreamIdleTimeoutSeconds": 10,
      "vadConfig": {
        "vadSilenceThresholdMs": 250,     // For TALK_DETECT silence
        "vadRecognitionActivationMs": 40  // For TALK_DETECT talk duration
      },
      "vadRecogActivation": "afterPrompt", // 'vadMode' or 'afterPrompt'
      "vadInitialSilenceDelaySeconds": 0,
      "vadActivationDelaySeconds": 0,
      "vadMaxWaitAfterPromptSeconds": 5
    },
    "dtmfConfig": {
      "dtmfEnabled": true,
      "dtmfInterdigitTimeoutSeconds": 2,
      "dtmfMaxDigits": 16,
      "dtmfTerminatorDigit": "#",
      "dtmfFinalTimeoutSeconds": 3
    },
    "bargeInConfig": { // General barge-in settings
      "bargeInModeEnabled": true
    }
  },
  "openAIRealtimeAPI": {
    "model": "gpt-4o-realtime-preview-2024-12-17",
    "language": "en-US", // Optional
    "inputAudioFormat": "g711_ulaw",
    "inputAudioSampleRate": 8000,
    "outputAudioFormat": "g711_ulaw",
    "outputAudioSampleRate": 8000
  },
  "logging": {
    "level": "info" // debug, info, warn, error
  }
}
```

### Environment Variables

Refer to `websocket-server/.env.example` for a comprehensive list. Environment variables override the settings in `config/default.json`.

**General & Server:**
*   `PORT`: Port for the WebSocket server. Default: `8081`.
*   `WEBSOCKET_SERVER_HOST_IP`: The IP address the WebSocket server listens on. Path: N/A (direct use in `server.ts`). Default: `0.0.0.0`. (Purpose: `0.0.0.0` allows access from any network interface).
*   `PUBLIC_URL`: Publicly accessible URL for this server.
*   `LOG_LEVEL`: Logging level. Path: `logging.level`. Default: `info`.
*   `CONFIG_FILE_PATH`: Path to the JSON configuration file. Default: `config/default.json`.

**ARI Connection:**
*   `ASTERISK_ARI_URL`: Full URL to Asterisk ARI. Path: N/A (direct use). Default: `http://localhost:8088/ari`.
*   `ASTERISK_ARI_USERNAME`: ARI username. Path: N/A (direct use). Default: `asterisk`.
*   `ASTERISK_ARI_PASSWORD`: ARI password. Path: N/A (direct use). Default: `asterisk`.
*   `ASTERISK_ARI_APP_NAME`: Stasis application name. Path: N/A (direct use). Default: `openai-realtime-ari`.

**RTP Server:**
*   `RTP_SERVER_HOST_IP`: IP for internal RTP server. Path: N/A (used directly by `rtp-server.ts`, should be mirrored in config if needed centrally). Default: `127.0.0.1`.
*   `RTP_MIN_PORT`, `RTP_MAX_PORT`: Port range for RTP. Path: N/A. Defaults: `10000`, `10010`.

**OpenAI Configuration:**
*   `OPENAI_API_KEY`: Your OpenAI API Key. Path: N/A (direct use). No default.
*   `OPENAI_MODEL`: OpenAI model to use. Path: `openAIRealtimeAPI.model`. Default: `gpt-4o-realtime-preview-2024-12-17`.
*   `OPENAI_LANGUAGE`: Language for OpenAI. Path: `openAIRealtimeAPI.language`. Optional.
*   `OPENAI_INPUT_AUDIO_FORMAT`: Audio format for OpenAI input. Path: `openAIRealtimeAPI.inputAudioFormat`. Default: `g711_ulaw`.
*   `OPENAI_INPUT_AUDIO_SAMPLE_RATE`: Sample rate for OpenAI input. Path: `openAIRealtimeAPI.inputAudioSampleRate`. Default: `8000`.
*   `OPENAI_OUTPUT_AUDIO_FORMAT`: Audio format for OpenAI output. Path: `openAIRealtimeAPI.outputAudioFormat`. Default: `g711_ulaw`.
*   `OPENAI_OUTPUT_AUDIO_SAMPLE_RATE`: Sample rate for OpenAI output. Path: `openAIRealtimeAPI.outputAudioSampleRate`. Default: `8000`.

**Recognition Modes & Timers:**
*   `RECOGNITION_ACTIVATION_MODE`: How recognition starts. Path: `appConfig.appRecognitionConfig.recognitionActivationMode`. Default: `VAD`. Values: `VAD`, `IMMEDIATE`, `FIXED_DELAY`, `MANUAL`.
*   `GREETING_AUDIO_PATH`: Path to greeting audio (e.g., `sound:hello-world`). Path: `appConfig.appRecognitionConfig.greetingAudioPath`. Default: `sound:hello-world`.
*   `NO_SPEECH_BEGIN_TIMEOUT_SECONDS`: Timeout if no speech after stream starts. Path: `appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds`. Default: `3`.
*   `SPEECH_COMPLETE_TIMEOUT_SECONDS`: Silence duration after interim result to consider speech complete. Path: `appConfig.appRecognitionConfig.speechCompleteTimeoutSeconds`. Default: `5`.
*   `INITIAL_OPENAI_STREAM_IDLE_TIMEOUT_SECONDS`: Timeout for the initial OpenAI stream to become responsive (e.g. first transcript). Path: `appConfig.appRecognitionConfig.initialOpenAIStreamIdleTimeoutSeconds`. Default: `10`.
*   `MAX_RECOGNITION_DURATION_SECONDS`: Max call duration. Path: `appConfig.appRecognitionConfig.maxRecognitionDurationSeconds`. Default: `30`.
*   `BARGE_IN_DELAY_SECONDS`: Delay for `FIXED_DELAY` mode. Path: `appConfig.appRecognitionConfig.bargeInDelaySeconds`. Default: `0.5`.

**VAD Specific:**
*   `VAD_RECOG_ACTIVATION_MODE`: VAD sub-mode. Path: `appConfig.appRecognitionConfig.vadRecogActivation`. Default: `afterPrompt`. Values: `vadMode`, `afterPrompt`.
*   `VAD_SILENCE_THRESHOLD_MS`: Silence duration for `TALK_DETECT`. Path: `appConfig.appRecognitionConfig.vadConfig.vadSilenceThresholdMs`. Default: `250`.
*   `VAD_TALK_THRESHOLD_MS`: Talk duration for `TALK_DETECT`. Path: `appConfig.appRecognitionConfig.vadConfig.vadRecognitionActivationMs`. Default: `40`.
*   `VAD_INITIAL_SILENCE_DELAY_SECONDS`: Initial silence delay in `vadMode`. Path: `appConfig.appRecognitionConfig.vadInitialSilenceDelaySeconds`. Default: `0`.
*   `VAD_ACTIVATION_DELAY_SECONDS`: Activation delay in `vadMode`. Path: `appConfig.appRecognitionConfig.vadActivationDelaySeconds`. Default: `0`.
*   `VAD_MAX_WAIT_AFTER_PROMPT_SECONDS`: Max wait after prompt in VAD `afterPrompt`. Path: `appConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds`. Default: `5`.

**DTMF Specific:**
*   `DTMF_ENABLED`: Enable DTMF. Path: `appConfig.dtmfConfig.dtmfEnabled`. Default: `true`.
*   `DTMF_INTERDIGIT_TIMEOUT_SECONDS`: Timeout between DTMF digits. Path: `appConfig.dtmfConfig.dtmfInterdigitTimeoutSeconds`. Default: `2`.
*   `DTMF_MAX_DIGITS`: Max DTMF digits. Path: `appConfig.dtmfConfig.dtmfMaxDigits`. Default: `16`.
*   `DTMF_TERMINATOR_DIGIT`: DTMF terminator. Path: `appConfig.dtmfConfig.dtmfTerminatorDigit`. Default: `#`.
*   `DTMF_FINAL_TIMEOUT_SECONDS`: Final timeout for DTMF input. Path: `appConfig.dtmfConfig.dtmfFinalTimeoutSeconds`. Default: `3`.

## Troubleshooting Notes
**Enhanced Logging:** The server includes detailed logging for server startup, WebSocket connections, ARI call flow, resource creation, and OpenAI interactions. To leverage this for troubleshooting, set the `LOG_LEVEL` environment variable to `debug` or `info` as needed and inspect the console output of the `websocket-server`.

## Operational Modes

The `RECOGNITION_ACTIVATION_MODE` setting (from `appConfig.appRecognitionConfig` or environment variable `RECOGNITION_ACTIVATION_MODE`) controls how and when the OpenAI speech recognition stream is initiated. DTMF input acts as an interrupt to these modes.

**Common Timers (Once OpenAI Stream is Active):**
Regardless of the initial activation mode, once the OpenAI stream is active, the following timers typically govern the interaction:
*   `noSpeechBeginTimer`: Ensures OpenAI detects speech (or sends first transcript) within `noSpeechBeginTimeoutSeconds`.
*   `initialOpenAIStreamIdleTimer`: Ensures the OpenAI stream is responsive shortly after activation, within `initialOpenAIStreamIdleTimeoutSeconds`.
*   `speechEndSilenceTimer`: Detects end-of-speech silence after an interim transcript, configured by `speechCompleteTimeoutSeconds`.
*   `maxRecognitionDurationTimer`: Sets an overall limit for the call interaction, configured by `maxRecognitionDurationSeconds`. This timer is active across all modes *unless* DTMF mode is entered.

---

*   **`IMMEDIATE` Mode**:
    *   **Purpose**: Starts OpenAI streaming as soon as the call is connected and media is set up, potentially even before or during the greeting playback.
    *   **Behavior**: `_activateOpenAIStreaming` is called early in the `onStasisStart` handler after basic call resources are established.
    *   **Key Governing Timers**: None specific to this mode for *initiating* the stream beyond basic setup. The common active stream timers apply immediately.
    *   **Timers from other modes NOT valid**: VAD-specific timers (`vadInitialSilenceDelayTimer`, `vadActivationDelayTimer`, `vadMaxWaitAfterPromptTimer`) and `bargeInActivationTimer` (from FIXED_DELAY) are not used.

---

*   **`FIXED_DELAY` Mode**:
    *   **Purpose**: Starts OpenAI streaming after a fixed delay, typically after a greeting message has finished playing (if configured).
    *   **Behavior**:
        *   If a `greetingAudioPath` is configured, the system waits for the `PlaybackFinished` event (or failure) of this greeting.
        *   It then checks `bargeInDelaySeconds` (from `appConfig.appRecognitionConfig`).
        *   If `bargeInDelaySeconds > 0`, a `bargeInActivationTimer` is started. When it expires, `_activateOpenAIStreaming` is called.
        *   If `bargeInDelaySeconds <= 0` (or not set), `_activateOpenAIStreaming` is called immediately after the greeting (or immediately in `onStasisStart` if no greeting).
    *   **Key Governing Timers**: `bargeInActivationTimer` (if `bargeInDelaySeconds > 0`).
    *   **Timers from other modes NOT valid**: VAD-specific timers are not used.
    *   **Standard Active Timers**: Apply once stream is active.

---

*   **`VAD` (Voice Activity Detection) Mode**:
    *   **Purpose**: Uses Asterisk's `TALK_DETECT` feature to start OpenAI streaming only when speech is detected on the line, offering more natural interaction.
    *   **Behavior**:
        *   Asterisk's `TALK_DETECT(set)` is applied to the channel using `vadConfig.vadRecognitionActivationMs` (talk threshold) and `vadConfig.vadSilenceThresholdMs` (silence threshold). This allows Asterisk to send `ChannelTalkingStarted` and `ChannelTalkingFinished` events.
        *   Audio from the RTP stream is actively buffered in `ari-client.ts` (`vadAudioBuffer`) while `isVADBufferingActive` is true, before OpenAI streaming starts.
        *   **Prompt Interruption (Barge-in)**: If `ChannelTalkingStarted` is received *during* the main greeting playback (`mainPlayback`), the playback is stopped, and this speech event can trigger OpenAI activation.
        *   **OpenAI Stream Activation**: Depends on the `vadRecogActivation` sub-mode:
            *   **`vadRecogActivation: 'afterPrompt'` (Default VAD sub-mode)**:
                *   If speech is detected (`ChannelTalkingStarted`) *during* the greeting playback, this is noted (`call.vadSpeechDetected = true`). When the greeting finishes, `_handlePostPromptVADLogic` is called. If speech was noted, it calls `_activateOpenAIStreaming` and schedules the VAD buffer to be flushed.
                *   If no speech during the greeting, `_handlePostPromptVADLogic` starts `vadMaxWaitAfterPromptTimer`. If this timer expires before speech, the call is cleaned up. If speech occurs (`ChannelTalkingStarted`) before this timer expires, `_activateOpenAIStreaming` is called.
            *   **`vadRecogActivation: 'vadMode'`**:
                *   `vadInitialSilenceDelaySeconds`: If > 0, a `vadInitialSilenceDelayTimer` runs. Speech detected (`ChannelTalkingStarted`) during this delay sets `call.vadSpeechActiveDuringDelay = true` but does not immediately trigger OpenAI. TALK_DETECT is active.
                *   `vadActivationDelaySeconds`: If > 0, a `vadActivationDelayTimer` runs, similarly deferring OpenAI activation if speech occurs during this period.
                *   `_handleVADDelaysCompleted` is called when both these timers complete. If `vadSpeechActiveDuringDelay` is true (i.e., speech occurred during these initial delay windows), it then calls `_activateOpenAIStreaming`.
                *   If delays complete with no prior speech, the system relies on a future `ChannelTalkingStarted` event to trigger `_activateOpenAIStreaming`.
        *   **Buffer Flushing**: When `_activateOpenAIStreaming` is called due to VAD, `pendingVADBufferFlush` is set. Once the OpenAI session is confirmed by `sessionManager`, the buffered audio is sent to OpenAI to ensure the initial utterance is captured.
    *   **Key Governing Timers**: `vadInitialSilenceDelayTimer`, `vadActivationDelayTimer` (for `vadMode`); `vadMaxWaitAfterPromptTimer` (for `afterPrompt` if no speech during prompt).
    *   **Timers from other modes NOT valid**: `bargeInActivationTimer` (from FIXED_DELAY) is not used.
    *   **Standard Active Timers**: Apply once stream is active.

---

*   **`DTMF` Mode (Interrupts other modes)**:
    *   **Purpose**: Allows user to input digits using their keypad, which takes precedence over and typically interrupts any active speech recognition or playback.
    *   **Behavior**:
        *   Triggered by the `_onDtmfReceived` event handler when Asterisk sends a `ChannelDtmfReceived` event.
        *   **Mode Activation**: `dtmfModeActive` is set to `true`. `speechRecognitionDisabledDueToDtmf` is set to `true`. VAD audio buffering (`isVADBufferingActive`) is stopped, and any existing `vadAudioBuffer` is cleared.
        *   **Playback Interruption**: All active playbacks (`mainPlayback`, `waitingPlayback`, etc.) are stopped via `_stopAllPlaybacks`.
        *   **OpenAI Stream Interruption**: If an OpenAI stream is active (`call.openAIStreamingActive`), `sessionManager.stopOpenAISession` is called.
        *   **Timer Invalidation**: The following speech and VAD related timers are explicitly cleared/invalidated:
            *   `noSpeechBeginTimer`
            *   `initialOpenAIStreamIdleTimer`
            *   `speechEndSilenceTimer`
            *   `vadMaxWaitAfterPromptTimer`
            *   `vadActivationDelayTimer`
            *   `vadInitialSilenceDelayTimer`
            *   `maxRecognitionDurationTimer` (crucially, the overall call timeout is also stopped as DTMF is a distinct interaction path).
        *   **DTMF Collection**: Digits are collected in `collectedDtmfDigits`.
        *   **DTMF Timers**:
            *   `dtmfInterDigitTimer`: Restarts with each new digit. Configured by `dtmfInterdigitTimeoutSeconds`.
            *   `dtmfFinalTimer`: Restarts with each new digit. Configured by `dtmfFinalTimeoutSeconds`. If this expires, collected digits are processed (set as `DTMF_RESULT` channel variable on the Asterisk channel), and the call is then cleaned up via `_fullCleanup`.
        *   **Termination**: Input sequence also terminates if `dtmfTerminatorDigit` is received or `dtmfMaxDigits` is reached, leading to immediate processing and cleanup.
    *   **Key Governing Timers**: `dtmfInterDigitTimer`, `dtmfFinalTimer`.
    *   **Standard Active Timers**: The common speech-related timers are NOT active during DTMF mode.

## Timeout Management

Several key timers in `ari-client.ts` control call flow and error conditions. These timers are crucial for preventing stuck calls and managing user interaction latency.

*   **`maxRecognitionDurationTimer`**:
    *   **Purpose**: Sets an overall maximum duration for the entire call interaction, including speech recognition and OpenAI processing.
    *   **Started**: In `onStasisStart` for most modes.
    *   **Callback**: Calls `_fullCleanup` (typically with `hangupMainChannel=true`).
    *   **Config**: `appConfig.appRecognitionConfig.maxRecognitionDurationSeconds`.
    *   **Note**: This timer is cleared and invalidated if the call transitions into DTMF mode.

*   **`noSpeechBeginTimer`**:
    *   **Purpose**: Times out if, after the OpenAI stream is activated, no speech (or first transcript event like `speech_started`) is detected from OpenAI within a configured period.
    *   **Started**: In `_activateOpenAIStreaming`.
    *   **Cleared**: By `_onOpenAISpeechStarted` (when OpenAI signals speech or first transcript arrives).
    *   **Callback**: Calls `sessionManager.stopOpenAISession` and then `_fullCleanup`.
    *   **Config**: `appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds`.

*   **`initialOpenAIStreamIdleTimer`**:
    *   **Purpose**: Times out if the OpenAI stream is activated but appears unresponsive (no events, specifically no `speech_started` or transcript events) for a defined period. This helps detect early issues with the stream connection or OpenAI's responsiveness.
    *   **Started**: In `_activateOpenAIStreaming`.
    *   **Cleared**: By `_onOpenAISpeechStarted` (when first speech event or transcript arrives).
    *   **Callback**: Calls `sessionManager.stopOpenAISession` and then `_fullCleanup`.
    *   **Config**: `appConfig.appRecognitionConfig.initialOpenAIStreamIdleTimeoutSeconds` (Default: 10s).

*   **`speechEndSilenceTimer`**:
    *   **Purpose**: After an interim transcript is received from OpenAI, this timer starts. If it expires before a new transcript (interim or final) arrives, it indicates a period of silence from the user.
    *   **Started/Restarted**: In `_onOpenAIInterimResult`.
    *   **Cleared**: By a subsequent `_onOpenAIInterimResult` or `_onOpenAIFinalResult`.
    *   **Callback**: Calls `sessionManager.stopOpenAISession`. The call might then end via other timeouts (e.g., `maxRecognitionDurationTimer`) or if the application logic decides no further interaction is needed.
    *   **Config**: `appConfig.appRecognitionConfig.speechCompleteTimeoutSeconds`.

*   **VAD Timers**:
    *   `vadInitialSilenceDelayTimer`, `vadActivationDelayTimer`: Control startup delays in VAD `vadMode`.
    *   `vadMaxWaitAfterPromptTimer`: Max time to wait for speech after a prompt in VAD `afterPrompt` mode. Callbacks typically lead to cleanup if no speech.

*   **DTMF Timers**:
    *   `dtmfInterDigitTimer`: Timeout between individual DTMF digits.
    *   `dtmfFinalTimer`: Timeout after the last DTMF digit to finalize the input. Callback processes collected DTMF and cleans up.

All these timers are cleared automatically as part of `_fullCleanup`.

## Asterisk Dialplan Integration

To route a call to this Stasis application, you need to configure your Asterisk dialplan (e.g., in `extensions.conf`).

**Sample Dialplan Snippet:**

Assuming your `ASTERISK_ARI_APP_NAME` (from `.env`) is `openai-ari-app` and you want to trigger the app by dialing extension `7000`:

```
[from-your-sip-provider-or-internal] ; Replace with your actual inbound context
exten => 7000,1,NoOp(Call to OpenAI ARI Assistant)
 same => n,Stasis(openai-ari-app)
 same => n,Hangup()
```

**Overriding Configuration with Channel Variables (Example - Conceptual):**

While full support for overriding all configurations via channel variables is a TODO in `ari-client.ts`, the mechanism would look like this in the dialplan:

```
exten => 7001,1,NoOp(Call to OpenAI with VAD mode forced)
 same => n,Set(APP_RECOGNITION_ACTIVATION_MODE=VAD) ; Overrides .env or default.json
 same => n,Set(APP_GREETING_AUDIO_PATH=sound:your-custom-greeting)
 same => n,Stasis(openai-ari-app)
 same => n,Hangup()
```
The `ari-client.ts`'s `getCallSpecificConfig` function would need to be enhanced to read these `APP_` prefixed variables.

**Channel Variables Set by the Application:**

The application may set the following channel variables on the original channel before hanging up:

*   `DTMF_RESULT`: If DTMF input is collected, this variable will contain the final string of digits.
*   `FINAL_TRANSCRIPTION`: (TODO) The final transcript from OpenAI could be set here.
*   `RECOGNITION_ERROR`: (TODO) If an error occurred during speech recognition.

These variables can be used by subsequent steps in your Asterisk dialplan after the Stasis application returns.
