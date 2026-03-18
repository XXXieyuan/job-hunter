# LinkedIn Scraper Plan (Final)

## 概述

基于用户需求和现有 APS/Seek 爬虫模式，创建 LinkedIn 职位爬虫。

---

## 用户需求

| # | 需求 |
|---|------|
| 1 | 使用 Playwright (非 Puppeteer) - 与 APS/Seek 一致 |
| 2 | 浏览器模拟 - 等待 JS 渲染完成后抓取 |
| 3 | 输出 [PROGRESS] JSON 事件 |
| 4 | 存储到 DB，url 唯一键，source="linkedin" |
| 5 | 无需 LLM - 直接从搜索结果提取薪资 |
| 6 | 更新 scraperService.js 支持 source="linkedin" |

---

## 数据字段

| 字段 | 来源 | 可用 |
|------|------|------|
| title | 搜索结果 | ✅ |
| company | 搜索结果 | ✅ |
| location | 搜索结果 | ✅ |
| posted_date | 搜索结果 | ✅ |
| salary | 搜索结果 | ✅ (部分) |
| job_level | 搜索结果 | ✅ |
| url | 搜索结果 | ✅ |

---

## 实现策略

### 1. 技术栈
- Playwright (与 APS/Seek 一致)
- Chromium 浏览器
- Stealth 模式避免检测

### 2. 页面加载
- 等待 JS 渲染 (waitForSelector)
- 无限滚动加载 (与 Seek 类似)

### 3. URL 结构
```
https://www.linkedin.com/jobs/search/?keywords={keyword}&location={location}
```

### 4. Selectors
```javascript
// Job card
'.job-card-container'

// Title
'.job-card-list__title'

// Company
'.job-card-container__company-name'

// Location
'.job-card-container__metadata-item'

// Salary (optional)
'.job-card-container__salary-info'
// 或正则匹配: /A\$\d+,\d+/

// Posted date
'.job-card-container__listed-time'

// URL
'a.job-card-list__cta'
```

---

## 实现步骤

### Step 1: 创建 linkedinScraper.js
- CLI 参数: --keywords, --location, --maxPages, --mode, --output
- Playwright 启动
- URL 构建函数
- Job 提取函数

### Step 2: [PROGRESS] 事件
```json
[PROGRESS] {"type":"searching","message":"Searching LinkedIn for python in Sydney","count":0}
[PROGRESS] {"type":"found","count":241,"message":"Found 241 jobs"}
[PROGRESS] {"type":"processing","current":1,"total":50,"title":"Python Developer at Infosys","salary":"A$130k-A$150k"}
[PROGRESS] {"type":"completed","jobs_added":45}
```

### Step 3: DB 存储
- source: "linkedin"
- url: 唯一键 (去重)
- INSERT OR REPLACE 模式

### Step 4: 集成 scraperService.js
- 添加 "linkedin" 到 validSources
- 支持 source 参数传递

---

## 反爬策略

| 策略 | 实现 |
|------|------|
| Stealth 模式 | Playwright 默认 |
| 延迟 | 2-3 秒/请求 |
| 重试 | 3次 + 随机延迟 |
| User-Agent | 真实浏览器 UA |

---

## 测试

```bash
# JSON 模式
node src/scrapers/linkedinScraper.js --keywords="python" --location="Sydney" --maxPages=1 --mode=json

# DB 模式
node src/scrapers/linkedinScraper.js --keywords="python" --location="Sydney" --maxPages=1 --mode=db

# API
curl -X POST http://localhost:3001/api/scrape/run \
  -H "Content-Type: application/json" \
  -d '{"source":"linkedin","keywords":"python,developer","location":"Sydney","maxPages":2}'
```

---

## 成本

**$0** - 无需 LLM

---

## 文件变更

| 文件 | 动作 |
|------|------|
| src/scrapers/linkedinScraper.js | 新建 |
| src/services/scraperService.js | 修改 (添加 linkedin) |

---

## Approve 后实现
