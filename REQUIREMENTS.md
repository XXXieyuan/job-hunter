# Job Hunter — User Requirements Document

## 给 AI Coding Agent 的任务描述

请用多专家辩论架构（8 Phase pipeline）从零重新设计和实现 Job Hunter 应用。

---

## 问题描述

我是一个在澳大利亚找工作的求职者。我每天需要在 SEEK、LinkedIn、APSJobs 等平台手动搜索职位，一个一个看 JD，判断自己是否 match，然后写 cover letter。这个过程非常耗时，而且容易遗漏好机会。

**我需要一个 AI 驱动的职位搜索助手**，帮我自动完成：搜集职位 → 分析匹配度 → 推荐最合适的职位 → 生成 cover letter。

---

## 目标用户

1. **主用户：澳大利亚求职者**（技术岗为主，如 AI Engineer、Data Scientist、Software Engineer）
2. 可能用中文或英文操作（需要双语支持 zh/en）
3. 自行部署在自己的电脑上运行（self-hosted web app）

---

## 核心功能

### 1. 职位抓取 (Job Scraping)

从以下平台自动抓取职位信息：
- **SEEK** (seek.com.au) — 澳大利亚最大的求职平台
- **LinkedIn** (linkedin.com/jobs)
- **APSJobs** (apsjobs.gov.au) — 澳大利亚政府职位

抓取内容包括：职位标题、公司、地点、薪资（如有）、完整 JD 描述、发布日期、原始链接。

支持按关键词搜索，例如："AI, machine learning, NLP, data science"。
支持分页自动翻页（最多 N 页）。
支持定时/手动触发抓取。
抓取进度可视化（正在抓第几页，已抓到多少职位）。

### 2. 简历管理 (Resume Management)

- 上传简历文件（支持 .docx, .pdf）
- AI 自动解析简历：提取姓名、技能列表、工作经历、教育背景
- 支持管理多份简历（设置一份为"主简历"）
- 简历数据用于后续匹配和 cover letter 生成

### 3. AI 匹配分析 (Job-Resume Matching)

将简历与每个职位进行 AI 匹配，生成匹配分数（0-100）：
- **技能匹配** — 简历技能 vs JD 要求技能
- **语义匹配** — 用 OpenAI embedding 做向量相似度
- **关键词匹配** — JD 中出现的关键词与简历的重合度
- 综合加权得分

支持批量分析（一次分析所有未分析的职位）。
分析结果持久化存储，不重复分析。

### 4. Cover Letter 生成

对选定的职位，基于：
- 该职位的 JD
- 用户的主简历
- AI 分析出的匹配点

自动生成专业的 cover letter（3-5 段，< 400 字）。
支持中英文生成。

### 5. 职位浏览与管理

- 按匹配分数排序浏览所有职位
- 筛选：按平台、按分数范围、按关键词
- 查看职位详情（JD + 匹配分析 + cover letter）
- 标记职位状态：未读/已读/已申请/不感兴趣
- 公司信息聚合（同一公司的多个职位）

### 6. 管理面板 (Admin)

- 查看爬虫运行历史（每次抓取的时间、结果、错误）
- 手动触发抓取
- 查看系统统计（职位总数、简历数、匹配数）
- 配置 OpenAI API 相关设置

---

## 技术约束

| 项目 | 要求 |
|------|------|
| 运行环境 | Node.js，self-hosted |
| 数据库 | SQLite（轻量，无需额外安装） |
| 前端 | Web UI（server-side rendering 或 SPA 均可） |
| AI API | OpenAI 兼容接口（支持自定义 BASE_URL） |
| 国际化 | 中英文双语 |
| 安全 | API Key 通过环境变量配置，不硬编码 |

---

## 质量要求

- 界面要现代、美观、专业，不要看起来像简陋的 demo
- 响应式设计（桌面端为主，但手机端也能用）
- 错误处理完善（爬虫失败、API 超时等都有友好提示）
- 数据持久化（SQLite），重启后数据不丢失
- 日志记录（操作日志、错误日志）

---

## 复杂度评估

**L 级别** — 这是一个完整项目，需要跑全部 Phase 1-8。
