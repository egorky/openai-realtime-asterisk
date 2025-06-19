# OpenAI Realtime API with Asterisk ARI Quickstart

Combine OpenAI's Realtime API and Asterisk's telephony capabilities (via ARI - Asterisk REST Interface) to build an AI calling assistant.

<img width="1728" alt="Screenshot 2024-12-18 at 4 59 30 PM" src="https://github.com/user-attachments/assets/d3c8dcce-b339-410c-85ca-864a8e0fc326" />

## Quick Setup

Open two terminal windows for the `webapp` and `websocket-server`. Ensure your Asterisk server is configured and running.

| Component             | Purpose                                       | Quick Reference (see below for more) |
| --------------------- | --------------------------------------------- | ------------------------------------ |
| `webapp`              | Frontend for call configuration & transcripts | `npm run dev`                        |
| `websocket-server`    | Backend handling Asterisk & OpenAI connection | `npm run dev`                        |
| Asterisk              | Telephony server                              | (Must be running and configured)     |
| SIP Client/Softphone  | To place calls into Asterisk                  | (Configure to connect to Asterisk)   |

Make sure all environment variables in `webapp/.env` and `websocket-server/.env` are set correctly. See [Full Setup and Configuration](#full-setup-and-configuration) section for more.

## Overview

This repository implements a phone calling assistant using OpenAI's Realtime API and Asterisk. It has two main software components: the `webapp` and the `websocket-server`.

1.  **`webapp`**: A Next.js application serving as a frontend to configure call parameters (like instructions for the AI) and display live transcripts and function call interactions.
2.  **`websocket-server`**: An Express backend that:
    *   Connects to Asterisk via ARI (`ari-client.ts`).
    *   Manages incoming calls from Asterisk.
    *   Sets up RTP media streams to receive audio from Asterisk.
    *   Handles the Realtime API connection with OpenAI (`sessionManager.ts`).
    *   Forwards audio from Asterisk to OpenAI for transcription.
    *   Plays back audio responses from OpenAI to Asterisk.
    *   Forwards events (transcripts, function calls, errors) to the `webapp` via a WebSocket connection.

**Call Flow:**

1.  A call is placed to an extension on your Asterisk server.
2.  Asterisk dialplan routes the call to a `Stasis` application, which is handled by `ari-client.ts` in the `websocket-server`.
3.  `ari-client.ts` answers the call and establishes media handling:
    *   It creates an RTP server (`rtp-server.ts`) to receive audio from Asterisk.
    *   It instructs Asterisk (via ARI) to send call audio to this RTP server using an "external media" channel.
4.  `sessionManager.ts` is notified of the new call and connects to OpenAI's Realtime API, configured with appropriate audio formats (e.g., G.711 µ-law).
5.  Audio received by `rtp-server.ts` is forwarded by `ari-client.ts` to `sessionManager.ts`, which then sends it to OpenAI.
6.  OpenAI processes the audio, sends back transcripts, function call requests, and audio responses.
7.  `sessionManager.ts` handles these messages:
    *   Transcripts and function call details are sent to the `webapp`.
    *   Audio responses from OpenAI are sent to `ari-client.ts`.
8.  `ari-client.ts` plays back the audio responses on the Asterisk channel using `channel.play()`.
9.  The `webapp` displays the live transcript and any function call interactions.

### Function Calling

This demo allows for function call definitions. The `websocket-server` can be extended to execute custom code for these functions and return their output to the OpenAI model to influence the conversation.

## Full Setup and Configuration

1.  **Configure Asterisk:** See [Asterisk Configuration](#asterisk-configuration) below.
2.  **Set up Environment Variables:** See [Environment Variables](#environment-variables) below.
3.  **Run `websocket-server`:**
    ```shell
    cd websocket-server
    npm install
    npm run dev
    ```
4.  **Run `webapp`:**
    ```shell
    cd webapp
    npm install
    npm run dev
    ```
5.  **Place a Call:** Use a SIP client (softphone) to call the Asterisk extension you configured.

## Environment Variables

Copy `.env.example` to `.env` in both `websocket-server` and `webapp` directories and fill in the required values.

### `websocket-server/.env`

*   `OPENAI_API_KEY`: Your OpenAI API key.
*   `ASTERISK_ARI_URL`: Full URL to your Asterisk ARI interface (e.g., `http://localhost:8088` or `http://asterisk_ip:8088`).
*   `ASTERISK_ARI_USERNAME`: Username for ARI authentication.
*   `ASTERISK_ARI_PASSWORD`: Password for ARI authentication.
*   `ASTERISK_ARI_APP_NAME`: The name of your Stasis application as defined in Asterisk dialplan (e.g., `openai-ari-app`).
*   `RTP_HOST_IP` (Optional): IP address for the RTP server to bind to. Defaults to `127.0.0.1`. If Asterisk is on a different machine, set this to an IP reachable by Asterisk.
*   `AUDIO_FORMAT_FOR_EXTERNAL_MEDIA` (Optional): Audio format for Asterisk external media. Defaults to `ulaw`.
*   `PUBLIC_URL` (Optional): The publicly accessible URL for this `websocket-server`. Used by the `webapp` if it needs to fetch the server's URL.

### `webapp/.env`

*   `NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL`: The base URL of the `websocket-server` (e.g., `http://localhost:8081`). The webapp uses this to connect to the `/logs` WebSocket and `/tools` HTTP endpoint.

## Asterisk Configuration

Ensure your Asterisk server is properly configured:

1.  **Enable ARI:**
    *   In `ari.conf` (typically in `/etc/asterisk/`), ensure ARI is enabled and configured.
    *   Set up an ARI user with appropriate permissions. Example:
        ```ini
        [general]
        enabled = yes
        pretty = yes ; Optional: formats JSON responses nicely

        [myariuser]
        type = user
        read_only = no ; Allow control operations
        password = myaripassword
        ```

2.  **Enable Asterisk HTTP Server:**
    *   ARI relies on Asterisk's built-in HTTP server. Ensure it's enabled in `http.conf`.
    *   Example:
        ```ini
        [general]
        enabled = yes
        bindaddr = 0.0.0.0 ; Or a specific IP
        bindport = 8088   ; Default ARI port
        ```

3.  **Dialplan for Stasis Application:**
    *   In your dialplan (e.g., `extensions.conf`), create an extension that routes incoming calls to your ARI application.
    *   Example: If your `ASTERISK_ARI_APP_NAME` is `openai-ari-app` and you want to trigger it by dialing `1234`:
        ```
        exten => 1234,1,NoOp(Call received for OpenAI ARI App)
        same => n,Stasis(openai-ari-app)
        same => n,Hangup()
        ```
    *   Reload your dialplan in Asterisk CLI: `dialplan reload`.

4.  **Audio Codec:**
    *   Ensure that your SIP device/trunk and Asterisk are configured to use **G.711 µ-law (ulaw)** for the call path into the Stasis application. This is the format the `websocket-server` is currently configured to expect from Asterisk and send to OpenAI. Mismatched codecs can result in silence or errors.
    *   Check your SIP peer configuration (e.g., `allow=ulaw` in `sip.conf` or `pjsip.conf`).

## Testing

For detailed testing procedures, including audio format verification steps, please refer to the [TESTING.md](websocket-server/TESTING.md) document in the `websocket-server` directory.

# Additional Notes

This repository provides a foundation. Security practices, error handling, and production readiness should be thoroughly reviewed and enhanced before deploying in a live environment.
