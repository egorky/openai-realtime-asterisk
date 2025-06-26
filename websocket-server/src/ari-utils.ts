// Este archivo contendrá funciones de utilidad general que pueden ser usadas en varias partes de la aplicación ARI.

// Interfaz para las opciones de creación de la cabecera WAV.
export interface WavHeaderOptions {
  numFrames: number;
  numChannels: number;
  sampleRate: number;
  bytesPerSample: number;
}

/**
 * Crea una cabecera WAV para datos PCM.
 * @param opts Opciones para la cabecera WAV.
 * @returns Buffer que contiene la cabecera WAV.
 */
export function createWavHeader(opts: WavHeaderOptions): Buffer {
  const numFrames = opts.numFrames;
  const numChannels = opts.numChannels || 1; // Por defecto a mono
  const sampleRate = opts.sampleRate || 8000; // Por defecto a 8kHz
  const bytesPerSample = opts.bytesPerSample || 2; // Por defecto a 16-bit (2 bytes)

  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;

  // La cabecera WAV tiene 44 bytes.
  const buffer = Buffer.alloc(44);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0); // ChunkID
  buffer.writeUInt32LE(36 + dataSize, 4); // ChunkSize (tamaño del archivo - 8 bytes)
  buffer.write('WAVE', 8); // Format

  // "fmt " sub-chunk
  buffer.write('fmt ', 12); // Subchunk1ID
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 para PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 para PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign (NumChannels * BitsPerSample/8)
  buffer.writeUInt16LE(bytesPerSample * 8, 34); // BitsPerSample

  // "data" sub-chunk
  buffer.write('data', 36); // Subchunk2ID
  buffer.writeUInt32LE(dataSize, 40); // Subchunk2Size (NumSamples * NumChannels * BitsPerSample/8)

  return buffer;
}

// Otras funciones de utilidad pueden añadirse aquí según sea necesario.
// Por ejemplo, formateadores de fecha, generadores de ID únicos (si no se usan los de UUID), etc.

// Ejemplo de otra posible utilidad (si se necesita en varios sitios):
// export function someOtherUtilityFunction(input: any): any {
//   // ...lógica de la utilidad...
//   return input;
// }
