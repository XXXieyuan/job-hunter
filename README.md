# Job Hunter

Job Hunter 是一个 AI 驱动的职位搜索助手，专注于澳大利亚市场。它帮助求职者了解自己与开放职位的匹配度，生成量身定制的求职信，并突出简历与职位要求之间的差距。

## 核心功能

### 🎯 职位匹配与筛选
- **职位列表**：带角色、来源和最低匹配度筛选器的职位列表
- **智能评分**：结合关键词重叠和语义相似度的匹配评分（需 OpenAI API）
- **实时过滤**：根据匹配度快速筛选高相关职位

### 📊 详细职位视图
- **整体匹配度**：综合评分和详细分解
- **差距分析**：高亮显示缺失或薄弱的技能关键词
- **求职信生成**：AI 生成的中文求职信（3-5 段，400 字内）
- **公司调研**：当有公司信息时显示简介和网站

### ⚙️ 管理面板
- **批量分析**：触发对所有存储职位的批处理评分
- **数据上传**：通过 JSON 格式上传新职位数据
- **统计看板**：职位计数、平均匹配度、高匹配职位按角色分组

### 🎨 用户体验
- **深色主题**：现代化的玻璃拟态 UI
- **响应式设计**：优化桌面和移动端体验
- **无 API 模式**：缺少 API Key 时仍可使用基本功能

## 技术栈

- **后端**: Node.js, Express
- **模板引擎**: EJS + ejs-mate 布局
- **数据库**: SQLite (better-sqlite3)
- **AI 集成**: OpenAI API (语义评分和内容生成)
- **爬虫**: Puppeteer (APSJobs 爬取)
- **前端**: 原生 JavaScript + CSS 现代特性

## 架构概览

```
job-hunter/
├── src/
│   ├── server.js              # 服务器入口
│   ├── app.js                 # Express 应用配置
│   ├── config/                # 配置加载
│   │   └── index.js
│   ├── db/                    # 数据库层
│   │   ├── connection.js
│   │   ├── migrate.js
│   │   └── migrations/        # SQL 迁移文件
│   ├── repositories/          # 数据访问层
│   │   ├── jobsRepo.js
│   │   ├── fitScoresRepo.js
│   │   ├── coverLettersRepo.js
│   │   ├── companiesRepo.js
│   │   ├── resumesRepo.js
│   │   └── analysisRunsRepo.js
│   ├── services/              # 业务逻辑层
│   │   ├── openAIClient.js    # OpenAI API 封装
│   │   ├── scoringService.js  # 匹配度计算
│   │   ├── coverLetterService.js # 求职信生成
│   │   ├── analysisService.js # 批处理分析
│   │   ├── companyService.js  # 公司调研
│   │   └── resumeService.js   # 简历管理
│   ├── routes/                # 路由
│   │   ├── jobsRoutes.js      # 职位相关路由
│   │   └── adminRoutes.js     # 管理面板路由
│   └── scrapers/              # 爬虫
│       └── apsjobsScraper.js  # APSJobs 爬取
├── public/                    # 静态资源
│   ├── css/
│   │   └── main.css
│   └── js/
│       ├── main.js            # 通用前端逻辑
│       └── admin.js           # 管理面板逻辑
├── views/                     # EJS 模板
│   ├── layout.ejs
│   ├── jobs/
│   │   ├── list.ejs
│   │   └── detail.ejs
│   └── admin/
│       └── dashboard.ejs
├── data/                      # SQLite 数据库
├── .env                       # 环境变量
└── package.json
```

## 数据库模型

### 表结构

**jobs** - 职位信息
```sql
id, external_id, source, role, title, company_name, location, salary, 
description, url, posted_at, application_status, raw_json, created_at
```

**resumes** - 简历信息
```sql
id, name, summary, skills_json, experience_json, education_json, raw_json
```

**job_fit_scores** - 匹配度评分
```sql
id, job_id, resume_id, overall_score, keyword_score, embedding_score, 
breakdown_json, created_at
```

**cover_letters** - 生成的求职信
```sql
id, job_id, resume_id, language, content, created_at
```

**companies** - 公司调研信息
```sql
id, name, website, description, raw_html, industry, size, researched_at
```

**analysis_runs** - 批处理分析记录
```sql
id, status, sources_json, stats_json, error, started_at, completed_at
```

## 快速开始

### 前置要求

- Node.js 18+
- OpenAI API Key（如需语义评分和求职信生成）
- Chromium（用于爬虫，Puppeteer 会自动下载）

### 安装

```bash
git clone <this-repo-url>
cd job-hunter
npm install
```

### 环境配置

在项目根目录创建 `.env` 文件：

```bash
# 服务器配置
PORT=3001

# 数据库
DB_PATH=./data/job-hunter.sqlite

# OpenAI 配置（支持自定义 Base URL）
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.n1n.ai/v1   # 可改为 https://api.openai.com/v1
OPENAI_CHAT_MODEL=MiniMax-M2.5         # 可改为 gpt-4o 等
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# 管理面板
ADMIN_TOKEN=job-hunter-admin-2026

# 匹配阈值
FIT_THRESHOLD=70
```

**关于 Provider 和模型**：
- `OPENAI_BASE_URL` 指向 AI 服务提供商的 API 地址
- `OPENAI_CHAT_MODEL` 指定使用的聊天模型名称
- 项目已配置为支持 n1n.ai (MiniMax-M2.5)，但可轻松切换到 OpenAI、Azure 或其他兼容 API

### 启动应用

```bash
npm start
```

服务器启动在 `http://localhost:3001`（或 `.env` 中配置的端口）。

### 开发模式

```bash
npm run dev
```

## 使用指南

### 首次使用流程

1. **配置环境变量**：设置 `.env` 文件（特别是 API Key）
2. **启动服务器**：`npm start`
3. **添加简历**：通过数据库或 API 添加简历数据
4. **导入职位**：通过管理面板上传 JSON 数据或运行爬虫
5. **运行分析**：在管理面板点击"运行分析"，系统会：
   - 计算每个职位与简历的匹配度
   - 生成求职信
   - 调研公司信息
6. **浏览职位**：访问 `/jobs` 查看匹配结果

### 职位管理

#### 查看职位列表
访问 `http://localhost:3001/jobs`

**功能**：
- 角色筛选（下拉菜单）
- 来源筛选（下拉菜单）
- 最低匹配度筛选（数字输入）
- 职位卡片显示：标题、公司、地点、源、匹配度

#### 查看职位详情
点击职位卡片进入详情页

**功能**：
- **职位描述标签**：完整 JD、来源、发布时间、原链接
- **匹配分析标签**：整体评分、关键词匹配、语义相似度、已匹配关键词
- **差距分析标签**：缺失的技能关键词
- **右侧栏**：生成的求职信、公司调研信息

### 管理面板

访问 `http://localhost:3001/admin?token=job-hunter-admin-2026`

#### 运行分析
点击"运行分析"按钮触发批处理流程：
- 异步执行，返回运行 ID
- 后台计算所有职位-简历对的匹配度
- 生成求职信（如不存在）
- 调研公司信息（如不存在）
- 可刷新页面查看进度和结果

**分析流程**：
```
1. 加载所有简历
2. 加载所有职位
3. 对每个职位-简历对：
   a. 关键词匹配计算（40% 权重）
   b. 语义相似度计算（60% 权重，需 API）
   c. 生成求职信（如需）
   d. 调研公司（如需）
4. 保存结果到数据库
5. 更新统计信息
```

#### 上传职位数据
通过 JSON 数组批量导入职位：

**格式示例**：
```json
[
  {
    "title": "高级 AI 工程师",
    "company_name": "TechCorp",
    "description": "负责 AI 模型开发和优化...",
    "role": "AI Engineer",
    "url": "https://example.com/jobs/123",
    "location": "Sydney, NSW",
    "salary": "$120k - $150k",
    "posted_at": "2026-03-15"
  }
]
```

**批量导入命令**：
```bash
curl -X POST http://localhost:3001/admin/upload?token=job-hunter-admin-2026 \
  -H "Content-Type: application/json" \
  -d @jobs.json
```

#### 查看统计
管理面板显示：
- 职位总数 / 已打分职位数
- 匹配记录总数 / 平均匹配度
- 高匹配职位按角色分组

### 爬虫工具

#### APSJobs 爬取

```bash
# 基本使用
npm run scrape:apsjobs -- --keywords "数据分析,产品管理" --maxPages 3

# 导出 JSON
npm run scrape:apsjobs -- --keywords "AI,软件工程" --mode json --output data/export.json

# 指定位置
npm run scrape:apsjobs -- --keywords "工程" --location "Canberra" --maxPages 5
```

**参数说明**：
- `--keywords`: 逗号分隔的关键词列表
- `--location`: 地点筛选（可选）
- `--maxPages`: 最大爬取页数，默认 3
- `--mode`: `db`（直接写入数据库）或 `json`（导出文件）
- `--output`: JSON 输出路径（仅在 json 模式下有效）

**注意**：
- APSJobs 网站可能有反爬措施
- 爬虫使用无头浏览器，需时间较长
- 结果会自动去重（基于 external_id）

### API 集成

#### OpenAI 配置

项目使用自定义 Base URL 支持多个 AI 提供商：

```bash
# n1n.ai (默认)
OPENAI_BASE_URL=https://api.n1n.ai/v1
OPENAI_CHAT_MODEL=MiniMax-M2.5

# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o

# Azure OpenAI
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
OPENAI_CHAT_MODEL=gpt-4o

# 自定义 API
OPENAI_BASE_URL=https://your-api.example.com/v1
OPENAI_CHAT_MODEL=your-model-name
```

**关键点**：
- `OPENAI_BASE_URL` 会自动去除末尾的 `/`
- 所有请求使用 `Bearer` 认证
- POST `/chat/completions` 用于聊天
- POST `/embeddings` 用于向量计算

#### 匹配度算法

**公式**：
```
整体匹配度 = 关键词匹配 × 40% + 语义相似度 × 60%
```

**关键词匹配**：
- 在职位描述中查找预定义关键词列表
- 计算匹配比例 (0-100)
- 对职位标题做额外加成（如包含 "product" 且经验有 "product"）

**语义相似度**：
- 使用 `text-embedding-3-small` 生成向量
- 使用余弦相似度计算 (0-1)
- 映射到 0-100 分

**关键词列表**：
python, javascript, node.js, node, react, tensorflow, pytorch, sql, postgresql, aws, docker, kubernetes, agile, scrum, kanban, product, product management, data analysis, machine learning, ml, nlp, natural language processing, computer vision

### 求职信生成

**生成逻辑**：
- 系统提示：职业教练角色
- 用户提示包含：
  - 职位名称和公司
  - 岗位关键信息（JD）
  - 简历亮点（摘要 + 核心技能）
  - 匹配度分数
  - 公司调研信息（如有）
- 要求：中文、3-5 段、<400 字、强调 AI、产品思维、跨职能沟通

**示例输出风格**：
```
尊敬的招聘经理：

您好！我对贵公司 [职位名称] 深感兴趣。作为一名拥有 [X 年] 经验的 [专业领域] 专家...

在 [公司名称] 担任 [当前职位] 期间，我成功...

我的核心技能包括：[技能 1]、[技能 2]、[技能 3]...

我相信我的 [特定优势] 与贵职位的要求高度匹配...

诚挚的，
[姓名]
```

### 常见任务示例

#### 场景 1: 首次部署

```bash
# 1. 克隆项目
git clone <repo>
cd job-hunter

# 2. 安装依赖
npm install

# 3. 配置环境
cp .env.example .env
# 编辑 .env，填入 API Key 等

# 4. 启动服务
npm start

# 5. 添加简历（通过数据库或管理面板 API）
# 6. 上传/导入职位数据
# 7. 运行分析
# 8. 查看结果
```

#### 场景 2: 日常使用

```bash
# 1. 启动服务
npm start

# 2. 等待分析完成（或手动触发）
curl -X POST "http://localhost:3001/admin/run?token=job-hunter-admin-2026"

# 3. 访问 http://localhost:3001/jobs 浏览职位
# 4. 在详情页查看匹配度和求职信
```

#### 场景 3: 数据更新

```bash
# 方式 A: 爬取新职位
npm run scrape:apsjobs -- --keywords "AI,数据分析" --maxPages 5

# 方式 B: 上传 JSON
curl -X POST http://localhost:3001/admin/upload \
  -H "Content-Type: application/json" \
  -d @new-jobs.json

# 方式 C: 重新运行分析
# 在管理面板点击按钮或调用 API
```

## API 参考

### 职位相关

**GET /jobs** - 职位列表
- 查询参数：
  - `role`: 角色筛选
  - `source`: 来源筛选
  - `minScore`: 最低匹配度
- 返回：渲染的 HTML 页面

**GET /jobs/:id** - 职位详情
- 返回：渲染的 HTML 页面
- 包含：职位信息、匹配度、求职信、公司信息

### 管理相关

**GET /admin** - 管理面板
- 认证：`?token=` 或 `Authorization: Bearer <token>`
- 返回：渲染的 HTML 页面
- 包含：统计信息、运行状态、上传表单

**POST /admin/run** - 触发分析
- 认证：同上
- 请求体：任意（可为空）
- 返回：`{ runId: <id> }`
- 异步执行，可在管理面板查看进度

**POST /admin/upload** - 上传职位
- 认证：同上
- 请求体：职位对象数组或 `{ jobs: [...] }`
- 返回：`{ inserted: <count> }`
- 字段映射见代码中的 `mapped` 对象

## 开发与扩展

### 添加新字段

1. 修改迁移文件 `src/db/migrations/xxx_add_field.sql`
2. 更新相关 repo 文件
3. 更新服务层
4. 更新视图模板
5. 运行迁移（重启服务自动执行）

### 自定义评分算法

编辑 `src/services/scoringService.js`：

```javascript
// 调整权重
const KEYWORD_WEIGHT = 0.4;
const EMBEDDING_WEIGHT = 0.6;

// 添加自定义关键词
const KNOWN_KEYWORDS = [...your_keywords];

// 修改评分逻辑
function scoreJobAgainstResume(job, resume) {
  // 自定义实现
}
```

### 添加新爬虫

1. 在 `src/scrapers/` 创建新文件
2. 实现 `main()` 或导出函数
3. 在 `package.json` 添加 npm script
4. 参考 `apsjobsScraper.js` 的模式

### 前端自定义

**CSS**: 编辑 `public/css/main.css`
- 主题颜色在 `:root` 中定义
- 卡片样式：`.glass-card`
- 按钮样式：`.btn`

**JavaScript**: 编辑 `public/js/main.js` 或 `admin.js`
- Tab 切换逻辑已封装
- 评分颜色分类函数可用

### 数据库操作

使用内置的 repo 函数：

```javascript
const { getJobById, getJobsWithScore } = require('./src/repositories/jobsRepo');
const { insertManyJobs } = require('./src/repositories/jobsRepo');

// 查询
const jobs = getJobsWithScore({ role: 'AI Engineer', minScore: 70 });

// 插入
insertManyJobs([...jobObjects]);
```

**直接操作**：

```javascript
const { getDb } = require('./src/db/connection');
const db = getDb();

const result = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
```

## 故障排除

### 常见问题

**Q: 求职信显示"未配置 OpenAI API"**
- 检查 `.env` 中的 `OPENAI_API_KEY`
- 确认 API Key 有效且有额度
- 检查 `OPENAI_BASE_URL` 是否可访问

**Q: 匹配度始终为 0 或未计算**
- 运行管理面板的"运行分析"
- 检查是否有简历数据
- 检查 `.env` 中的 API 配置

**Q: 爬虫无法获取数据**
- APSJobs 网站结构可能已变化
- 检查网络连接和防火墙
- 尝试减少 `--maxPages` 参数
- 手动访问目标网站确认可用性

**Q: 数据库错误**
- 检查 `data/` 目录权限
- 确认 `better-sqlite3` 安装成功
- 如需迁移：删除旧的 `.sqlite` 文件并重启

**Q: 端口被占用**
- 修改 `.env` 中的 `PORT`
- 或使用 `kill -9 $(lsof -t -i:3001)` 终止进程

### 调试技巧

1. **查看日志**：
   ```bash
   npm start 2>&1 | tee app.log
   ```

2. **检查数据库**：
   ```bash
   sqlite3 data/job-hunter.sqlite
   sqlite> SELECT COUNT(*) FROM jobs;
   sqlite> SELECT * FROM job_fit_scores LIMIT 5;
   ```

3. **测试 API**：
   ```bash
   curl http://localhost:3001/jobs
   curl http://localhost:3001/admin?token=job-hunter-admin-2026
   ```

4. **验证环境变量**：
   ```bash
   node -e "console.log(process.env.OPENAI_API_KEY ? 'OK' : 'MISSING')"
   ```

### 性能优化

- **数据库索引**：已创建（见迁移文件）
- **批量插入**：使用 `db.transaction()`（已在爬虫中使用）
- **异步分析**：使用 `setImmediate` 后台执行
- **缓存思考**：可在 `openAIClient.js` 添加响应缓存

## 部署建议

### 生产环境配置

```bash
# .env.production
PORT=80
DB_PATH=/var/lib/job-hunter/db.sqlite
OPENAI_API_KEY=<secure-key>
ADMIN_TOKEN=<random-secure-token>
```

### 使用 PM2

```bash
npm install -g pm2
pm2 start src/server.js --name job-hunter --env production
pm2 save
```

### Docker（推荐）

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p data
EXPOSE 3001
CMD ["npm", "start"]
```

### 安全提示

- **更改 ADMIN_TOKEN**：使用强随机字符串
- **HTTPS**：生产环境必用
- **防火墙**：仅暴露必要端口
- **API Key**：不要提交到版本控制
- **数据备份**：定期备份 `data/` 目录

## 贡献与扩展

这个项目仍在积极开发中。欢迎通过以下方式贡献：

- 反馈使用体验
- 报告 bug
- 提交新的爬虫适配器
- 改进 UI/UX
- 优化匹配算法

## 许可证

MIT License - 详见 LICENSE 文件（如有）

---

**注意**：这是一个实验性项目，用于学习和演示目的。生产环境使用前请充分测试并根据需求调整安全性配置。

## 联系与支持

如有问题，请查看：
- 项目代码注释
- 管理面板中的提示信息
- 浏览器开发者工具控制台
- 服务器日志输出
