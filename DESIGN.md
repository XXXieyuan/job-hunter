# UI/UX Design

## User Flows

### Flow 1: First-time Setup
1. User visits `/` → Landing page (if no primary resume: prominent upload prompt)
2. User clicks "上传简历" → Upload modal
3. File uploaded, parsed → Skills preview shown → User confirms → Set as primary
4. User lands on Dashboard

### Flow 2: Job Scraping
1. User on Dashboard or Scraper page → Selects source (SEEK/LinkedIn/APSJobs)
2. Enters keywords (e.g., "AI, machine learning, data science")
3. Sets max pages
4. Clicks "开始抓取" → Button changes to progress bar
5. SSE streams progress: "正在抓第 3 页... 已找到 47 个职位"
6. Done → Jobs appear in list, toast notification

### Flow 3: Job Matching
1. User on Job List → Sees jobs with "未分析" badge
2. Clicks "分析匹配" (batch or per-job)
3. If no API key → Warning modal, falls back to keyword matching
4. Progress shown inline per job
5. Match scores appear as colored badges (green 70-100, yellow 40-69, red 0-39)

### Flow 4: Cover Letter Generation
1. User on Job Detail → Sees "生成 Cover Letter" button
2. Selects language (EN / 中文)
3. Clicks generate → Loading state (1-3 seconds)
4. CL appears in text area
5. User can: Copy / Download as .txt / Regenerate

### Flow 5: Job Management
1. Job List shows cards with score badge
2. User filters: source / score range / keyword
3. Clicks job card → Job Detail
4. Marks as "已申请" → Card updates

---

## Page Layouts (ASCII Wireframes)

### Page 1: Landing / Dashboard (`/`)
```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 Job Hunter          [职位列表] [简历] [抓取] [Admin]  [⚙️]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  👋 欢迎回来, Andy!                                       │  │
│  │  📊 今天为你找到 12 个新职位，3 个高匹配度职位              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │  🔍 快速抓取  │ │  📄 上传简历 │ │  🎯 查看匹配  │ │  📝 生成CL  │  │
│  │  开始搜索    │ │  更新简历    │ │  分析所有职位 │ │  一键生成   │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
│                                                                 │
│  ── 最近职位 ─────────────────────────────────────────────────  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [APS] AI Engineer @ CSIRO          匹配度 82 🟢  [查看] │   │
│  │ Senior Data Scientist @ Atlassian   匹配度 75 🟡  [查看] │   │
│  │ ML Engineer @ Canva                匹配度 68 🟡  [查看]  │   │
│  │ [SEEK] Data Analyst @ Commonwealth 匹配度 55 🟡  [查看] │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ── 抓取来源 ─────────────────────────────────────────────────  │
│  🔵 SEEK: 234 职位  │ 🔷 LinkedIn: 89  │ 🟢 APSJobs: 12  │ [抓取+]│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Page 2: Job List (`/jobs`)
```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 Job Hunter          [职位列表✓] [简历] [抓取] [Admin]  [⚙️] │
├───────────────┬─────────────────────────────────────────────────┤
│  筛选          │  职位列表                              [抓取新职位]│
│               │  共 335 个职位                              │
│  来源:         │  排序: [匹配度▼] [日期] [公司]              │
│  ☑ SEEK (234) │  ┌───────────────────────────────────────────┐│
│  ☑ LinkedIn   │  │ [APS] Senior AI Engineer                  ││
│    (89)       │  │ CSIRO · Canberra · $130k-$160k            ││
│  ☑ APSJobs    │  │ 匹配度 82 🟢 技能 85 | 语义 79 | 关键词 81 ││
│    (12)       │  │ Posted: 2 days ago  [查看详情] [生成CL]    ││
│               │  └───────────────────────────────────────────┘│
│  匹配度:       │  ┌───────────────────────────────────────────┐│
│  [────●────]  │  │ Data Scientist (NLP)                      ││
│  40 - 100     │  │ Canva · Sydney · $140k-$180k               ││
│               │  │ 匹配度 78 🟡 技能 80 | 语义 75 | 关键词 72  ││
│  关键词:       │  │ Posted: 5 days ago  [查看详情] [生成CL]    ││
│  [________]   │  └───────────────────────────────────────────┘│
│               │                                                 │
│  状态:         │  ┌─ 分页 ─────────────────────────────┐       │
│  ○ 全部        │  │  ◀ 上一页  [1] [2] [3] ... [34]  下一页 ▶ ││
│  ○ 未读        │  └────────────────────────────────────────────┘│
│  ○ 已申请      │                                                 │
└───────────────┴─────────────────────────────────────────────────┘
```

### Page 3: Job Detail (`/jobs/:id`)
```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 Job Hunter          [职位列表] [简历] [抓取] [Admin]  [⚙️] │
├─────────────────────────────────────────────────────────────────┤
│  ← 返回职位列表                                                 │
│                                                                 │
│  ┌──────────────────────────────┬──────────────────────────────┐│
│  │ 职位详情                     │ 匹配分析                      ││
│  │                              │                              ││
│  │ Senior AI Engineer           │ 综合得分 ██████████░░ 82/100  ││
│  │ CSIRO                        │ 🟢 高匹配度                   ││
│  │ Canberra, ACT                │                              ││
│  │ $130,200 - $160,300 + 15.4%  │ 技能匹配   █████████░░ 85    ││
│  │ Full-time · Ongoing           │ 语义匹配   ████████░░░ 79    ││
│  │ Posted: 14 Mar 2026          │ 关键词匹配 ████████░░░ 81    ││
│  │                               │                              ││
│  │ [🔗 原始链接] [⭐ 收藏] [📝 CL]│ ── Gap 分析 ─────────────── ││
│  │                               │ 缺失技能: Transformer, RL   ││
│  │ ── 职位描述 ──────────────    │ 薄弱技能: PyTorch (仅列出)  ││
│  │  About the Role:             │ 强项技能: Python, ML, LLMs  ││
│  │  The CSIRO Data61 is seeking │                              ││
│  │  a Senior AI Engineer to     │ ── Cover Letter ─────────── ││
│  │  lead research in...         │                              ││
│  │  [Read more...]              │ ┌──────────────────────────┐││
│  │                               │ │ Dear Hiring Manager,     │││
│  │ ── 要求 ────────────────     │ │                          │││
│  │  Required:                   │ │ I am writing to express  │││
│  │  • PhD in CS/ML/AI           │ │ my strong interest...    │││
│  │  • 5+ years experience       │ │                          │││
│  │  • Python, PyTorch, TensorFlow│ │ [复制] [下载] [重新生成] │││
│  │  • Publications preferred    │ └──────────────────────────┘││
│  │                               │ [生成英文 CL] [生成中文 CL]  ││
│  │                               │                              ││
│  │                               │ ── 操作 ────────────────── ││
│  │                               │ 状态: [未读 ▼]               ││
│  │                               │ [保存]                       ││
│  └──────────────────────────────┴──────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Page 4: Resume Management (`/resumes`)
```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 Job Hunter          [职位列表] [简历✓] [抓取] [Admin]  [⚙️] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  上传新简历          [拖拽上传 或 点击选择]                       │
│  支持 .docx, .pdf · 最大 5MB                                    │
│                                                                 │
│  ── 我的简历 ─────────────────────────────────────────────────  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ ⭐ 主简历                                                  │ │
│  │ andy_resume_v3.docx                                        │ │
│  │ 解析: 12 技能 · 3 年经验 · 硕士学历                        │ │
│  │ 技能: Python, PyTorch, ML, LLMs, NLP, Docker, ...        │ │
│  │ [查看详情] [取消主简历] [删除]                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 📄 简历 2                                                  │ │
│  │ old_resume.pdf                                             │ │
│  │ 解析: 8 技能 · 2 年经验 · 本科学历                          │ │
│  │ [设为主简历] [查看详情] [删除]                               │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Page 5: Scraper Control (`/scrape`)
```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 Job Hunter          [职位列表] [简历] [抓取✓] [Admin]  [⚙️] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  职位抓取                                                        │
│  ┌──────────────┬──────────────┬──────────────┐               │
│  │ 🔵 SEEK       │ 🔷 LinkedIn  │ 🟢 APSJobs  │               │
│  │ seek.com.au  │ linkedin.com │ apsjobs.gov  │               │
│  │   [抓取]      │   [抓取]      │   [抓取]     │               │
│  └──────────────┴──────────────┴──────────────┘               │
│                                                                 │
│  ── 抓取配置 ─────────────────────────────────────────────────  │
│  关键词: [AI, machine learning, NLP, data science, Python______] │
│  最大页数: [10__]                                               │
│  [🔍 开始抓取]                                                   │
│                                                                 │
│  ── 抓取历史 ─────────────────────────────────────────────────  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 🔵 SEEK · AI/ML/DS · 10页                                  │ │
│  │ ✅ 成功 · 127 个新职位 · 耗时 3m22s                         │ │
│  │ 14:30 今天                                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ 🟢 APSJobs · AI · 5页                                      │ │
│  │ ⚠️ 部分成功 · 8 个职位 (2个被屏蔽) · 耗时 1m05s             │ │
│  │ 昨天 18:22                                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Page 6: Admin Dashboard (`/admin`)
```
┌─────────────────────────────────────────────────────────────────┐
│  🏠 Job Hunter          [职位列表] [简历] [抓取] [Admin✓] [⚙️] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  系统统计                                                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ 335        │ │ 2          │ │ 189        │ │ 47         │  │
│  │ 职位总数   │ │ 简历       │ │ 已分析     │ │ CL生成数   │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
│                                                                 │
│  ── 按来源分布 ────────────────────────────────────────────── │
│  ████████████████████████████████ SEEK: 234                    │
│  ████████████ LinkedIn: 89                                      │
│  ██ APSJobs: 12                                                  │
│                                                                 │
│  ── API 配置 ───────────────────────────────────────────────── │
│  OpenAI Base URL: [https://api.openai.com/v1________________]    │
│  API Key:        [••••••••••••••••••••____________________]    │
│  [保存配置]  (配置保存在环境变量，重启生效)                      │
│                                                                 │
│  ── 系统日志 ───────────────────────────────────────────────── │
│  [全部] [Info] [Warn] [Error]  显示最近 50 条                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ ℹ️ 14:32 | SCRAPE_DONE | SEEK 抓取完成, 127 个职位          │ │
│  │ ℹ️ 14:30 | SCRAPE_START | SEEK 开始, 关键词: AI/ML          │ │
│  │ ⚠️ 13:11 | MATCH_SKIP | 职位 #89 已有分析结果, 跳过         │ │
│  │ ❌ 12:05 | SCRAPE_ERROR | LinkedIn 页面被屏蔽 (retry later) │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Tree

```
App
├── Header (fixed top)
│   ├── Logo (links to /)
│   ├── Nav (jobs / resumes / scrape / admin)
│   └── Settings button
├── Main Content
│   ├── HomePage
│   │   ├── WelcomeCard
│   │   ├── QuickActionsGrid (4 cards)
│   │   ├── RecentJobsList
│   │   └── SourceStatsBar
│   ├── JobListPage
│   │   ├── FilterSidebar
│   │   │   ├── SourceFilter (checkbox group)
│   │   │   ├── ScoreRangeSlider
│   │   │   ├── KeywordSearch
│   │   │   └── StatusFilter
│   │   ├── JobListHeader (sort + count + scrape button)
│   │   ├── JobCard (repeated)
│   │   │   ├── SourceBadge
│   │   │   ├── Title
│   │   │   ├── CompanyLocation
│   │   │   ├── Salary (if available)
│   │   │   ├── ScoreBadge (color-coded)
│   │   │   └── MatchBreakdown
│   │   └── Pagination
│   ├── JobDetailPage
│   │   ├── BackButton
│   │   ├── JobHeader
│   │   ├── JobDescription (expandable)
│   │   ├── JobRequirements
│   │   ├── MatchPanel
│   │   │   ├── ScoreGauge
│   │   │   ├── ScoreBar × 3 (skill/semantic/keyword)
│   │   │   ├── GapAnalysis
│   │   │   └── CoverLetterSection
│   │   │       ├── LanguageToggle (EN/中文)
│   │   │       ├── CLTextarea
│   │   │       └── CLButtons (copy/download/regenerate)
│   │   └── StatusSelector
│   ├── ResumeListPage
│   │   ├── UploadZone
│   │   ├── ResumeCard (primary badge)
│   │   └── ResumeDetailModal
│   ├── ScrapePage
│   │   ├── SourceCards (SEEK / LinkedIn / APSJobs)
│   │   ├── ScrapeConfigForm
│   │   ├── ScrapeButton
│   │   ├── ProgressBar (SSE-driven)
│   │   └── ScrapeHistoryList
│   └── AdminDashboard
│       ├── StatsGrid
│       ├── SourceDistributionChart (CSS bar chart)
│       ├── ApiConfigForm
│       └── LogViewer
└── Footer
```

---

## State Management Strategy

| State | Where | How |
|-------|-------|-----|
| Primary resume | Global (req.locals) | Middleware loads from DB, available in all templates |
| Job list + filters | Server-side | URL params → SQL query → EJS renders |
| Job detail + match | Server-side | Loaded per request, no client state |
| Scrape progress | Client-side SSE | `scrape.js` EventSource listens, updates progress bar |
| Match progress | Server-side | Per-job status update via fetch polling |
| CL content | Server-side | POST to generate, GET to load history |
| UI filters | URL params | Sync to URL so shareable/bookmarkable |

No client-side state management library needed. URL + server-rendered pages.

---

## Design Tokens

### Colors
```css
--color-bg: #0a0e1a;          /* Deep dark navy */
--color-surface: #111827;       /* Card backgrounds */
--color-surface-2: #1f2937;    /* Elevated surfaces */
--color-border: #374151;        /* Borders */
--color-text: #f9fafb;          /* Primary text */
--color-text-muted: #9ca3af;   /* Secondary text */
--color-primary: #6366f1;       /* Indigo — main accent */
--color-primary-hover: #818cf8;
--color-success: #10b981;      /* Green — high match */
--color-warning: #f59e0b;       /* Yellow — medium match */
--color-danger: #ef4444;        /* Red — low match / error */
--color-seek: #254a7c;          /* SEEK brand */
--color-linkedin: #0a66c2;      /* LinkedIn brand */
--color-aps: #2e7d32;           /* APS brand */
--color-particle: #6366f1;      /* Particle effect color */
```

### Typography
```css
--font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
--text-xs: 0.75rem;   /* 12px — labels, badges */
--text-sm: 0.875rem;  /* 14px — secondary text */
--text-base: 1rem;    /* 16px — body */
--text-lg: 1.125rem; /* 18px — section headers */
--text-xl: 1.25rem;  /* 20px — page titles */
--text-2xl: 1.5rem;  /* 24px — hero text */
--text-3xl: 1.875rem; /* 30px — welcome card */
```

### Spacing
```css
--space-1: 0.25rem;  /* 4px */
--space-2: 0.5rem;   /* 8px */
--space-3: 0.75rem;  /* 12px */
--space-4: 1rem;     /* 16px */
--space-6: 1.5rem;   /* 24px */
--space-8: 2rem;     /* 32px */
--space-12: 3rem;    /* 48px */
```

### Border Radius
```css
--radius-sm: 0.375rem;  /* 6px — badges */
--radius-md: 0.5rem;    /* 8px — buttons, inputs */
--radius-lg: 0.75rem;   /* 12px — cards */
--radius-xl: 1rem;      /* 16px — modals */
```

---

## Responsive Breakpoints

| Breakpoint | Width | Changes |
|-----------|-------|---------|
| Mobile | < 640px | Single column, filter sidebar becomes dropdown, job cards stack |
| Tablet | 640-1024px | 2-column grid, sidebar visible but collapsible |
| Desktop | > 1024px | Full layout, sidebar always visible, 2-column job detail |

---

## Interaction States

### JobCard
- **Default**: Dark surface, subtle border
- **Hover**: Border glow (box-shadow with primary color), slight translateY(-2px)
- **Loading**: Shimmer skeleton
- **Empty**: "暂无职位" with upload prompt

### Button (primary)
- **Default**: Primary gradient background, white text
- **Hover**: Brighter gradient, scale(1.02)
- **Active**: scale(0.98), darker
- **Loading**: Spinner icon, disabled, opacity 0.7
- **Disabled**: Gray, no hover effect

### Score Badge
- **0-39**: Red background, "低匹配"
- **40-69**: Yellow/amber background, "中匹配"
- **70-100**: Green background, "高匹配"
- **Unanalyzed**: Gray, "未分析"

### Filter Checkbox
- **Unchecked**: Border only
- **Checked**: Primary color fill + checkmark
- **Hover**: Border glow

### Progress Bar (Scrape)
- **Idle**: Empty, gray background
- **Active**: Animated gradient fill (primary → lighter primary), percentage label
- **Done**: Full green, checkmark icon
- **Error**: Full red, error icon

---

## Decision Records

| DR | Decision | Rationale |
|----|----------|-----------|
| DR-1 | Dark theme by default | Andy likes "fancy" UIs; dark is modern and reduces eye strain |
| DR-2 | Fixed header nav | Easy navigation for small app, always accessible |
| DR-3 | 2-column job detail (description + match side-by-side) | Allows reading JD while seeing match analysis |
| DR-4 | Filter sidebar on desktop, collapsible on mobile | Desktop users filter heavily; mobile gets dropdown |
| DR-5 | CSS-only charts (no chart library) | Lightweight, sufficient for simple stats |
| DR-6 | Particle/animation effects via CSS only | Andy loves fancy effects; CSS animations are performant |

## TL;DR

深色主题 + Indigo 主色调，固定顶部导航栏。职位列表左侧筛选栏 + 右侧卡片列表。职位详情双栏布局（JD + 匹配分析 + CL）。简历管理拖拽上传。抓取页实时进度条（SSE）。管理面板简单统计 + 日志。所有页面响应式，移动端降级为单栏。
