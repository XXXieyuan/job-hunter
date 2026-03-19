# Job Hunter v2

AI 驱动澳洲求职助手 — 自动抓取 SEEK/LinkedIn/APSJobs 职位，智能匹配简历与 JD，一键生成中英 Cover Letter。

[English](#english) | [中文](#中文)

---

## 中文

### 核心功能

- 🔍 **职位抓取** — SEEK / LinkedIn / APSJobs，支持关键词搜索、分页、SSE 实时进度
- 📄 **简历管理** — 上传 .docx/.pdf，AI 自动解析技能/经验/学历
- 🎯 **智能匹配** — 技能匹配 + 语义匹配 + 关键词匹配，综合 0-100 分
- 📝 **Cover Letter** — 基于 JD + 简历 + Gap 分析，生成中英文 CL
- 📊 **职位管理** — 按匹配度/来源/状态筛选，标记申请进度
- ⚙️ **管理面板** — 抓取历史、系统统计、日志查看、API 配置

### 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY 和 OPENAI_BASE_URL

# 3. 启动服务
npm start
# 访问 http://localhost:3001

# 4. 开发模式（热重载）
npm run dev
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 端口，默认 3001 |
| `OPENAI_API_KEY` | 否 | OpenAI API Key，无则降级为纯关键词匹配 |
| `OPENAI_BASE_URL` | 否 | API 地址，默认 `https://api.openai.com/v1` |
| `ADMIN_TOKEN` | 否 | 管理面板访问令牌 |
| `DATABASE_PATH` | 否 | SQLite 文件路径，默认 `data/jobhunter.db` |

### 技术栈

- **后端**: Node.js 20 + Express.js
- **模板**: EJS (SSR)
- **数据库**: SQLite (better-sqlite3)
- **AI**: OpenAI SDK (兼容任意 OpenAI 兼容 API)
- **抓取**: Python 3 + Playwright (SEEK) + Requests (APSJobs)
- **样式**: 纯 CSS + CSS Variables，深色主题

### 目录结构

```
job-hunter/
├── src/
│   ├── server.js              # 入口
│   ├── db/                    # 数据库 (schema + connection)
│   ├── routes/                # API 路由 + 页面路由
│   │   ├── apiJobs.js
│   │   ├── apiResumes.js
│   │   ├── apiScrape.js
│   │   ├── apiMatch.js
│   │   ├── apiCoverLetter.js
│   │   └── apiAdmin.js
│   ├── services/              # 业务逻辑
│   │   ├── resumeParser.js   # docx/pdf 解析
│   │   ├── scraperService.js  # Python subprocess + SSE
│   │   ├── matchService.js   # 匹配算法
│   │   └── coverLetterService.js  # CL 生成
│   ├── middleware/
│   └── utils/
├── scrapers/                  # Python 抓取器
│   ├── run_scraper.py
│   └── scrapers/
│       ├── seek_scraper.py
│       ├── linkedin_scraper.py
│       └── apsjobs_scraper.py
├── views/                     # EJS 页面模板
│   ├── layout.ejs
│   ├── home.ejs
│   ├── jobs/{list,detail}.ejs
│   ├── resumes/list.ejs
│   ├── admin/dashboard.ejs
│   └── scrape.ejs
├── public/                    # 静态资源
│   ├── css/                   # 暗色主题 CSS
│   └── js/                    # 前端交互 (SSE, 上传, CL)
├── data/                      # SQLite 数据库文件
└── .env                       # 环境变量
```

### API 概览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/resumes/upload` | POST | 上传简历 |
| `/api/resumes` | GET | 简历列表 |
| `/api/jobs` | GET | 职位列表 (支持筛选/分页) |
| `/api/jobs/:id` | GET | 职位详情 |
| `/api/scrape/run` | POST | 触发抓取 |
| `/api/scrape/progress/:id` | GET | SSE 实时进度 |
| `/api/match/run` | POST | 批量匹配分析 |
| `/api/cover-letters/generate` | POST | 生成 CL |
| `/api/admin/stats` | GET | 系统统计 |

### 离线运行

无 `OPENAI_API_KEY` 时：
- 匹配分析降级为纯关键词模式（技能匹配 + 关键词匹配）
- Cover Letter 生成不可用，界面显示提示
- 职位抓取、简历上传、职位管理等功能完全正常

---

## English

### Quick Start

```bash
npm install
cp .env.example .env  # fill in OPENAI_API_KEY and OPENAI_BASE_URL
npm start
# Open http://localhost:3001
```

### Architecture

- **Backend**: Node.js 20 + Express.js + EJS SSR
- **Database**: SQLite (better-sqlite3)
- **Scrapers**: Python 3 (Playwright for SEEK, requests for APSJobs)
- **AI**: OpenAI SDK with custom base URL support
- **Styling**: Dark theme, CSS variables, no framework

### Key Features

- 🔍 Job scraping from SEEK / LinkedIn / APSJobs with SSE progress
- 📄 Resume upload (.docx/.pdf) with AI skill extraction
- 🎯 AI matching (skill + semantic + keyword, 0-100 score)
- 📝 Cover letter generation (EN + 中文)
- 📊 Job filtering by score/source/status
- ⚙️ Admin panel with stats, logs, and config

---

## Development

```bash
# Run scraper manually
python scrapers/run_scraper.py --source seek --keywords "AI,ML" --max_pages 3

# View database
sqlite3 data/jobhunter.db "SELECT COUNT(*) FROM jobs; SELECT * FROM jobs LIMIT 3;"
```

## License

MIT
