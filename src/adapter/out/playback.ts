import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, type VoiceConnection } from '@discordjs/voice';
import { Readable } from 'node:stream';
import { createLogger } from './logger.js';

const logger = createLogger('playback');

// pcmBuffer：48kHz 立体声 16-bit PCM。播完（或出错）才 resolve，方便多段依次播放不重叠。
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

    const startedAt = Date.now();
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    player.on('stateChange', (oldState, newState) => {
      logger.info(
        { from: oldState.status, to: newState.status, elapsedMs: Date.now() - startedAt },
        `Playback state: ${oldState.status} -> ${newState.status} (elapsed ${Date.now() - startedAt}ms)`,
      );
    });

    const subscription = connection.subscribe(player);
    logger.info(
      { subscribed: Boolean(subscription) },
      `connection.subscribe result: ${subscription ? 'success' : 'failed (returned undefined)'}`,
    );

    player.play(resource);
  });
}
