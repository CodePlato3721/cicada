import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus } from '@discordjs/voice';
import { Readable } from 'node:stream';
import { createLogger } from './logger.js';

const logger = createLogger('playback');

// pcmBuffer：48kHz 立体声 16-bit PCM。播完（或出错）才 resolve，方便多段依次播放不重叠。
export function playPcmInChannel(connection, pcmBuffer) {
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
    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const startedAt = Date.now();
    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    player.on('stateChange', (oldState, newState) => {
      logger.info(
        { from: oldState.status, to: newState.status, elapsedMs: Date.now() - startedAt },
        `播放状态: ${oldState.status} -> ${newState.status} (耗时 ${Date.now() - startedAt}ms)`,
      );
    });

    const subscription = connection.subscribe(player);
    logger.info(
      { subscribed: Boolean(subscription) },
      `connection.subscribe 结果: ${subscription ? '成功' : '失败（返回了 undefined）'}`,
    );

    player.play(resource);
  });
}
