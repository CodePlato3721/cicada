import { createHash } from 'node:crypto';

// 中文翻译缓存的规范化 + key 构造，纯函数，不涉及网络/Redis——具体的 Redis 读写在
// adapter/out/redis/translate-cache.js。设计背景见 DESIGN.md：这个功能目前只覆盖
// 中文源语言（见 pipeline.js 调用处的判断），不是这个文件自己判断语言范围。

// 语气词白名单——只在句首/句尾匹配（不是全句扫描替换），beta 期间可按实测继续加词。
// "吧"/"了" 会影响语气强度/时态完成度，不放进来剥离。
const FILLER_PARTICLES = ['啊', '呀', '嘛', '呢', '哦', '噢', '诶', '哈', '嘞', '咯', '哇'];

// 全角标点 → 半角，只覆盖常见的句读/引号/括号符号。中间是否还有别的全角符号没覆盖到，
// 不影响正确性，只是少归一化了一种符号，不会导致误判。
const FULLWIDTH_TO_HALFWIDTH_PUNCTUATION: Record<string, string> = {
  '，': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '、': ',',
  '～': '~',
};

const FULLWIDTH_PUNCTUATION_PATTERN = new RegExp(
  `[${Object.keys(FULLWIDTH_TO_HALFWIDTH_PUNCTUATION).join('')}]`,
  'g',
);

function convertFullwidthPunctuation(text: string): string {
  return text.replace(FULLWIDTH_PUNCTUATION_PATTERN, (ch) => FULLWIDTH_TO_HALFWIDTH_PUNCTUATION[ch] ?? ch);
}

const FILLER_ALTERNATION = FILLER_PARTICLES.join('|');
// 句首：连续的语气词整段剥掉（比如"啊呀，好的" → "，好的"）。
const LEADING_FILLER_PATTERN = new RegExp(`^(?:${FILLER_ALTERNATION})+`, 'u');
// 句尾：语气词可能连续重复（"好的啊啊啊"），也可能后面还跟着已经归一化过的单个标点
// （"对啊！"）——把语气词去掉，标点原样保留在原来的位置。
const TRAILING_FILLER_PATTERN = new RegExp(`(?:${FILLER_ALTERNATION})+([!?.,;:~]*)$`, 'u');

// 中文源语言文本的规范化，固定按以下顺序执行（顺序本身是设计的一部分，见 DESIGN.md
// 「Normalization」）：
// 1. 标点：全角转半角，连续重复的标点合并为一次出现；句子中间的单个标点不受影响
// 2. 语气词剥离：只匹配句首/句尾
// 3. 重复吐字/口吃压缩：连续重复 2 次以上的相同字符/词压缩为 1 次
// 4. 空白归一化：全角空格/多空格合并，首尾 trim
//
// 返回空字符串代表这句话规范化之后就是纯语气词/噪音——调用方（pipeline.js）据此跳过
// 缓存查询和翻译，不产出任何输出。
export function normalizeChineseText(text: string): string {
  let result = text;

  result = convertFullwidthPunctuation(result);
  result = result.replace(/([!?.,;:~])\1+/g, '$1');

  result = result.replace(LEADING_FILLER_PATTERN, '');
  result = result.replace(TRAILING_FILLER_PATTERN, '$1');

  // 惰性捕获组 + 反向引用要求至少再重复一次，同时覆盖单字重复（"我我我要" → "我要"）
  // 和多字词组重复（"然后然后我" → "然后我"），不需要为不同长度的重复单元各写一条规则。
  // 捕获组限定只匹配中日韩统一表意文字（一-鿿）——这里踩过一个坑：不限字符集时
  // （`(.+?)\1+`），"这个boss有点难打" 这种中英混杂的游戏黑话会被误判成 "boss" 里的
  // "s" 重复了，压缩成 "这个bos有点难打"，把英文词本身压坏了。中文口吃/重复吐字才是
  // 这条规则真正要处理的场景，限定字符集就不会跨到夹在中文里的英文单词/数字上。
  result = result.replace(/([一-鿿]+?)\1+/gu, '$1');

  result = result.replace(/[\s　]+/g, ' ').trim();

  return result;
}

export interface TranslateCacheKeyParams {
  gameId: string;
  srcLang: string;
  tgtLang: string;
  normalizedText: string;
}

// 缓存 key：namespace 前缀 + SHA-256（不用语言内置的非持久化 hash 函数，见 DESIGN.md
// 「Cache key」）。四个维度都编码进去，任何一个变了就是不同的 key——game_id 变了，
// 术语替换结果可能不同；src/tgt 语言变了，翻译方向不同；normalizedText 变了，内容
// 本身不同。
export function buildTranslateCacheKey({ gameId, srcLang, tgtLang, normalizedText }: TranslateCacheKeyParams): string {
  const hash = createHash('sha256').update(`${gameId}:${srcLang}:${tgtLang}:${normalizedText}`).digest('hex');
  return `translate:${hash}`;
}
