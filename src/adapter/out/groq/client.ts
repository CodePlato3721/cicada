import Groq from 'groq-sdk';
import { config } from '../../../config.js';

let client: Groq | undefined;

export function getGroqClient(): Groq {
  if (!client) {
    if (!config.groqApiKey) {
      throw new Error('GROQ_API_KEY is not set — check your .env file');
    }
    client = new Groq({
      apiKey: config.groqApiKey,
      timeout: Number(process.env.API_TIMEOUT_MS ?? 5000),
      maxRetries: 1,
    });
  }
  return client;
}
