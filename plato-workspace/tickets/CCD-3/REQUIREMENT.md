# User Story
增加 Redis 缓存层，优化调用 LLM 翻译的效率，命中缓存直接返回译文
# Acceptance Criteria
当stt分析后出现之前翻译过的类似的文本，就不访问llm，直接返回译文
