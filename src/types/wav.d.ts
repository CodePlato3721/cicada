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
