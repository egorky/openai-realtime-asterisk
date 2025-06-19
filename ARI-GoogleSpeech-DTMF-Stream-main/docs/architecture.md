# System Architecture Documentation

This document details the architecture of the Asterisk and Google Speech integrated voice recognition system.

## File Descriptions

-   **`src/app.js`**: Main application entry point. Initializes and starts the ARI (Asterisk REST Interface) client.
-   **`src/ari-client.js`**: The core component that handles Asterisk ARI events, notably `StasisStart` (new call) and `StasisEnd` (call ended). It manages the call lifecycle, including answering calls, playing prompts, initiating media streams, interacting with the Google Speech service for transcription, and cleaning up resources.
-   **`src/rtp-server.js`**: Implements a UDP server to receive RTP (Real-time Transport Protocol) packets from Asterisk. It extracts the raw audio data from these packets and emits events that `ari-client.js` uses to capture audio or send it to the speech service.
-   **`src/speech-service.js`**: Provides an interface to the Google Cloud Speech-to-Text API. It includes functions to create a streaming recognition session (for real-time transcription) and to perform batch transcription on an audio file (often used as a fallback).
-   **`asterisk/extensions.conf`**: Asterisk dialplan configuration. This file defines how Asterisk handles incoming calls, including routing them to the `Stasis` application (which is this Node.js application).
-   **`config/default.json`**: Contains the default configuration settings for the application. This includes ARI connection parameters, paths for audio files (greetings, waiting prompts), logging levels, Google Speech API settings (like language, encoding, model), and application behavior toggles.
-   **`config/google-credentials.json`**: A placeholder or the actual JSON service account key file required for authenticating with Google Cloud services, specifically the Speech-to-Text API.
-   **`.env.example`**: An example file showing the environment variables that can be used to override settings in `config/default.json`. This is useful for customizing deployment without modifying the main configuration file.
-   **`package.json`**: Standard Node.js project file that lists metadata, dependencies (libraries used by the project), and scripts for running, testing, or building the application.
-   **`docs/`**: Directory for documentation files.
-   **`sounds/`**: Directory intended to store audio prompt files.

## Key Function Explanations

### `src/ari-client.js`

-   **`initAriClient(app)`**:
    -   Establishes a connection to the Asterisk REST Interface (ARI) using credentials and URL from the configuration.
    -   Registers handlers for ARI events, primarily `StasisStart` to manage new calls and `StasisEnd` for call termination.
    -   Starts the ARI client, allowing it to receive events for the configured Asterisk application.
-   **`client.on('StasisStart', async (event, channel) => { ... })` (Event Handler)**:
    -   This is the main logic block for handling an incoming call that has been routed to the Stasis application.
    -   **Call Setup**: Answers the call, creates necessary bridges (`user_bridge`, `snoop_bridge`), and channels (snoop channel, external media channel for RTP). Creates a `callLogger` by calling `logger.child({ callId: channel.id })` for call-specific logging.
    -   **Media Management**:
        -   Plays initial greeting prompts to the caller (using `callLogger`).
        -   Manages an `RtpServer` instance (passed `callLogger`) to receive audio from the caller via Asterisk.
    -   **Speech Recognition**:
        -   Calls `activateGoogleStreamingAndRecognitionLogic` (which uses `callLogger`) to initiate real-time speech-to-text.
        -   Handles responses from `speech-service.js` (interim and final transcripts), logging with `callLogger`.
        -   Manages various timers related to speech recognition (e.g., no speech timeout, max duration), logging with `callLogger`.
    -   **Fallback**: Calls `tryOfflineRecognition` (which uses `callLogger`) if streaming recognition fails or conditions warrant it.
    -   **DTMF Handling**:
        -   If DTMF recognition is enabled (via `dtmfConfig.enableDtmfRecognition`), the system subscribes to `ChannelDtmfReceived` events on the user's channel.
        -   Upon receiving a DTMF digit:
            - Any active playback (greeting, waiting audio) is immediately stopped.
            - If speech recognition (Google streaming) is active, it is also immediately stopped to prioritize DTMF input. The `dtmfInterruptedSpeech` flag is set, and the Google Speech stream is gracefully ended or destroyed.
            - If VAD mode is active and buffering (`isVADBufferingActive = true`) or waiting on VAD timers, these VAD processes are halted, and the VAD audio buffer is cleared (as detailed in the "Voice Activity Detection (VAD) Flow" section).
            - Collected DTMF digits are appended to a buffer (`collectedDtmfDigits`).
            - Timers (`dtmfInterDigitTimer`, `dtmfFinalTimer`) manage the collection process.
        -   Once DTMF input is complete (either by final timeout or inter-digit timeout leading to final timeout), the `fullCleanup` process is initiated.
        -   Before continuing in the dialplan (if not hanging up), the collected digits are set to the `DTMF_DIGITS` channel variable. Speech transcription (`SPEECH_TEXT`) is typically cleared or not set if DTMF was the primary interaction.
    -   **Cleanup**: Invokes `fullCleanup` (which uses `callLogger`) when the call or recognition process ends. This function also handles the final decision for fallback batch transcription if applicable.
    -   **Variables**: Sets channel variables (e.g., `SPEECH_TEXT`, `DTMF_DIGITS`) to pass results back to the Asterisk dialplan, logging actions with `callLogger`.
-   **`fullCleanup(hangup, reason)`**:
    -   A critical function responsible for releasing all resources associated with a call to prevent leaks or orphaned processes. Uses `callLogger` for all its logging. It also handles the decision and invocation of `tryOfflineRecognition` if fallback is enabled and conditions are met (e.g., streaming result was empty, audio was captured).
    -   Stops any active timers (barge-in, timeouts, VAD timers).
    -   Stops any ongoing playbacks.
    -   Closes the Google Speech stream.
    -   Stops the RTP server instance.
    -   Hangs up or destroys channels (snoop, external media) and bridges created for the call.
    -   Decides whether to hang up the main caller channel or allow it to continue in the Asterisk dialplan.
-   **`tryOfflineRecognition(filePath, languageForSpeechToTry, channelForVar)`**:
    -   Called when fallback batch transcription is needed. Uses `callLogger` for its logging.
    -   Ensures any active audio capture stream is closed.
    -   Uses `transcribeAudioFile` from `speech-service.js` (passing `callLogger`) to get a transcript from the recorded audio file.
    -   Sets channel variables related to fallback status and transcript.
-   **`activateGoogleStreamingAndRecognitionLogic(isBargeInByTimer)`**:
    -   Sets up and starts the streaming speech recognition with Google. Uses `callLogger` for its logging.
    -   Determines the language for speech recognition.
    -   Creates a speech stream using `createSpeechStream` from `speech-service.js` (passing `callLogger`).
    -   Sets up handlers for data (transcripts), errors, and end-of-stream events from Google.
    -   Manages timers for speech activity (e.g., `noSpeechBeginTimer`, `initialGoogleStreamIdleTimer`).
    -   Connects the audio from `RtpServer` to the Google Speech stream.
    -   In VAD mode, its invocation signifies that speech has been detected (or an equivalent trigger like "afterPrompt" has occurred) and live streaming to Google should begin. Consequently, it's at this stage (or just before calling it) that `isVADBufferingActive` is set to `false` and `pendingVADBufferFlush` is set to `true` to handle the pre-speech audio previously captured in `vadAudioBuffer`.

### `src/rtp-server.js` (Class `RtpServer`)

-   **`constructor(logger, host)`**:
    -   The `logger` passed here is expected to be a `callLogger` instance if created within a call context.
    -   Initializes an EventEmitter.
    -   Creates a `dgram.Socket` (UDP socket) for receiving RTP packets.
    -   Sets up event listeners for the socket:
        -   `'error'`: Logs errors and emits an error event (using the provided logger).
        -   `'message'`: Triggered when a UDP packet arrives. It extracts the audio payload from the RTP packet and emits an `audioPacket` event.
        -   `'listening'`: Logs that the server is listening and emits a `listening` event with address details (using the provided logger).
        -   `'close'`: Logs that the socket has been closed (using the provided logger).
-   **`start(preferredPort)`**:
    -   Binds the UDP socket to the specified host and port (or a system-assigned port if `preferredPort` is 0).
    -   Returns a Promise that resolves with the host and port upon successful binding.
-   **`stop()`**:
    -   Closes the UDP socket.
    -   Returns a Promise that resolves when the socket is closed.
-   **`getAddress()`**:
    -   Returns the current listening address and port of the server.

### `src/speech-service.js`

-   **`createSpeechStream(logger, baseGoogleConfig, onData, onError, onEnd, languageCodeOverride)`**:
    -   The `logger` passed here is expected to be a `callLogger` instance.
    -   Initializes and configures a streaming recognition request for the Google Cloud Speech-to-Text API.
    -   Parameters include logger instance, Google API configuration (encoding, sample rate, language, etc.), and callback functions for handling data events (transcripts), errors, and the end of the stream. All logging within callbacks (`onData`, `onError`, `onEnd`) should use this logger.
    -   Returns the `RecognizeStream` object, which is a writable stream. Audio data can be written to this stream to be sent to Google for transcription.
-   **`transcribeAudioFile(logger, filePath, languageCodeOverride, baseGoogleConfig)`**:
    -   The `logger` passed here is expected to be a `callLogger` instance.
    -   Asynchronously transcribes an entire audio file using the Google Cloud Speech-to-Text batch recognition API. All logging uses this logger.
    -   Reads the audio file content.
    -   Constructs a recognition request with the audio content (Base64 encoded) and configuration.
    -   Sends the request to Google and awaits the response.
    -   Returns the transcribed text if successful, or an empty string if transcription fails or yields no result.

### `src/app.js`

-   **`main()`**:
    -   The primary asynchronous function that serves as the entry point of the application.
    -   Its main responsibility is to call `initAriClient` from `src/ari-client.js` to connect to Asterisk and start the ARI event handling.
    -   Includes basic error handling for unhandled promise rejections during startup.
-   **Process Signal Handling (`SIGINT`)**:
    -   Listens for the `SIGINT` signal (e.g., Ctrl+C).
    -   Attempts to gracefully close the ARI client's WebSocket connection before exiting the application.

## Call Flow Diagram (ASCII)

```ascii
Caller --dials--> Asterisk --StasisApp--> ari-client.js (StasisStart Event)
                                                |
                                                | 1. callLogger = logger.child({ callId: channel.id })
                                                | 2. Answer call (logs with callLogger)
                                                | 3. Create User Bridge & Add User Channel (logs with callLogger)
                                                | 4. Play Greeting (on User Bridge, logs with callLogger)
                                                |    (Caller can press DTMF, interrupting playback/speech)
                                                | 5. Setup Snoop Channel (on User Channel, logs with callLogger)
                                                | 6. Create Snoop Bridge (logs with callLogger)
                                                | 7. Start RTP Server (rtp-server.js, passed callLogger)
                                                | 8. Create External Media Channel (to RTP Server, logs with callLogger)
                                                | 9. Add External Media Channel to Snoop Bridge (logs with callLogger)
                                                | 10. Add Snoop Channel to Snoop Bridge (logs with callLogger)
                                                |
rtp-server.js <---audio RTP---- Asterisk <---audio---- Caller
  (logs with callLogger)  (via External Media Channel & Snoop)
      |
      | emits 'audioPacket'
      v
ari-client.js --audio data--> speech-service.js (createSpeechStream, passed callLogger)
  (logs with callLogger)                          |
                                                  | (logs with callLogger)
                                                  | sends audio to Google Speech API
                                                  |
      <----transcription results------------------ speech-service.js (callbacks log with callLogger)
      |
      | (Optional: if streaming fails or for fallback, logs with callLogger)
      | --audio file path--> speech-service.js (transcribeAudioFile, passed callLogger)
      |                                         |
      |                                         | (logs with callLogger)
      |                                         | sends audio file to Google Speech API
      |                                         |
      | <----transcription results-------------- speech-service.js (logs with callLogger)
      |
      | 11. Set SPEECH_TEXT or DTMF_DIGITS channel variable (logs with callLogger)
      | 12. fullCleanup() (uses callLogger)
      | 13. Continue in dialplan / Hangup (logs with callLogger)
      v
Asterisk --> Caller (call continues or ends)
```

### Voice Activity Detection (VAD) Flow

When `RECOGNITION_ACTIVATION_MODE` is set to `vad`, the call flow incorporates Voice Activity Detection to optimize when Google Speech streaming begins. This process is primarily managed within `src/ari-client.js` using Asterisk's `TALK_DETECT` feature.

1.  **Initialization**: Upon a `StasisStart` event, if VAD mode is active:
    *   The application instructs Asterisk to enable `TALK_DETECT` on the incoming channel. This is done by setting the `TALK_DETECT(set)` channel variable with values from `vadSilenceThresholdMs` and `vadTalkThreshold`.
    *   `isVADBufferingActive` is set to `true`, and `vadAudioBuffer` (an array) is initialized to store incoming audio packets. This buffer has a maximum size defined by the `MAX_VAD_BUFFER_PACKETS` constant (documented in `variables.md`).
2.  **Prompting & Buffering**: While any initial audio prompt (e.g., greeting) is played, and as long as `isVADBufferingActive` is `true`, the application buffers incoming audio packets from the caller's RTP stream into `vadAudioBuffer`. This buffer captures pre-speech audio.
3.  **Speech Trigger (`ChannelTalkingStarted`) or Post-Prompt Activation (`vadRecogActivation="afterPrompt"`)**:
    *   **Event**: Asterisk emits `ChannelTalkingStarted` if speech is detected. Alternatively, if the prompt finishes and `vadRecogActivation` is "afterPrompt" (and relevant VAD delays like `vadInitialSilenceDelaySeconds` and `vadActivationDelaySeconds` have completed), the logic proceeds as if speech was just detected.
    *   **Initial VAD Delays**:
        *   `vadInitialSilenceDelaySeconds`: If greater than 0, this timer defers the VAD logic's responsiveness from the very beginning of the call. `TALK_DETECT` might be active and noting speech (`vadSpeechDetected=true`), but the application won't fully process it (like stopping a prompt or activating Google Stream) until this timer expires and `vadInitialSilenceDelayCompleted` becomes true.
        *   `vadActivationDelaySeconds`: If greater than 0, this timer provides a general delay for VAD event reactions (like `ChannelTalkingStarted` or post-prompt activation if `vadRecogActivation="afterPrompt"`). Similar to the initial silence delay, `vadSpeechDetected` might be set, but full processing waits for this timer to expire and `vadActivationDelayCompleted` to become true.
        *   Both `vadInitialSilenceDelayCompleted` and `vadActivationDelayCompleted` must be true for the system to fully act on a `ChannelTalkingStarted` event or trigger recognition via "afterPrompt" logic.
    *   **Core Processing (once relevant VAD delays are complete and speech is confirmed/triggered)**:
        *   `vadSpeechDetected` is set to `true`.
        *   Any ongoing prompt playback is stopped.
        *   `vadMaxWaitAfterPromptTimer` (if running) is cleared.
        *   `activateGoogleStreamingAndRecognitionLogic` is called to initiate the Google Speech stream.
        *   **At this point (when Google streaming is being activated due to VAD):**
            *   `isVADBufferingActive` is set to `false`. This stops *new* audio packets from being added to `vadAudioBuffer`, as subsequent audio will be streamed live to Google.
            *   `pendingVADBufferFlush` is set to `true`. This flags the *existing* content of `vadAudioBuffer` (the captured pre-speech audio) to be sent to Google.
        *   **Buffer Flushing**: The actual flush of `vadAudioBuffer` (the pre-speech audio) occurs when Google's `SPEECH_ACTIVITY_BEGIN` event is received (or an interim result that implies speech has begun). When this happens:
            *   The current contents of `vadAudioBuffer` are copied to a temporary buffer.
            *   `vadAudioBuffer` is immediately cleared (`vadAudioBuffer = []`).
            *   The audio from the temporary buffer is then written to the Google Speech stream.
            *   The `isFlushingVADBuffer` flag manages this specific flushing process.
            *   `pendingVADBufferFlush` is set to `false` after a successful flush attempt or if the buffer was empty.
        *   After processing and Google streaming initiation, `TALK_DETECT` is typically removed from the channel.

4.  **Post-Prompt Logic with `vadRecogActivation="vadMode"` (No Speech During Prompt)**:
    *   This section applies if:
        *   The initial prompt has finished playing.
        *   Both `vadInitialSilenceDelayCompleted` and `vadActivationDelayCompleted` are true.
        *   `vadSpeechDetected` is still `false`.
        *   `vadRecogActivation` is set to `"vadMode"`.
    *   The `vadMaxWaitAfterPromptTimer` is started, using the duration from `vadMaxWaitAfterPromptSeconds`. This timer waits for a `ChannelTalkingStarted` event.
        *   If `ChannelTalkingStarted` occurs before this timer expires, the flow proceeds as described in step 3 (Speech Trigger). The `vadMaxWaitAfterPromptTimer` is cleared.
        *   If the `vadMaxWaitAfterPromptTimer` expires without any speech detection, `TALK_DETECT` is removed from the channel, and the application typically proceeds to `fullCleanup` (as speech was not detected within the allowed timeframe after the prompt).

5.  **DTMF Interruption**: If any DTMF digit is detected while VAD is active (i.e., before Google streaming has been fully activated by VAD, or during VAD-specific timers like `vadInitialSilenceDelayTimer`, `vadActivationDelayTimer`, or `vadMaxWaitAfterPromptTimer`):
    *   DTMF processing takes immediate precedence.
    *   All VAD-specific timers (`vadInitialSilenceDelayTimer`, `vadActivationDelayTimer`, `vadMaxWaitAfterPromptTimer`) are cleared.
    *   VAD audio buffering is stopped: `isVADBufferingActive` is set to `false`.
    *   The `vadAudioBuffer` is cleared.
    *   `pendingVADBufferFlush` is set to `false` (as any buffered audio is discarded).
    *   Any VAD-triggered speech recognition is aborted.
    *   The system handles the DTMF input.

### Forced Waiting Audio

The application supports a "Forced Waiting Audio" feature (see `audio.forceWaitingAudio` and `audio.waitingAudioMode` in `docs/variables.md`). If enabled, after the primary recognition attempt (or VAD timeout/DTMF interruption leading to cleanup) and before returning to the Asterisk dialplan (if not hanging up), a waiting audio prompt can be played.
*   `"playFullBeforeDialplan"` mode: The application waits for this audio to complete.
*   `"playAndTransfer"` mode: The audio starts, and the dialplan receives `FORCED_WAITING_AUDIO_ACTIVE="true"`, becoming responsible for stopping the audio.

This feature allows for a smoother transition or provides interim feedback to the caller while the dialplan prepares next steps or if there's a transfer.

### Mermaid Diagram: VAD Call Flow

```mermaid
sequenceDiagram
    participant Caller
    participant Asterisk
    participant Application
    participant GoogleSpeech

    Caller->>Asterisk: Incoming Call
    Asterisk->>Application: StasisStart event
    Application->>Asterisk: Answer Call

    alt VAD Mode Active (`RECOGNITION_ACTIVATION_MODE="vad"`)
        Application->>Asterisk: Set TALK_DETECT(set)
        Application-->>Application: Initialize vadAudioBuffer, isVADBufferingActive=true
        opt vadActivationDelaySeconds > 0 and vadRecogActivation="vadMode"
            Application-->>Application: Start vadActivationDelayTimer
            Application-->>Application: vadActivationDelayCompleted = false
        else
            Application-->>Application: vadActivationDelayCompleted = true
        end
        Application->>Asterisk: Play Greeting Prompt (asynchronously)
        Asterisk-->>Caller: Playing Greeting...

        par Audio Buffering & Speech/Prompt Events
            loop While prompt playing OR vadActivationDelayTimer active OR VAD waiting
                Caller-->>Asterisk: Audio stream
                Asterisk-->>Application: RTP packets (added to vadAudioBuffer if isVADBufferingActive)
            end
        and
            alt vadActivationDelayTimer is active
                Application-->>Application: vadActivationDelayTimer expires
                Application-->>Application: vadActivationDelayCompleted = true
                Note over Application: Potentially triggers VAD logic if prompt finished or speech detected during delay
            end
        and
            alt Speech Occurs
                Caller->>Asterisk: Starts Speaking
                Asterisk->>Application: ChannelTalkingStarted Event
                opt vadActivationDelayCompleted == false
                    Application-->>Application: vadSpeechDetected = true (defer full processing)
                else
                    Application-->>Application: vadSpeechDetected = true, Process ChannelTalkingStarted
                    Application->>Asterisk: Stop Prompt (if playing)
                    Application-->>Application: Clear vadMaxWaitAfterPromptTimer (if active)
                    Note over Application: Sets isVADBufferingActive=false, pendingVADBufferFlush=true
                    Application->>GoogleSpeech: Initiate StreamingRecognize session
                    Note over Application,GoogleSpeech: Wait for SPEECH_ACTIVITY_BEGIN or interim
                    GoogleSpeech-->>Application: SPEECH_ACTIVITY_BEGIN / Interim Result
                    Note over Application: Buffer flush: vadAudioBuffer copied, then cleared.
                    Application-->>Application: isFlushingVADBuffer = true
                    Application->>GoogleSpeech: Write all packets from (copied) vadAudioBuffer
                    Application-->>Application: isFlushingVADBuffer = false
                    Application->>Asterisk: Set TALK_DETECT(remove)
                end
            end
        and
            alt Prompt Finishes
                Application-->>Application: Greeting Playback Finished
                opt vadActivationDelayCompleted == true AND vadSpeechDetected == false AND relevant initial VAD delays completed
                    alt vadRecogActivation == "afterPrompt"
                        Application-->>Application: Process as if ChannelTalkingStarted just occurred
                        Note over Application: Sets isVADBufferingActive=false, pendingVADBufferFlush=true
                        Application->>GoogleSpeech: Initiate StreamingRecognize session
                        Application->>Asterisk: Set TALK_DETECT(remove)
                        Note over Application,GoogleSpeech: Wait for SPEECH_ACTIVITY_BEGIN or interim for flush of vadAudioBuffer
                    else vadRecogActivation == "vadMode"
                        Application-->>Application: Start vadMaxWaitAfterPromptTimer
                    end
                end
            end
        end

        loop Live Recognition (if Google Stream started)
            Caller->>Asterisk: Continues Speaking (live audio)
            Asterisk-->>Application: RTP packets
            Application->>GoogleSpeech: Stream live audio data
            GoogleSpeech-->>Application: Transcription Results (interim/final)
        end

        opt vadMaxWaitAfterPromptTimer expires (and no speech)
            Application->>Asterisk: Set TALK_DETECT(remove)
            Application-->>Application: Full Cleanup (potential fallback)
        end

    else Non-VAD Mode
        Application->>Asterisk: Play Greeting Prompt
        Asterisk-->>Caller: Playing Greeting...
        Application->>GoogleSpeech: Initiate StreamingRecognize (based on fixedDelay/immediate)
        loop Live Recognition
            Caller->>Asterisk: Audio Stream
            Asterisk-->>Application: RTP packets
            Application->>GoogleSpeech: Stream Audio Data
            GoogleSpeech-->>Application: Transcription Results (interim/final)
        end
    end
    Application->>Asterisk: Continue in Dialplan / Hangup
```
