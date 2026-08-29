import { config } from '../../../config.js';
import { fetchWithTimeout } from '../http.js';

function speechRegion(): string {
  if (!config.azureSpeechRegion) {
    throw new Error('AZURE_SPEECH_REGION is not set — check your .env file');
  }
  return config.azureSpeechRegion;
}

function ttsBaseUrl(): string {
  return `https://${speechRegion()}.tts.speech.microsoft.com`;
}

function sttBaseUrl(): string {
  return `https://${speechRegion()}.stt.speech.microsoft.com`;
}

function speechKey(): string {
  if (!config.azureSpeechKey) {
    throw new Error('AZURE_SPEECH_KEY is not set — check your .env file');
  }
  return config.azureSpeechKey;
}

export async function synthesizeSsml(ssml: string): Promise<Buffer> {
  const response = await fetchWithTimeout(`${ttsBaseUrl()}/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': speechKey(),
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      'User-Agent': 'cicada-discord-bot',
    },
    body: ssml,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Azure Speech TTS request failed: ${response.status} ${response.statusText} ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export interface AzureSpeechRecognitionResult {
  RecognitionStatus?: string;
  DisplayText?: string;
  Offset?: number;
  Duration?: number;
}

export async function recognizeWav(wav: Buffer, language: string): Promise<AzureSpeechRecognitionResult> {
  const params = new URLSearchParams({ language });
  const response = await fetchWithTimeout(`${sttBaseUrl()}/speech/recognition/conversation/cognitiveservices/v1?${params}`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': speechKey(),
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=48000',
      Accept: 'application/json',
    },
    body: wav,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Azure Speech STT request failed: ${response.status} ${response.statusText} ${errText}`);
  }

  return (await response.json()) as AzureSpeechRecognitionResult;
}
