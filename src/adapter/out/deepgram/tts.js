import { postJsonForAudio } from './client.js';

// 官方音色列表明确标了性别（不是我们猜的），来源：developers.deepgram.com/docs/tts-models
// 只列了英文（-en）音色——Aura-2 也支持 es/de/fr/nl/it/ja，但那几种语言的具体音色名
// 没查，需要的时候再补，目前先覆盖这个项目默认的英文输出场景。
export const VOICES_BY_GENDER = {
  female: [
    'aura-2-amalthea-en', 'aura-2-andromeda-en', 'aura-2-asteria-en', 'aura-2-athena-en',
    'aura-2-aurora-en', 'aura-2-callista-en', 'aura-2-cora-en', 'aura-2-cordelia-en',
    'aura-2-delia-en', 'aura-2-electra-en', 'aura-2-harmonia-en', 'aura-2-helena-en',
    'aura-2-hera-en', 'aura-2-iris-en', 'aura-2-janus-en', 'aura-2-juno-en',
    'aura-2-luna-en', 'aura-2-minerva-en', 'aura-2-ophelia-en', 'aura-2-pandora-en',
    'aura-2-phoebe-en', 'aura-2-selene-en', 'aura-2-thalia-en', 'aura-2-theia-en',
    'aura-2-vesta-en',
  ],
  male: [
    'aura-2-apollo-en', 'aura-2-arcas-en', 'aura-2-aries-en', 'aura-2-atlas-en',
    'aura-2-draco-en', 'aura-2-hermes-en', 'aura-2-hyperion-en', 'aura-2-jupiter-en',
    'aura-2-mars-en', 'aura-2-neptune-en', 'aura-2-odysseus-en', 'aura-2-orion-en',
    'aura-2-orpheus-en', 'aura-2-pluto-en', 'aura-2-saturn-en', 'aura-2-zeus-en',
  ],
};

export const VALID_VOICES = [...VOICES_BY_GENDER.male, ...VOICES_BY_GENDER.female];

// 目前只验证过英文；Aura-2 实际还支持 es/de/fr/nl/it/ja，等真用到了再补对应音色名。
export const TTS_SUPPORTED_LANGS = ['en'];

// text: 待合成文本。voice: 上面列表里的一个 model 名。
// 返回 wav Buffer，跟 groq/tts.js 的 synthesize() 返回形状一致——响应直接就是音频字节，
// 不像 Qwen 那样还要多一次下载。
export async function synthesize(text, { voice = 'aura-2-thalia-en' } = {}) {
  if (!VALID_VOICES.includes(voice)) {
    throw new Error(`voice 必须是以下之一：${VALID_VOICES.join(', ')}`);
  }

  const params = new URLSearchParams({
    model: voice,
    encoding: 'linear16', // 16-bit PCM，配合 container=wav 才能拿到带 RIFF 头、能直接解析的 wav 文件
    container: 'wav',
    sample_rate: '24000', // 跟 domain/wav.js 的 ttsWavToDiscordPcm 假设的输入采样率对齐
  });

  return postJsonForAudio(`/speak?${params}`, { text });
}
