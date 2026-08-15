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

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const rootLogger = pino({
  level: LOG_LEVEL,
  // pino 默认 time 字段是 epoch 毫秒数——非 TTY（pm2）场景下日志就是原始 JSON，直接
  // 显示这个字段人眼没法读，改成 ISO 字符串，ssh 上去 `pm2 logs` 直接看也知道是几点。
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: process.stdout.isTTY
    ? {
        target: 'pino-pretty',
        options: { translateTime: 'yyyy-mm-dd HH:MM:ss.l', ignore: 'pid,hostname' },
      }
    : undefined,
});

// module：模块标签，对应以前手写的 `[pipeline]`/`[listener]` 这类前缀，会作为
// 结构化字段（`module`）写进每条日志，而不是拼进 message 字符串里。
export function createLogger(module) {
  return rootLogger.child({ module });
}

export default rootLogger;
