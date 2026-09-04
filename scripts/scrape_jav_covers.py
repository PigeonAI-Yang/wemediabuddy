import os
import re
import sys
import time
import json
import urllib.request
import urllib.error
from pathlib import Path
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed

CACHE_FILE = Path("J:/PigeonYang/WeMediaBuddy/.ai/jav_metadata_cache.json")
PROGRESS_LOG = Path("J:/PigeonYang/WeMediaBuddy/.ai/scraper_progress.log")

hex_hash_pattern = re.compile(r'^[0-9a-fA-F]{24,40}')
resolution_hash_pattern = re.compile(r'^[0-9a-fA-F]{20,40}-\d+p$')

def extract_jav_code(stem):
    if hex_hash_pattern.match(stem) or resolution_hash_pattern.match(stem):
        return None
    if re.match(r'^(?:mp4|vl_mp4|240P|480P|720P|1080P)', stem, re.IGNORECASE):
        return None
        
    m = re.search(r'(FC2[-_]PPV[-_]\d+)', stem, re.IGNORECASE)
    if m:
        return m.group(1).upper().replace('_', '-')
        
    m = re.search(r'([A-Za-z]{2,6}[-_]\d{2,5})', stem)
    if m:
        return m.group(1).upper().replace('_', '-')
        
    m = re.search(r'\b([A-Za-z]{2,5})(\d{3,5})\b', stem)
    if m:
        return f"{m.group(1).upper()}-{m.group(2)}"
        
    m = re.search(r'(\d{3,4}[-_][A-Za-z]+[-_]\d+)', stem)
    if m:
        return m.group(1).upper().replace('_', '-')
        
    return None

def fetch_javbus_metadata(code, retries=2):
    url = f"https://www.javbus.com/{code}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': 'existmag=all; dv=1',
        'Referer': 'https://www.javbus.com/'
    }
    
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=12) as resp:
                html = resp.read().decode('utf-8', errors='ignore')
                soup = BeautifulSoup(html, 'html.parser')
                
                h3 = soup.find('h3')
                if not h3:
                    return None
                title = h3.text.strip()
                
                cover_a = soup.find('a', class_='bigImage')
                cover_url = ""
                if cover_a and 'href' in cover_a.attrs:
                    cover_url = cover_a['href']
                    if cover_url.startswith('/'):
                        cover_url = f"https://www.javbus.com{cover_url}"
                        
                date = ""
                studio = ""
                info_div = soup.select_one('div.col-md-3.info')
                actresses = [a.text.strip() for a in soup.select('div.star-name a')]
                genre_tags = [a.text.strip() for a in soup.select('span.genre a')]
                
                if info_div:
                    for p in info_div.find_all('p'):
                        text = p.text
                        if '發行日期:' in text or '发行日期:' in text:
                            date = text.split(':')[-1].strip()
                        elif '製作商:' in text or '制作商:' in text or '發行商:' in text or '发行商:' in text:
                            if not studio:
                                studio = text.split(':')[-1].strip()
                                
                return {
                    "code": code,
                    "title": title,
                    "date": date,
                    "year": date.split('-')[0] if '-' in date else "",
                    "studio": studio,
                    "actresses": actresses,
                    "genres": genre_tags,
                    "cover_url": cover_url
                }
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(1)
        except Exception:
            time.sleep(1)
            
    return None

def download_cover(cover_url, dest_path, retries=2):
    if not cover_url:
        return False
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.javbus.com/'
    }
    for _ in range(retries):
        try:
            req = urllib.request.Request(cover_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                if len(data) > 1024:
                    with open(dest_path, 'wb') as f:
                        f.write(data)
                    return True
        except Exception:
            time.sleep(1)
    return False

def generate_nfo(meta, nfo_path):
    actors_xml = "\n".join([f"    <actor><name>{a}</name></actor>" for a in meta.get("actresses", [])])
    genres_xml = "\n".join([f"    <genre>{g}</genre>" for g in meta.get("genres", [])])
    
    xml = f"""<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
    <title>{meta.get('title', meta['code'])}</title>
    <originaltitle>{meta.get('title', meta['code'])}</originaltitle>
    <sorttitle>{meta['code']}</sorttitle>
    <num>{meta['code']}</num>
    <premiered>{meta.get('date', '')}</premiered>
    <year>{meta.get('year', '')}</year>
    <studio>{meta.get('studio', '')}</studio>
{actors_xml}
{genres_xml}
    <poster>{Path(nfo_path).stem}.jpg</poster>
</movie>
"""
    with open(nfo_path, 'w', encoding='utf-8') as f:
        f.write(xml.strip())

def main():
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    cache = {}
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except Exception:
            pass
            
    p_av = Path("E:/vid/av")
    video_exts = {".mp4", ".ts", ".avi", ".mkv", ".wmv", ".mpg"}
    
    tasks = []
    for root, _, files in os.walk(p_av):
        for f in files:
            fp = Path(root) / f
            if fp.suffix.lower() in video_exts:
                code = extract_jav_code(fp.stem)
                if code:
                    jpg_path = fp.parent / f"{fp.stem}.jpg"
                    nfo_path = fp.parent / f"{fp.stem}.nfo"
                    if not jpg_path.exists() or not nfo_path.exists():
                        tasks.append((code, fp, jpg_path, nfo_path))
                        
    print(f"[{time.strftime('%H:%M:%S')}] Found {len(tasks)} videos needing metadata/covers.")
    
    with open(PROGRESS_LOG, 'w', encoding='utf-8') as log_f:
        log_f.write(f"Started scraping: {time.strftime('%Y-%m-%d %H:%M:%S')} | Total tasks: {len(tasks)}\n")
        
    success_count = 0
    not_found_count = 0
    
    # Process with ThreadPool
    def worker(task):
        code, fp, jpg_path, nfo_path = task
        # Check cache
        meta = cache.get(code)
        if meta is None and code not in cache:
            meta = fetch_javbus_metadata(code)
            cache[code] = meta
            time.sleep(0.4) # polite rate-limit
            
        if not meta:
            return (code, False, "Not found on JavBus", fp)
            
        # Download cover if needed
        if not jpg_path.exists() and meta.get("cover_url"):
            download_cover(meta["cover_url"], jpg_path)
            
        # Write NFO if needed
        if not nfo_path.exists():
            generate_nfo(meta, nfo_path)
            
        return (code, True, meta.get("title", ""), fp)

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(worker, t): t for t in tasks}
        done_count = 0
        for future in as_completed(futures):
            done_count += 1
            code, ok, msg, fp = future.result()
            if ok:
                success_count += 1
            else:
                not_found_count += 1
                
            status_line = f"[{done_count}/{len(tasks)}] {'SUCCESS' if ok else 'MISS'}: {code} -> {msg[:45]}"
            print(status_line)
            
            # Flush cache periodically
            if done_count % 25 == 0:
                with open(CACHE_FILE, 'w', encoding='utf-8') as f:
                    json.dump(cache, f, ensure_ascii=False, indent=2)
                with open(PROGRESS_LOG, 'a', encoding='utf-8') as log_f:
                    log_f.write(f"[{time.strftime('%H:%M:%S')}] Progress: {done_count}/{len(tasks)} | Success: {success_count} | Miss: {not_found_count}\n")

    # Final cache save
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
        
    print(f"\n[{time.strftime('%H:%M:%S')}] Scraping complete!")
    print(f"  Successfully scraped: {success_count}")
    print(f"  Not found / Miss:     {not_found_count}")

if __name__ == "__main__":
    main()
