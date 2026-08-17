迁移是分任务、分层推进的（domain → application → adapter/out → adapter/in → scripts），不是一次性全项目转换。`tsconfig.json` 用 `allowJs: true` + `checkJs: false`：还没转的 `.js` 文件原样纳入编译、透传进 `dist/`，不会因为缺类型标注报错；某一层转完之后该层文件已经是 `.ts`，自动被 `strict` 覆盖检查，不需要为了兼容未转层而临时关闭 `strict`。

不引入 `ts-node`/`tsx`：`npm run build` 执行 `tsc` 编译到 `dist/`，`start`/`deploy-commands` 等入口脚本都是先 `npm run build` 再 `node dist/...`，没有直接跑 `.ts` 的路径。

`tsc` 不会自动拷贝 JSON 等非代码资源文件到 `dist/`——`src/domain/terminology/*.json` 这类词典数据文件保持 `.json` 不转，需要靠 `npm run build:copy-assets`（`build` 脚本里 `tsc` 之后接的一步）手动复制进 `dist/domain/terminology/`。以后哪个目录下新增了不经过 tsc 编译、但运行时需要读取的静态资源文件，照这个模式在 `build:copy-assets` 里加一条复制，不要假设 `tsc` 会连它一起处理。

`tests/e2e/smoke.test.js` 的导入路径固定指向 `dist/`（编译产物），不是 `src/`——这份测试跨越整个迁移过程当回归基准，这样每层转完 `.ts` 之后不需要跟着改一次测试里的 import 路径，也更贴近"验证构建产物本身能不能跑通"这个目标。运行方式是 `npm run test:e2e`（内部会先 `npm run build`）。

每层转完 `.ts` 之后，给这一层里**纯函数**（不依赖外部 IO/网络/onnx 模型这类有状态资源）补单元测试，放在 `tests/unit/<层>/`，用内置 `node:test`/`node:assert`（不引入额外测试框架），导入路径同样固定指向 `dist/`，跑法 `npm run test:<层>`（内部先 build）。有外部依赖/需要维护运行时状态的类（比如 domain 层的 `SileroSession`/`StreamingVad`，依赖 onnx 模型文件和持久化推理状态）不强求补单元测试，留给需要时再评估怎么测（mock 掉 onnxruntime 还是接受用 e2e 兜底），不要为了凑覆盖率硬测。

跨层引用还没转 TS 的 `adapter/out/*` JS 模块（`allowJs: true` + `checkJs: false`）时，`tsc` 仍然会用控制流分析推断这些 JS 导出的类型，直接把它们赋值给本层新定义的类型化接口/函数类型即可（比如 `const PROVIDERS: Record<string, TranscribeFn> = { groq: groqTranscribe, ... }`），不需要 `as unknown as` 之类的类型断言；只要接口里非公共字段标成可选（`?`），能容忍不同供应商实现之间字段的细微差异。

涉及 `@discordjs/voice`/`discord.js` 对象（`VoiceConnection`、语音频道）时直接从这两个包导入官方类型（`VoiceConnection`、`VoiceBasedChannel`），不要自己手写 ad-hoc 类型——`VoiceBasedChannel` 通过库自身的接口合并已经带有 `.send()` 等文字聊天能力，能直接拿来用。

关于 `test:<层>` 这个命名约定：实际项目里没有拆成 `test:domain`/`test:application` 这种每层各一个脚本，而是复用同一个 `test:unit` 脚本，往里追加各层的测试文件 glob（`node --test tests/unit/domain/*.test.js tests/unit/application/*.test.js ...`）——每层转完后在 `package.json` 的 `test:unit` 脚本里加一段 glob，不要新建 `test:<层>` 脚本。

某个 npm 依赖既没有自带类型声明、也没有对应的 `@types/*` 包时（比如 `wav`），在 `src/types/<pkg>.d.ts` 里写一份只覆盖项目实际用到的那部分 API 的最小 `declare module` 声明，不要用 `any` 或整体关掉该文件的类型检查。

第三方 SDK 声明的返回类型可能没跟上 API 实际返回的字段（比如 groq-sdk 的 `Transcription` 类型只标了 `text`，但 `response_format: 'verbose_json'` 运行时还会带 `language`/`duration`）——这种情况不要对整个返回值做 `as unknown as` 断言，改成显式挑出需要的字段构造一个新对象（`{ text: transcription.text, language: (transcription as { language?: string }).language }`），既能满足下游类型、又不掩盖其他字段可能的类型错误。

一次性 CLI 脚本（`scripts/*.js`）迁移到 `.ts` 时，不要沿用原来 `__dirname` 反推"项目根目录/兄弟目录"的相对路径写法——`tsc` 编译产物的目录深度（比如 `dist/scripts/`）跟源码所在层级（`scripts/`）不一定一致，原来手写的 `../` 层数在编译后会算错。这类脚本本来就假设"永远从项目根目录（`package.json` 所在目录）用 `npm run` 触发"，改成锚定 `process.cwd()` 来定位项目根目录下的固定路径（比如 `scripts/drafts/`、`src/domain/terminology/`），不随编译产物挪到哪一层而改变。

给 `scripts/`（或任何不在主 `tsconfig.json` 的 `rootDir` 之下）的目录建独立的 `tsconfig.<name>.json` 并用 `"extends": "./tsconfig.json"` 继承主配置时，即便主配置没有显式写 `"types"` 字段（靠 tsc 默认自动扫 `node_modules/@types` 全部引入，这在主配置本身跑的时候确实生效），子配置继承时实测会扫不到 `@types/node`（`process`/`console`/`fetch` 等全局类型报"找不到"）——原因未深究，子配置里显式写 `"types": ["node"]`，不要依赖这个不一致的自动推断行为。
