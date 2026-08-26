// 2026-08-26：session.sourceLang 从"笼统的 ISO-639-1 基础码"（如 'zh'/'en'）改成了
// 具体的 BCP-47 locale 码（如 'zh-TW'/'en-US'/'ar-EG'，见 ports/stt.js 的
// SUPPORTED_SOURCE_LANGS），直接透传给 STT 供应商换取更准的识别效果（供应商按
// 地区口音/发音习惯细分模型，裸 'ar' 这种笼统码不如具体地区码准）。
//
// 但术语库（terminology.js）和识别关键词（keyterms.js）两套词典都是按"语言家族"
// 维护的，不区分地区——比如阿拉伯语术语译法不会因为说话人是沙特口音还是埃及口音
// 而不同，词典里只有一份 'ar' 词条，不是 'ar-SA'/'ar-EG' 各存一份。这两个模块查表前
// 都需要把具体 locale 还原成基础语言码，抽成这一个函数，不在多处各自重复写
// `.split('-')[0]`。
//
// 简单按连字符切分就够：给定列表里的 79 个 locale 码没有例外（'zh-TW' → 'zh'，
// 'es-419' → 'es'，'nl-BE' → 'nl' 等），本身已经是标准 locale 码，不需要额外的
// 别名表。
export function toBaseLang(locale: string | undefined): string | undefined {
  return locale?.split('-')[0];
}
