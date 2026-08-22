// 统一的结构化日志。替代之前散落在各处、格式不统一的 console.log/error/warn——
// 有的靠手写 `[pipeline]`/`[listener]` 前缀标模块，有的完全没有前缀；有的靠
// `new Date().toLocaleTimeString()` 手动拼时间戳（voice-listener.js 原来这么干），
// 有的干脆没有任何时间信息，ssh 上去看日志时格式对不上、也没法按时间/模块可靠地过滤。
//
// 现在统一用 pino：每条日志自带 ISO 时间戳 + level + `module` 字段（对应以前手写的
// 前缀），不用再各自为政。
//
// 输出格式按是否交互式终端自动切换，不用额外配置：
// - 本地 `npm start`（stdout 是 TTY）→ 接 pino-pretty，人读着舒服的单行彩色格式
// - pm2 托管运行（stdout 被重定向进日志文件，不是 TTY）→ 原始 JSON，一行一条。
//   这是故意的：现在没有接日志平台（见 CLAUDE.md「规范化日志」的讨论，platform 那部分
//   先缓一缓），但 JSON 是结构化日志平台（Kibana/Loki 之类)天然能直接吃的格式，以后
//   真要接的时候这层不用重写，日志格式已经是对的了。
//
// pino-pretty 只在 TTY 分支才会被加载，纯 pm2 环境走不到这条路径，所以放 devDependencies
// 也没问题，不会让生产环境的 `npm ci --omit=dev` 装出来的东西缺这个模块时报错。
//
// LOG_LEVEL 环境变量控制输出级别（trace/debug/info/warn/error/fatal），默认 info。
import pino from 'pino';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// TTY 分支不直接用 pino 的 `transport: { target: 'pino-pretty', ... }`（worker 线程）
// 或者把 pino-pretty() 的返回值直接当 pino 的目标 stream 用（同线程，但 pino-pretty
// 内部靠 sonic-boom 直接往 fd 写字节）——这两种实测在 Windows 的 PowerShell/cmd 控制台
// 下都会把中文这类非 ASCII 字符按错误的代码页解析成乱码，哪怕 `chcp 65001` 已经设成
// UTF-8。根因：Node 只有字符串走 `console.log`/`process.stdout.write(string)` 这条
// 高层路径时，在 Windows 控制台上才会用 Unicode-safe 的 WriteConsoleW；sonic-boom
// 那种直接写 fd（等价于 fs.writeSync）的方式不走这条路径，会被按系统 OEM 代码页
// （常见是 437，不是当前 chcp 设的那个）重新解释，跟 chcp 设成什么无关。Linux/pm2
// 环境不受影响——本来就不会进这个分支，直接吐原始 JSON。
//
// 修法：手动用 pino-pretty 的 prettyFactory 只做"格式化成字符串"这一步，不让
// pino-pretty 自己的输出流负责真正写入；真正的写入交给 process.stdout.write(字符串)，
// 走回 console.log 那条已验证在 Windows 上正常的路径。
//
// createRequire 而不是顶层 `import pino-pretty` 或走 pino 的 transport 机制：保持
// "只有 TTY 分支才会真的加载 pino-pretty" 这个既有约定——顶层 import 会导致任何环境
// 启动都要加载它，pino-pretty 放 devDependencies、生产环境 `npm ci --omit=dev` 不装它
// 这件事就会破。
function buildPrettyStream(): Writable {
  const require = createRequire(import.meta.url);
  const { prettyFactory } = require('pino-pretty') as typeof import('pino-pretty');
  const prettify = prettyFactory({ translateTime: 'yyyy-mm-dd HH:MM:ss.l', ignore: 'pid,hostname' });

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      process.stdout.write(prettify(chunk.toString()));
      callback();
    },
  });
}

const rootLogger = pino(
  {
    level: LOG_LEVEL,
    // pino 默认 time 字段是 epoch 毫秒数——非 TTY（pm2）场景下日志就是原始 JSON，直接
    // 显示这个字段人眼没法读，改成 ISO 字符串，ssh 上去 `pm2 logs` 直接看也知道是几点。
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  // 第二个参数是 pino 的目标 stream：TTY 用上面的同线程格式化 stream，非 TTY 传
  // undefined，pino 会默认直接写 process.stdout（原始 JSON），跟改动前行为一致。
  process.stdout.isTTY ? buildPrettyStream() : undefined,
);

// module：模块标签，对应以前手写的 `[pipeline]`/`[listener]` 这类前缀，会作为
// 结构化字段（`module`）写进每条日志，而不是拼进 message 字符串里。
export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export default rootLogger;
