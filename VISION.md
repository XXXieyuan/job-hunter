# Vision

## Mission Statement
把澳大利亚找工作从"体力活"变成"智能决策"——Job Hunter 自动抓职位、AI 分析匹配度、一键生成专业 Cover Letter，让求职者把时间花在真正重要的事情上。

## Target Users & Personas

### Primary: Andy Huang
- **Role**: AI/ML Engineer 求职者，目标澳洲技术岗（AI Engineer, Data Scientist, Software Engineer）
- **Pain points**: 每天手动刷 SEEK/LinkedIn/APSJobs，逐个读 JD 判断是否 match，耗时且容易遗漏；Cover Letter 写起来痛苦
- **Needs**: 自动化抓取 + 智能匹配排序 + Cover Letter 一键生成，中英双语
- **Context**: 自部署在本地电脑，懂技术但希望零摩擦使用

### Secondary: 华人技术移民
- **Role**: 有经验的技术从业者，英文读写不如母语者
- **Pain points**: 英文 Cover Letter 语法/用词不自信，担心错过政府岗位（APS）
- **Needs**: 中文界面 + 英文输出，APSJobs 专项抓取，Gap 分析知道自己缺什么

### Tertiary: 澳洲本地求职者
- **Role**: 刚毕业或转行的澳洲本地学生
- **Pain points**: 职位太多，不知道从哪开始；简历不知道怎么针对不同岗位调整
- **Needs**: 快速筛选高匹配度职位，了解自己简历和 JD 的差距

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|---------------|
| Setup 完成率 | ≥ 90% 用户 10min 内完成配置并开始抓取 | 首次抓取时间戳 |
| 周活跃率 | 完成配置用户中 ≥ 60% 每周 ≥ 3 次抓取 | 抓取日志频率 |
| 短名单率 | 30 天内 ≥ 40% 用户将 ≥ 1 个职位加入短名单 | 数据库 status 字段 |
| Cover Letter 生成率 | 短名单职位中 ≥ 50% 生成过 CL | 数据库 CL 记录 |
| 匹配分分布 | 平均分在 40-80，标准差 > 10（非全零或全高分） | 批量分析后统计 |
| 双语使用率 | ≥ 30% CL 生成为英文 | CL 语言字段 |
| 系统可用性 | API 错误率 < 1% | 错误日志统计 |

## Feature Scope

### In-Scope (P0 = must have)

**Job Scraping**
- SEEK (seek.com.au) 职位抓取：标题/公司/地点/薪资/JD/链接/发布日期
- APSJobs (apsjobs.gov.au) 职位抓取（含 classification/location/salary）
- LinkedIn 职位抓取（需登录态，降级为公开页面抓取）
- 关键词搜索（支持多词，如 "AI, machine learning, data science"）
- 分页自动翻页（可配置最大页数）
- 手动/定时触发抓取
- **实时进度可视化**：SSE 流式推送，当前页数/已抓职位数

**Resume Management**
- 上传 .docx / .pdf 简历
- AI 自动解析：姓名/技能列表/工作经历/教育背景
- 多简历管理，设定"主简历"
- 简历数据持久化存储

**AI Matching**
- 技能匹配：简历技能 vs JD 要求关键词重合度
- 语义匹配：OpenAI embedding 向量相似度（需要 API key）
- 关键词匹配：JD 关键词在简历中的出现次数
- 综合加权得分 0-100
- 批量分析所有未分析职位
- 分析结果缓存，不重复分析

**Cover Letter Generation**
- 基于 JD + 主简历 + 匹配分析生成 CL
- 3-5 段，英文 < 400 words / 中文 < 400 字
- 支持中英文双语生成
- 一键复制/下载

**Job Browsing & Management**
- 按匹配分排序浏览所有职位
- 筛选：平台/分数范围/关键词/状态
- 职位详情：JD + 匹配分析 + Gap 分析 + CL
- 状态标记：未读/已读/已申请/不感兴趣
- 公司聚合：同一公司职位合并展示

**Admin Panel**
- 抓取历史（时间/来源/结果/错误）
- 手动触发抓取
- 系统统计（职位总数/简历数/匹配数/CL 数）
- OpenAI API 配置（Base URL + API Key，环境变量存储）

### In-Scope (P1 = should have)

- 空数据引导页（第一次使用的 onboarding）
- 职位搜索历史
- 匹配分析详情展开（技能/Gap/关键词详情）
- 系统日志查看

### In-Scope (P2 = nice to have)

- 定时自动抓取（cron job）
- 职位相似推荐
- 薪资范围可视化
- 简历优化建议

### Explicitly Out-of-Scope
- 职位申请自动化提交（不实现自动投简历）
- 邮件/短信通知
- 多用户账号系统（单用户 app）
- 移动端原生 App
- 职位数据导出（CSV/JSON export）

### Deferred to Backlog
- 定时自动抓取
- 职位相似推荐
- 简历优化建议
- 薪资范围可视化

## Key Decisions

1. **SPA vs SSR**: 采用 **SSR (EJS)** — SEO 不重要但首屏速度重要，SSR 更适合单用户轻量 app
2. **SQLite over PostgreSQL**: 轻量、自包含、无需额外进程，用户 self-hosted 场景最优
3. **Scraper 架构**: Python 脚本（可复用 v1 积累）通过 Node.js 子进程调用，SSE 进度推送
4. **Matching 不依赖 embedding 时**: 纯关键词 + 技能权重匹配，确保无 API Key 时也能用
5. **Bilingual**: 全栈中文文案，CL 支持中英切换，前端 i18n 轻量方案（URL param `?lang=en`）
6. **Admin vs User**: 同一 app，不同路由路径 (`/` vs `/admin`)，共享数据库

## TL;DR

Job Hunter: AI 驱动澳洲求职助手——自动抓 SEEK/LinkedIn/APSJobs 职位，智能匹配简历与 JD 分数，一键生成中英 Cover Letter，让找工作从体力活变智能决策。
