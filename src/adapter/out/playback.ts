import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, type VoiceConnection } from '@discordjs/voice';
import { Readable } from 'node:stream';
import { createLogger } from './logger.js';

const logger = createLogger('playback');

export function playPcmInChannel(connection: VoiceConnection, pcmBuffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const player = createAudioPlayer();
    const resource = createAudioResource(Readable.from(pcmBuffer), { inputType: StreamType.Raw });

    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);

    const subscription = connection.subscribe(player);
    if (!subscription) {
      logger.warn({ subscribed: false }, 'connection.subscribe failed');
    }

    player.play(resource);
  });
}
