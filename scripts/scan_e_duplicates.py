import os
import sys
import time
import json
import hashlib
from pathlib import Path

def fast_hash(path, sz, chunk_size=32*1024):
    h = hashlib.md5()
    with open(path, "rb") as f:
        # head
        h.update(f.read(chunk_size))
        # tail
        if sz > chunk_size * 2:
            f.seek(-chunk_size, os.SEEK_END)
            h.update(f.read(chunk_size))
    return h.hexdigest()

def main():
    start_time = time.time()
    vid_root = "E:/vid"
    print(f"[{time.strftime('%H:%M:%S')}] Step 1: Scanning metadata across {vid_root}...")
    
    size_map = {}
    file_count = 0
    
    for root, dirs, files in os.walk(vid_root):
        for f in files:
            file_count += 1
            fp = os.path.join(root, f)
            try:
                sz = os.stat(fp).st_size
                if sz > 1024 * 1024:  # ignore < 1MB
                    size_map.setdefault(sz, []).append(fp)
            except Exception:
                pass
                
    meta_elapsed = time.time() - start_time
    candidates = {sz: paths for sz, paths in size_map.items() if len(paths) > 1}
    cand_files = sum(len(p) for p in candidates.values())
    print(f"[{time.strftime('%H:%M:%S')}] Metadata scan complete in {meta_elapsed:.1f}s.")
    print(f"Total files: {file_count}, Candidate sizes: {len(candidates)}, Candidate files: {cand_files}")
    
    print(f"[{time.strftime('%H:%M:%S')}] Step 2: Hashing candidate files...")
    hash_start = time.time()
    confirmed_groups = []
    total_reclaimable = 0
    
    processed_groups = 0
    for sz, paths in candidates.items():
        processed_groups += 1
        hashes = {}
        for p in paths:
            try:
                h = fast_hash(p, sz)
                hashes.setdefault(h, []).append(p)
            except Exception:
                pass
                
        for h, group in hashes.items():
            if len(group) > 1:
                confirmed_groups.append({
                    "size_bytes": sz,
                    "size_mb": round(sz / (1024 * 1024), 2),
                    "hash": h,
                    "files": group
                })
                total_reclaimable += sz * (len(group) - 1)
                
    hash_elapsed = time.time() - hash_start
    print(f"[{time.strftime('%H:%M:%S')}] Hashing complete in {hash_elapsed:.1f}s.")
    
    # Sort duplicate groups by size descending
    confirmed_groups.sort(key=lambda x: x["size_bytes"], reverse=True)
    
    redundant_copies = sum(len(g["files"]) - 1 for g in confirmed_groups)
    
    report = {
        "scan_time": time.strftime('%Y-%m-%d %H:%M:%S'),
        "total_files_scanned": file_count,
        "candidate_groups": len(candidates),
        "duplicate_groups": len(confirmed_groups),
        "redundant_copies": redundant_copies,
        "reclaimable_bytes": total_reclaimable,
        "reclaimable_gb": round(total_reclaimable / (1024**3), 2),
        "reclaimable_mb": round(total_reclaimable / (1024**2), 1),
        "groups": confirmed_groups
    }
    
    out_dir = Path("J:/PigeonYang/WeMediaBuddy/.ai")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "duplicate_scan_report.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        
    print(f"\n================ DUPLICATE SCAN SUMMARY ================")
    print(f"Duplicate Groups:        {len(confirmed_groups)}")
    print(f"Redundant Files:         {redundant_copies} files")
    print(f"Total Reclaimable Space: {report['reclaimable_gb']} GB ({report['reclaimable_mb']} MB)")
    print(f"Report saved to:         {out_file}")
    print(f"========================================================\n")
    
    print("Top 15 Largest Duplicate Groups:")
    for i, g in enumerate(confirmed_groups[:15], 1):
        print(f"\n[{i}] Size: {g['size_mb']} MB ({len(g['files'])} copies, wasting {round(g['size_mb'] * (len(g['files']) - 1), 1)} MB):")
        for f in g["files"]:
            print(f"    - {f}")

if __name__ == "__main__":
    main()
