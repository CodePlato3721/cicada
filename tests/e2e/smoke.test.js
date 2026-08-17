// e2e 冒烟测试：不连接真实 Discord 服务器、不走语音接收/VAD 切句这两个环节,直接从
// 一份已经生成好的音频 fixture 切入,驱动 STT → 翻译 → TTS 这条核心链路——调用真实的
// 外部供应商 API,不 mock(见 DESIGN.md)。断言只到"最终生成出了一个 .wav 文件"这一层,
// 不校验音频内容/译文语义是否正确,只是拿它当"链路没跑断"的信号。
//
// 这个测试是 TypeScript 迁移前后的行为回归基准:迁移前先在当前 JS 代码库上跑通它,
// 迁移完成后(TASK-07)重新跑一遍,确认改写没有破坏核心链路的可运行性。
//
// 跑法：npm run test:e2e（先 tsc 编译到 dist/、再跑测试；需要 .env 里配好
// DEEPGRAM_API_KEY / DEEPSEEK_API_KEY 等真实 key，会产生真实的 API 调用/计费，
// 不适合放进 CI 无脑跑，先手动执行）。
//
// 导入路径指向 dist/ 而不是 src/：从这个迁移的第一个任务（domain 层转 TS）起，
// 源码就分批从 .js 变成 .ts，这份测试作为跨越整个迁移过程的回归基准，不想每转完
// 一层就跟着改一次导入路径——直接固定指向编译产物，跟 pm2 生产环境实际运行的是
// 同一份代码，也更贴近"验证构建产物本身能不能跑通"这个目标。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transcribe } from '../../dist/application/ports/stt.js';
import { translate } from '../../dist/application/ports/translate.js';
import { synthesize, resolveTtsProvider } from '../../dist/application/ports/tts.js';
import { parseWav } from '../../dist/domain/wav.js';

// fixture：一段固定的英文语音（tests/e2e/generate-fixture.mjs 生成，已提交进 git，
// 不在测试运行时现合成——保持测试输入稳定、可重复，也少一次网络调用）。
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/sample-en.wav', import.meta.url));
const SOURCE_LANG = 'en';
// 目标语言选一个路由到 deepgram TTS 的（见 ports/tts.js 的 TTS_PROVIDER_BY_LANG），
// 跟 STT fixture 的供应商一致，不是必须的，只是让这条链路的每一环都用得上已经验证过
// 格式的 deepgram wav（24kHz 单声道 16-bit），少一个变量。
const TARGET_LANG = 'fr';
const TTS_VOICE = 'aura-2-agathe-fr';

const OUTPUT_DIR = fileURLToPath(new URL('./output/', import.meta.url));
const OUTPUT_PATH = fileURLToPath(new URL('./output/smoke-output.wav', import.meta.url));

test('STT → 翻译 → TTS 核心链路能跑通并产出一个 wav 文件', async () => {
  const sttResult = await transcribe(FIXTURE_PATH, { language: SOURCE_LANG });
  const transcript = sttResult.text?.trim();
  assert.ok(transcript, `STT 应该识别出非空文本，实际返回：${JSON.stringify(sttResult)}`);

  const translatedText = (await translate(transcript, TARGET_LANG))?.trim();
  assert.ok(translatedText, `翻译应该返回非空文本，原文："${transcript}"`);

  const provider = resolveTtsProvider(TARGET_LANG);
  assert.ok(provider, `目标语言 "${TARGET_LANG}" 应该有对应的 TTS 供应商`);

  const ttsWav = await synthesize(translatedText, { voice: TTS_VOICE, targetLang: TARGET_LANG, provider });

  // 断言只到"生成出了一个 .wav 文件"这一层：真的落盘、文件存在、能被解析成合法的
  // WAV（RIFF/fmt/data chunk 齐全），不校验音频内容/译文语义。
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, ttsWav);

  const fileInfo = await stat(OUTPUT_PATH);
  assert.ok(fileInfo.size > 0, '生成的 wav 文件不应该是空文件');

  const parsed = parseWav(ttsWav);
  assert.ok(parsed.data.length > 0, '生成的 wav 应该包含实际音频数据');
});
