// `wav` 包没有自带类型声明，npm 上也没有对应的 @types/wav——这里只声明项目实际用到的
// 那一小部分（Writer，构造参数 + pipe/end），不追求覆盖整个包的 API。
declare module 'wav' {
  import { Duplex } from 'node:stream';

  export interface WriterOptions {
    sampleRate?: number;
    channels?: number;
    bitDepth?: number;
  }

  export class Writer extends Duplex {
    constructor(options?: WriterOptions);
  }
}
