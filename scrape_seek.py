"""
Seek.com.au scraper using curl_cffi to bypass bot detection via browser TLS impersonation.
Outputs JSON that can be uploaded to the Job Hunter app.

Usage:
    python scrape_seek.py --keywords "data analyst,software engineer" --location "Sydney" --max-pages 2
    python scrape_seek.py --keywords "AI engineer" --location "Canberra" --max-pages 3 --output data/seek-jobs.json
"""

import argparse
import json
import re
import os
import time
from curl_cffi import requests
from bs4 import BeautifulSoup


HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-AU,en;q=0.9",
    "cache-control": "no-cache",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
}


def build_seek_url(keyword, location="", page=1):
    """Build a Seek search URL."""
    keyword_slug = re.sub(r'[^a-z0-9]+', '-', keyword.lower().strip()).strip('-')
    path = f"/{keyword_slug}-jobs" if keyword_slug else "/jobs"
    if location:
        location_slug = re.sub(r'[^a-z0-9]+', '-', location.lower().strip()).strip('-')
        path += f"/in-{location_slug}"
    return f"https://www.seek.com.au{path}?page={page}"


def extract_jobs_from_html(html, keyword):
    """Parse job listings from Seek search results HTML."""
    soup = BeautifulSoup(html, 'html.parser')
    jobs = []

    # Try multiple selectors for job cards
    cards = soup.select('article[data-card-type="JobCard"]')
    if not cards:
        cards = soup.select('[data-automation="normalJob"]')
    if not cards:
        cards = soup.select('[data-automation*="job-card"]')

    # Also try to extract from JSON-LD structured data
    if not cards:
        jobs_from_jsonld = extract_from_jsonld(soup, keyword)
        if jobs_from_jsonld:
            return jobs_from_jsonld

    for card in cards:
        try:
            title_el = (
                card.select_one('a[data-automation="jobTitle"]') or
                card.select_one('h3 a') or
                card.select_one('a[href*="/job/"]')
            )
            title = title_el.get_text(strip=True) if title_el else None
            href = title_el.get('href', '') if title_el else ''
            if href and not href.startswith('http'):
                href = f"https://www.seek.com.au{href}"
            url = href or None

            if not title or not url:
                continue

            job_id_match = re.search(r'/job/(\d+)', url)
            job_id = job_id_match.group(1) if job_id_match else url
            external_id = f"seek-{job_id}"

            company_el = card.select_one('[data-automation="jobCompany"]')
            company = company_el.get_text(strip=True) if company_el else None

            loc_el = card.select_one('[data-automation="jobLocation"]')
            location_text = loc_el.get_text(strip=True) if loc_el else None

            salary_el = card.select_one('[data-automation="jobSalary"]')
            salary = salary_el.get_text(strip=True) if salary_el else None

            desc_el = card.select_one('[data-automation="jobShortDescription"]')
            description = desc_el.get_text(strip=True) if desc_el else None

            date_el = card.select_one('[data-automation="jobListingDate"]')
            posted_at = date_el.get_text(strip=True) if date_el else None

            jobs.append({
                "external_id": external_id,
                "source": "seek",
                "role": keyword,
                "title": title,
                "company_name": company,
                "location": location_text,
                "salary": salary,
                "description": description,
                "url": url,
                "posted_at": posted_at,
            })
        except Exception as e:
            print(f"  [warn] Failed to parse a card: {e}")
            continue

    return jobs


def extract_from_jsonld(soup, keyword):
    """Try to extract jobs from JSON-LD script tags (structured data)."""
    jobs = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.string or '{}')
            if isinstance(data, dict) and data.get('@type') == 'ItemList':
                for item in data.get('itemListElement', []):
                    posting = item if item.get('@type') == 'JobPosting' else item.get('item', {})
                    if posting.get('@type') != 'JobPosting':
                        continue
                    title = posting.get('title', '')
                    url = posting.get('url', '')
                    if not title or not url:
                        continue
                    job_id_match = re.search(r'/job/(\d+)', url)
                    job_id = job_id_match.group(1) if job_id_match else url
                    company = ''
                    org = posting.get('hiringOrganization', {})
                    if isinstance(org, dict):
                        company = org.get('name', '')
                    loc_data = posting.get('jobLocation', {})
                    location_text = ''
                    if isinstance(loc_data, dict):
                        addr = loc_data.get('address', {})
                        if isinstance(addr, dict):
                            parts = [addr.get('addressLocality', ''), addr.get('addressRegion', '')]
                            location_text = ', '.join(p for p in parts if p)
                    jobs.append({
                        "external_id": f"seek-{job_id}",
                        "source": "seek",
                        "role": keyword,
                        "title": title,
                        "company_name": company or None,
                        "location": location_text or None,
                        "salary": None,
                        "description": posting.get('description', '')[:500] if posting.get('description') else None,
                        "url": url,
                        "posted_at": posting.get('datePosted', None),
                    })
        except (json.JSONDecodeError, AttributeError):
            continue
    return jobs


def extract_from_apollo_state(html, keyword):
    """Try to extract jobs from Seek's Apollo/Next.js state embedded in the page."""
    jobs = []
    # Look for __NEXT_DATA__ or Apollo state
    match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not match:
        match = re.search(r'window\.__SEEK_REDUX_DATA__\s*=\s*({.*?});?\s*</script>', html, re.DOTALL)
    if not match:
        return jobs

    try:
        data = json.loads(match.group(1))
        # Navigate the JSON structure to find job listings
        # This varies based on Seek's frontend version
        if 'props' in data and 'pageProps' in data['props']:
            page_props = data['props']['pageProps']
            job_list = page_props.get('jobList', page_props.get('jobs', []))
            if isinstance(job_list, dict):
                job_list = job_list.get('jobs', [])
            for item in job_list:
                title = item.get('title', '')
                job_id = item.get('id', item.get('jobId', ''))
                company = item.get('companyName', item.get('advertiser', {}).get('description', ''))
                location_text = item.get('location', item.get('suburb', ''))
                salary = item.get('salary', item.get('salaryLabel', ''))
                teaser = item.get('teaser', item.get('bulletPoints', ''))
                if isinstance(teaser, list):
                    teaser = '; '.join(teaser)
                url = f"https://www.seek.com.au/job/{job_id}" if job_id else ''
                if title:
                    jobs.append({
                        "external_id": f"seek-{job_id}",
                        "source": "seek",
                        "role": keyword,
                        "title": title,
                        "company_name": company or None,
                        "location": location_text or None,
                        "salary": salary or None,
                        "description": teaser or None,
                        "url": url,
                        "posted_at": item.get('listedAt', item.get('listingDate', None)),
                    })
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        print(f"  [warn] Failed to parse embedded data: {e}")

    return jobs


def scrape_seek(keywords, location="", max_pages=3):
    """Main scraping function using curl_cffi with browser impersonation."""

    print("[*] Starting Seek scraper with browser TLS impersonation...")
    session = requests.Session(impersonate="chrome")

    all_jobs = {}

    for keyword in keywords:
        keyword = keyword.strip()
        if not keyword:
            continue

        print(f"\n[*] Searching: \"{keyword}\" in \"{location or 'All locations'}\"")

        for page in range(1, max_pages + 1):
            url = build_seek_url(keyword, location, page)
            print(f"  [page {page}/{max_pages}] {url}")

            try:
                resp = session.get(url, headers=HEADERS, timeout=30)
                print(f"  [status] HTTP {resp.status_code}")

                if resp.status_code != 200:
                    print(f"  [error] Non-200 response, skipping")
                    continue

                html = resp.text

                # Try multiple extraction strategies
                jobs = extract_jobs_from_html(html, keyword)

                if not jobs:
                    print("  [info] HTML selectors found 0 jobs, trying embedded JSON data...")
                    jobs = extract_from_apollo_state(html, keyword)

                print(f"  [result] Found {len(jobs)} jobs on page {page}")

                for job in jobs:
                    all_jobs[job["external_id"]] = job

                if len(jobs) == 0:
                    print(f"  [info] No jobs found, stopping pagination for \"{keyword}\"")
                    break

                # Be polite
                time.sleep(2)

            except Exception as e:
                print(f"  [error] Request failed: {e}")
                continue

    return list(all_jobs.values())


def main():
    parser = argparse.ArgumentParser(description="Seek.com.au job scraper (anti-bot bypass)")
    parser.add_argument("--keywords", required=True, help="Comma-separated keywords")
    parser.add_argument("--location", default="", help="Location filter, e.g. 'Sydney'")
    parser.add_argument("--max-pages", type=int, default=3, help="Max pages per keyword (default: 3)")
    parser.add_argument("--output", default="data/seek-jobs.json", help="Output JSON file path")
    args = parser.parse_args()

    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    if not keywords:
        print("[error] No valid keywords provided.")
        return

    jobs = scrape_seek(keywords, args.location, args.max_pages)

    print(f"\n{'='*60}")
    print(f"[*] Total unique jobs scraped: {len(jobs)}")

    # Save to JSON
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(jobs, f, indent=2, ensure_ascii=False)
    print(f"[*] Saved to {args.output}")

    if jobs:
        print(f"\n{'Title':<45} {'Company':<20} {'Location'}")
        print(f"{'-'*90}")
        for job in jobs[:15]:
            title = (job['title'] or '')[:43]
            company = (job['company_name'] or 'N/A')[:18]
            loc = (job['location'] or 'N/A')[:20]
            print(f"{title:<45} {company:<20} {loc}")
        if len(jobs) > 15:
            print(f"  ... and {len(jobs) - 15} more")

    print(f"\n[tip] Upload to Job Hunter: curl -X POST \"http://localhost:3001/admin/upload?token=job-hunter-admin-2026\" -H \"Content-Type: application/json\" -d @{args.output}")


if __name__ == "__main__":
    main()
