# VISION.md — APSJobs Scraper Rewrite

## Mission
用 curl_cffi 替代 Playwright 爬取 APSJobs，提升速度并减少资源消耗。

## Change Summary
- **What**: 重写 `scrapers/scrapers/apsjobs_scraper.py`
- **How**: 用 curl_cffi 直接调用 Salesforce Aura API（POST `/s/sfsites/aura`），无需启动浏览器
- **Why**: curl_cffi 比 Playwright 快 10x，资源消耗低，无需维护 Chromium
- **Scope**: 仅改 APSJobs scraper；LinkedIn scraper 单独处理

## Tech Details (Research Findings)
- APSJobs 是 Salesforce Lightning SPA，职位数据通过 Aura API 加载
- API 端点: `POST https://www.apsjobs.gov.au/s/sfsites/aura?r=5&aura.ApexAction.execute=1`
- Controller: `aps_jobSearchController.retrieveJobListings`
- 需从主页 HTML 提取 `fwuid` 和 `app_id`（`APPLICATION@markup://siteforce:communityApp`）
- 每页约 15 条，`jobListingCount` 总数，`offset` 分页
- Session 必须先访问主页建立 cookie + fwuid

## LinkedIn URL Check
- 验证 LinkedIn scraper 生成的职位链接是否可访问
- 输出报告：哪些 URL 有效/失效

## Success Metrics
- [x] curl_cffi 能获取职位列表（已验证，返回 24 条 ai 关键词职位）
- [ ] scraper 重写后功能完整（parse title, company, location, salary, url, date, description）
- [ ] LinkedIn URL 检查报告输出
- [ ] Git push
