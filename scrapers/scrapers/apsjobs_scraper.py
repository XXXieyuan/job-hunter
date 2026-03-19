#!/usr/bin/env python
"""
APSJobs scraper using Playwright for JavaScript-rendered SPA.
APSJobs migrated to new URL in 2025. Must use browser automation.
"""
import re
import sys
import traceback

from .base_scraper import BaseScraper, main


def _clean(text):
    """Strip HTML tags and normalize whitespace."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


class APSJobsScraper(BaseScraper):
    BASE_URL = "https://www.apsjobs.gov.au"
    SEARCH_URL = BASE_URL + "/s/job-search"  # New URL (2025), not /s/search-jobs

    def build_url(self, page_number):
        keyword = self.keywords.replace(",", " ").strip()
        # APSJobs uses /s/job-search with keyword + page params
        return f"{self.SEARCH_URL}?keywords={keyword}&page={page_number}"

    def _try_build_form_url(self, keyword, page_number):
        """Try form-style URL (keyword as query param)."""
        keyword_enc = keyword.replace(",", " ").strip()
        return f"{self.SEARCH_URL}?keywords={keyword_enc}&page={page_number}"

    def extract_jobs_from_page(self, page):
        """
        Extract job links from the rendered DOM.
        APSJobs uses <article> elements and <a href="/job/..."> links.
        """
        jobs = []

        # Strategy 1: find all links with /job/ in href
        job_links = page.query_selector_all("a[href*='/job/'], a[href*='/jobs/']")

        seen_urls = set()
        for link_el in job_links:
            try:
                href = (link_el.get_attribute("href") or "").strip()
                if not href or href in seen_urls:
                    continue
                seen_urls.add(href)

                # Build full URL
                if href.startswith("http"):
                    url = href
                else:
                    url = self.BASE_URL.rstrip("/") + "/" + href.lstrip("/")

                # Skip non-job URLs
                if any(skip in url for skip in ["privacy", "terms", "accessibility",
                                                  "sitemap", "contact", "faq", "about",
                                                  "gazette", "register", "sign-in",
                                                  "career-pathways", "related-sites"]):
                    continue

                # Get title - use the link text or nearby heading
                title = (link_el.text_content() or "").strip()
                if not title or len(title) < 5:
                    # Try getting heading inside parent article
                    try:
                        parent = link_el.query_selector("h1, h2, h3, h4")
                        if parent:
                            title = (parent.text_content() or "").strip()
                    except Exception:
                        pass

                if not title or len(title) < 5:
                    continue

                # Get parent article/card for metadata
                card = link_el
                try:
                    for _ in range(3):
                        parent = card.evaluate("el => el.parentElement")
                        if parent and parent.tag_name in ["ARTICLE", "DIV", "LI"]:
                            card = parent
                            break
                except Exception:
                    pass

                card_html = ""
                try:
                    card_html = card.inner_html() if card else ""
                except Exception:
                    pass

                # Extract metadata from card context
                card_text = card_html

                # Reference number
                ref_match = re.search(
                    r"(?:Reference|Job Ref|ref)[:\s#]*([A-Z0-9\-]{4,30})",
                    card_text,
                    re.IGNORECASE,
                )
                ref = (ref_match.group(1).strip() if ref_match else
                       re.search(r"/job/([A-Za-z0-9\-]+)/?$", url).group(1)
                       if re.search(r"/job/([A-Za-z0-9\-]+)/?$", url) else "unknown")
                external_id = f"aps-{ref[:30]}"

                # Classification
                classification = ""
                class_match = re.search(
                    r"\b(APS Level [0-9]|EL[0-9]|SES[0-9]|Executive Level [0-9]|"
                    r"Classifications [A-Z][0-9]|[0-9]/[[0-9]])\b",
                    card_text,
                    re.IGNORECASE,
                )
                if class_match:
                    classification = class_match.group(0).strip()

                # Location
                location = ""
                loc_match = re.search(
                    r"\b(ACT|NSW|VIC|QLD|WA|SA|TAS|NT|Australian Capital Territory|"
                    r"New South Wales|Victoria|Queensland|Western Australia|"
                    r"South Australia|Tasmania|Northern Territory)\b",
                    card_text,
                    re.IGNORECASE,
                )
                if loc_match:
                    location = loc_match.group(1).title()

                # Salary
                salary_match = re.search(
                    r"\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?(?:\s*(?:k|K|per annum|p\.a\.|annum))?",
                    card_text,
                )
                salary_text = salary_match.group(0) if salary_match else ""
                salary_min, salary_max = self.parse_salary(salary_text)

                job = {
                    "external_id": external_id,
                    "title": title[:200],
                    "company": "Australian Government",
                    "location": location or None,
                    "salary_min": salary_min,
                    "salary_max": salary_max,
                    "salary_currency": "AUD",
                    "job_description": title,
                    "job_url": url,
                    "posted_date": None,
                    "classification": classification or None,
                }

                if self.validate_job(job):
                    jobs.append(job)

            except Exception:
                continue

        return jobs

    def scrape(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.sse_emit("warning", {
                "message": "Playwright not installed. Run: pip install playwright && python -m playwright install chromium"
            })
            self.sse_emit("done", {"jobsFound": 0, "pages": 0})
            return

        playwright = None
        browser = None
        try:
            playwright = sync_playwright().start()
            browser = playwright.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            page = browser.new_page(viewport={"width": 1280, "height": 800})
        except Exception as e:
            self.sse_emit("warning", {"message": f"Failed to launch browser: {e}"})
            self.sse_emit("done", {"jobsFound": 0, "pages": 0})
            if browser:
                try:
                    browser.close()
                except Exception:
                    pass
            if playwright:
                try:
                    playwright.stop()
                except Exception:
                    pass
            return

        total_found = 0
        pages_scraped = 0
        error_count = 0

        try:
            for page_number in range(1, max(self.max_pages, 1) + 1):
                url = self._try_build_form_url(self.keywords.replace(",", " ").strip(), page_number)
                self.sse_emit("progress", {
                    "page": page_number,
                    "jobsFound": total_found,
                    "message": f"Loading page {page_number}..."
                })

                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                except Exception as e:
                    self.sse_emit("warning", {"message": f"Failed to navigate to page {page_number}: {e}"})
                    error_count += 1
                    if error_count >= 2:
                        break
                    continue

                # If first page with keywords, try submitting search form
                if page_number == 1 and self.keywords:
                    try:
                        # Find and fill the search input
                        search_input = None
                        for selector in [
                            'input[name="Keywords"]',
                            'input[name="keywords"]',
                            'input[id*="keyword"]',
                            'input[placeholder*="Keyword" i]',
                            'input[placeholder*="Search" i]',
                            'input[aria-label*="keyword" i]',
                            'input[aria-label*="Search" i]',
                        ]:
                            inp = page.query_selector(selector)
                            if inp:
                                search_input = inp
                                break

                        if search_input:
                            search_input.fill(self.keywords.replace(",", " ").strip())
                            # Find and click search button
                            for selector in [
                                'button[type="submit"]',
                                'button:has-text("Search")',
                                'input[type="submit"]',
                                'a:has-text("Search")',
                            ]:
                                btn = page.query_selector(selector)
                                if btn:
                                    btn.click()
                                    break
                            page.wait_for_timeout(3000)
                    except Exception as e:
                        self.sse_emit("progress", {
                            "page": page_number,
                            "jobsFound": total_found,
                            "message": f"Form interaction skipped: {e}"
                        })

                # Wait for job results to load
                try:
                    page.wait_for_timeout(3000)
                    page.wait_for_load_state("networkidle", timeout=10000)
                except Exception:
                    pass

                # Try to find job links
                jobs_on_page = self.extract_jobs_from_page(page)
                pages_scraped += 1

                if not jobs_on_page:
                    self.sse_emit("progress", {
                        "page": page_number,
                        "jobsFound": total_found,
                        "message": f"No jobs found on page {page_number}"
                    })
                    # If no jobs and first page, the URL format may be wrong
                    if page_number == 1:
                        self.sse_emit("warning", {
                            "message": "No jobs found. APSJobs may have changed URL format."
                        })
                    break

                for job in jobs_on_page:
                    self.jobs.append(job)
                    total_found += 1
                    self.sse_emit("job_found", {"job": job, "page": page_number})

                self.sse_emit("page_done", {
                    "page": page_number,
                    "total_found": total_found,
                    "message": f"Page {page_number}: found {len(jobs_on_page)} jobs"
                })

                if page_number >= self.max_pages:
                    break

                # Check for next page
                next_btn = page.query_selector(
                    'a:has-text("Next"), button:has-text("Next"), '
                    'a[aria-label="Next"], a[title="Next"]'
                )
                if not next_btn:
                    break

                try:
                    next_btn.click()
                    page.wait_for_timeout(2000)
                    page.wait_for_load_state("domcontentloaded", timeout=15000)
                except Exception:
                    break

        except Exception as e:
            tb = traceback.format_exc()
            self.sse_emit("warning", {"message": f"Scraping error: {e}"})
        finally:
            try:
                browser.close()
            except Exception:
                pass
            try:
                playwright.stop()
            except Exception:
                pass

        self.sse_emit("done", {"jobsFound": len(self.jobs), "pages": pages_scraped})


if __name__ == "__main__":
    sys.exit(main(APSJobsScraper))
