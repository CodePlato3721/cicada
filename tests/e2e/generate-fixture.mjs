// 一次性脚本：生成 tests/e2e/fixtures/sample-en.wav 这个固定的语音输入 fixture。
// 冒烟测试本身不跑这个脚本——fixture 是提前生成好、提交进 git 的静态文件,每次跑
// 冒烟测试直接读它当 STT 输入,不需要每次测试都先合成一遍(减少一次网络调用,也让
// 测试输入保持稳定、可重复)。要重新生成 fixture(比如换一句话)才手动跑一次:
//   npm run build && node tests/e2e/generate-fixture.mjs
//
// 导入路径指向 dist/ 而不是 src/：deepgram/tts.js 已经在 TASK-04 转成 .ts，跟
// smoke.test.js 同样的理由（见那边的注释），这里固定指向编译产物，不用跟着每层
// 迁移进度改一遍。
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { synthesize } from '../../dist/adapter/out/deepgram/tts.js';

const FIXTURE_TEXT = 'Hello, how are you doing today? I am testing the translation pipeline.';
const OUT_PATH = fileURLToPath(new URL('./fixtures/sample-en.wav', import.meta.url));

const wavBuffer = await synthesize(FIXTURE_TEXT, { voice: 'aura-2-thalia-en' });
await writeFile(OUT_PATH, wavBuffer);
console.log(`Generated fixture: ${OUT_PATH} (${wavBuffer.length} bytes)`);
