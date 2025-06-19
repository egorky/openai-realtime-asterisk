# Testing Plan: Realtime Voice Agent with Asterisk

This document outlines the testing plan for the realtime voice agent application using Asterisk, the `websocket-server`, and the `webapp`.

## 1. Testing Setup Requirements

To effectively test the application, the following components need to be set up and configured:

1.  **Asterisk Server:**
    *   A running Asterisk instance (version 16 or newer recommended for full ARI v2 compatibility).
    *   Configured with an ARI user and password (matching `ASTERISK_ARI_USERNAME` and `ASTERISK_ARI_PASSWORD` in the `.env` file of the `websocket-server`).
    *   The ARI application name in Asterisk's `ari.conf` should match `ASTERISK_ARI_APP_NAME` from the `.env` file (e.g., `openai-ari-app`).
    *   A SIP trunk or a SIP device/endpoint (e.g., a softphone) configured to route calls into an Asterisk dialplan context that will launch the `Stasis(openai-ari-app)` application.
    *   Ensure Asterisk is configured to use G.711 µ-law (ulaw) for the channel/endpoint used for testing, as this is the primary audio format the application expects. Other formats might require transcoding.

2.  **`websocket-server`:**
    *   Cloned from the repository.
    *   Dependencies installed (`npm install`).
    *   `.env` file created from `.env.example` and populated with:
        *   `OPENAI_API_KEY`
        *   Asterisk ARI connection details (`ASTERISK_ARI_URL`, `ASTERISK_ARI_USERNAME`, `ASTERISK_ARI_PASSWORD`, `ASTERISK_ARI_APP_NAME`).
        *   RTP server configuration if defaults are not suitable (e.g., `RTP_HOST_IP`).
        *   `PUBLIC_URL` (if `webapp` is served separately or for general reference, though less critical for core Asterisk interaction).
    *   Run the server: `npm run dev` (or the appropriate start script).

3.  **`webapp` (Frontend):**
    *   Cloned from the repository.
    *   Dependencies installed (`npm install`).
    *   `.env` file created from `.env.example` and populated with `NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL` pointing to the `websocket-server` (e.g., `http://localhost:8081`).
    *   Run the development server: `npm run dev`.
    *   Access the webapp via a web browser.

4.  **SIP Client (Softphone):**
    *   A SIP client (e.g., Zoiper, Linphone, MicroSIP) configured to register with the Asterisk server or make calls through the configured SIP trunk. This will be used to initiate calls to the Asterisk application.

## 2. Test Cases

### TC1: Basic Call Handling and Audio Flow (OpenAI Interaction)

*   **TC1.1: Initiate Inbound Call**
    *   **Action:** Place a call from the SIP client to the Asterisk number/context that triggers the `Stasis(openai-ari-app)` application.
    *   **Expected Outcome:**
        *   `websocket-server` logs show a new call entering `StasisStart`.
        *   `ari-client.ts` logs successful setup of bridges, RTP server, external media channel, and snoop channel.
        *   `sessionManager.ts` logs `handleCallConnection` being invoked.
        *   `sessionManager.ts` logs successful connection to OpenAI Realtime API with correct audio formats.
        *   The `webapp` transcript UI updates to show the call is active.

*   **TC1.2: Speak and Verify Transcription**
    *   **Action:** Speak clearly into the SIP client.
    *   **Expected Outcome:**
        *   `RtpServer` logs show audio packets being received (payload length should be non-zero, typically 160 bytes for 20ms ulaw packets).
        *   `sessionManager.handleAriAudioMessage` logs receipt of audio payloads.
        *   `webapp` transcript UI displays the transcribed text from OpenAI.
        *   No errors related to audio format or processing in `websocket-server` or OpenAI logs (if accessible).

*   **TC1.3: Receive Audio Response from OpenAI**
    *   **Action:** Allow OpenAI to respond (e.g., after a period of silence or a natural conversational pause).
    *   **Expected Outcome:**
        *   `sessionManager.handleModelMessage` logs receipt of `response.audio.delta` from OpenAI.
        *   `ari-client.ts` `playbackAudio` method logs attempt to play audio.
        *   Audio from OpenAI is heard clearly on the SIP client.
        *   No errors related to audio playback in `websocket-server` logs.

*   **TC1.4: Function Calling (if configured)**
    *   **Action:** If a tool/function is configured and the conversation triggers it.
    *   **Expected Outcome:**
        *   `sessionManager.handleModelMessage` logs function call item.
        *   `sessionManager.handleFunctionCall` logs execution attempt.
        *   Correct function output is sent back to OpenAI.
        *   `webapp` function calls panel shows the function call and its result.
        *   Conversation continues based on function output.

*   **TC1.5: Call Hangup by Caller**
    *   **Action:** Hang up the call from the SIP client.
    *   **Expected Outcome:**
        *   `ari-client.ts` `onStasisEnd` handler is triggered.
        *   All associated resources (RTP server, channels, bridges) are cleaned up by `cleanupCallResources`. Logs should confirm this.
        *   `sessionManager.handleAriCallEnd` is called, and it cleans up the OpenAI connection and session state.
        *   `webapp` transcript UI updates to show the call has ended.

*   **TC1.6: Call Hangup by Application (Error or Intentional)**
    *   **Action:** Simulate an error or an intentional hangup triggered by the application (e.g., via a function call that decides to end the call, or manually triggering `ariClient.endCall`).
    *   **Expected Outcome:**
        *   `ariClient.endCall` or `cleanupCallResources(channelId, true)` is invoked.
        *   The Asterisk channel is hung up.
        *   `onStasisEnd` is triggered, leading to resource cleanup and `sessionManager.handleAriCallEnd`.
        *   `webapp` shows the call ended.

### TC2: Configuration and Session Management

*   **TC2.1: Update Session Configuration via Webapp**
    *   **Action:** While no call is active, update instructions, voice, or tools via the `webapp`'s Session Configuration Panel and save.
    *   **Expected Outcome:**
        *   `sessionManager.handleFrontendMessage` receives the `session.update` event.
        *   `session.saved_config` is updated.
        *   The next call (TC1.1) uses these new configurations when connecting to OpenAI (verify via `tryConnectModel` logs).

*   **TC2.2: Frontend Reconnection**
    *   **Action:** While `websocket-server` is running, close and reopen the `webapp` browser window.
    *   **Expected Outcome:**
        *   `webapp` successfully reconnects to the `/logs` WebSocket.
        *   If a call was active, the `webapp` UI correctly reflects the ongoing call state (transcript, etc.) based on messages received after reconnection. (Note: Full state synchronization might be limited with the current single global session model).

### TC3: Error Handling and Robustness

*   **TC3.1: Asterisk Connection Failure**
    *   **Action:** Stop the Asterisk server while `websocket-server` is running. Then attempt to make a call or have `websocket-server` try to reconnect.
    *   **Expected Outcome:**
        *   `ari-client.ts` logs errors related to ARI connection loss (`onAriError`, `onAriClose`).
        *   `websocket-server` either attempts reconnection (if implemented) or logs that it cannot connect to Asterisk.
        *   If a call was active, it should be cleaned up as best as possible.

*   **TC3.2: OpenAI API Key Error**
    *   **Action:** Start `websocket-server` with an invalid `OPENAI_API_KEY`. Attempt to make a call.
    *   **Expected Outcome:**
        *   `sessionManager.tryConnectModel` fails to connect to OpenAI.
        *   Logs indicate authentication failure with OpenAI.
        *   The call may proceed on the Asterisk side but without OpenAI interaction (no transcription/response). The `webapp` might show errors or no transcript.

## 3. Audio Format Verification

Correct audio format handling is critical for the success of transcription and playback.

*   **Step 1: Asterisk Channel Configuration:**
    *   Confirm that the Asterisk channel (e.g., SIP peer, dialplan context) used for initiating test calls is configured to use **G.711 µ-law (ulaw)** codec. This is often set in `sip.conf` (e.g., `allow=ulaw`) or in the Dialplan.

*   **Step 2: `ari-client.ts` External Media Format Logging:**
    *   During TC1.1, observe the logs from `ari-client.ts`.
    *   **Expected Log:** "External Media channel ... created for channel ... with format: ulaw" (or the value of `DEFAULT_AUDIO_FORMAT_FOR_EXTERNAL_MEDIA`).

*   **Step 3: `sessionManager.ts` OpenAI Connection Logging:**
    *   During TC1.1, when `tryConnectModel` is called, observe the logs.
    *   **Expected Log:** The JSON payload sent to OpenAI for `session.update` should contain:
        ```json
        {
          // ... other params
          "input_audio_format": "g711_ulaw",
          "output_audio_format": "g711_ulaw",
          // ... other params
        }
        ```

*   **Step 4: RTP Packet Size Observation:**
    *   During TC1.2 (speaking into SIP client):
        *   Observe logs from `RtpServer` (`rtp-server.ts`): "RtpServer: Packet #X contains audio payload of Y bytes..."
        *   Observe logs from `sessionManager.handleAriAudioMessage`: "handleAriAudioMessage: Received audio payload of length Z bytes."
        *   **Expected:** For G.711 µ-law at 8kHz with 20ms packets (a common configuration), payload sizes (Y and Z) should typically be **160 bytes**. Variations might occur depending on Asterisk's RTP packetization, but significant deviations warrant investigation.

*   **Step 5: Successful End-to-End Audio Processing:**
    *   Successful execution of TC1.2 (transcription) and TC1.3 (audio playback) without audible distortion or errors is the ultimate confirmation that OpenAI is correctly interpreting the incoming `g711_ulaw` stream and that Asterisk is correctly playing back the `g711_ulaw` stream from OpenAI.
    *   If audio is garbled or transcription is poor despite clear input, audio format mismatch or mishandling is a prime suspect.

This testing plan provides a structured approach to verifying the core functionalities of the application.
