import { saveSessionParams } from './redis-client';
import { LoggerInstance } from './types';

// Extracts a 10-digit number (ID/cédula) from the transcript
function extractIdNumber(transcript: string): string | null {
    const match = transcript.match(/\b\d{10}\b/);
    return match ? match[0] : null;
}

// A simple way to check for time selection confirmation
function extractTimeSlot(transcript: string): string | null {
    const lowerTranscript = transcript.toLowerCase();
    const timeRegex = /(\d{1,2}:\d{2}\s*(am|pm)?)/;
    const match = lowerTranscript.match(timeRegex);

    if (match) {
        // Keywords to confirm selection
        const confirmationKeywords = ['a las', 'mañana', 'confirmo', 'sí, a las', 'quiero la de las'];
        if (confirmationKeywords.some(keyword => lowerTranscript.includes(keyword))) {
            return match[0].trim();
        }
    }
    return null;
}


export async function extractAndSaveParameters(callId: string, transcript: string, logger: LoggerInstance): Promise<void> {
    const paramsToSave: { [key: string]: any } = {};

    const idNumber = extractIdNumber(transcript);
    if (idNumber) {
        paramsToSave.identificationNumber = idNumber;
    }

    const timeSlot = extractTimeSlot(transcript);
    if (timeSlot) {
        paramsToSave.slot = timeSlot;
    }

    if (Object.keys(paramsToSave).length > 0) {
        logger.info(`[ParameterExtractor] Extracted parameters from transcript: ${JSON.stringify(paramsToSave)}`);
        await saveSessionParams(callId, paramsToSave);
    }
}
