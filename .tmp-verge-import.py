import json
import os
import re
import shutil
import time
from pathlib import Path

root = Path(os.environ["APPDATA"]) / "io.github.clash-verge-rev.clash-verge-rev"
meta = json.loads((root / "xq_import_meta.json").read_text(encoding="utf-8"))

uid = meta["uid"]
merge_uid = meta["merge_uid"]
script_uid = meta["script_uid"]
rules_uid = meta["rules_uid"]
proxies_uid = meta["proxies_uid"]
groups_uid = meta["groups_uid"]
item = meta["item"]
url = item["url"]
now = int(time.time())
extra = item.get("extra") or {}

profiles_path = root / "profiles.yaml"
backup = root / f"profiles.yaml.bak-{now}"
shutil.copy2(profiles_path, backup)
print("backup", backup)

text = profiles_path.read_text(encoding="utf-8")
if f"uid: {uid}" in text:
    print("remote uid already in profiles.yaml")
else:
    block = f"""
- uid: {merge_uid}
  type: merge
  name: null
  file: {merge_uid}.yaml
  updated: {now}
- uid: {script_uid}
  type: script
  name: null
  file: {script_uid}.js
  updated: {now}
- uid: {rules_uid}
  type: rules
  name: null
  file: {rules_uid}.yaml
  updated: {now}
- uid: {proxies_uid}
  type: proxies
  name: null
  file: {proxies_uid}.yaml
  updated: {now}
- uid: {groups_uid}
  type: groups
  name: null
  file: {groups_uid}.yaml
  updated: {now}
- uid: {uid}
  type: remote
  name: XQ-Network
  file: {uid}.yaml
  url: {url}
  desc: From XQNetwork xboard subscribe
  updated: {now}
  option:
    allow_auto_update: true
    update_interval: 60
    merge: {merge_uid}
    script: {script_uid}
    rules: {rules_uid}
    proxies: {proxies_uid}
    groups: {groups_uid}
  extra:
    upload: {extra.get('upload', 0)}
    download: {extra.get('download', 0)}
    total: {extra.get('total', 0)}
    expire: {extra.get('expire', 0)}
"""
    if not text.endswith("\n"):
        text += "\n"
    profiles_path.write_text(text + block, encoding="utf-8")
    print("appended remote profile", uid)

provider_block = f"""proxy-providers:
  xq-nodes:
    type: http
    url: "{url}"
    interval: 3600
    path: ./xq-provider.yaml
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 600
"""

# Remove chained http proxy to local XQNetwork and replace with provider-backed select group.
proxy_node_re = re.compile(
    r"\n[ \t]*-[ \t]*name:[ \t]*['\"]?XQ-第三方当前线路['\"]?[ \t]*\n"
    r"[ \t]*type:[ \t]*http[ \t]*\n"
    r"[ \t]*server:[ \t]*['\"]?127\.0\.0\.1['\"]?[ \t]*\n"
    r"[ \t]*port:[ \t]*7890[ \t]*\n"
    r"[ \t]*udp:[ \t]*false[ \t]*",
    re.M,
)

group_re = re.compile(
    r"\n[ \t]*-[ \t]*name:[ \t]*['\"]?XQ-第三方当前线路['\"]?[ \t]*\n"
    r"[ \t]*type:[ \t]*select[ \t]*\n"
    r"[ \t]*use:[ \t]*\n"
    r"[ \t]*-[ \t]*xq-nodes[ \t]*",
    re.M,
)

group_block = """
  - name: 'XQ-第三方当前线路'
    type: select
    use:
      - xq-nodes
"""

for yp in (root / "profiles").glob("*.yaml"):
    # skip the newly imported full remote body and helper templates
    if yp.stem in {
        uid,
        merge_uid,
        rules_uid,
        proxies_uid,
        groups_uid,
        "Merge",
        "xq-provider",
    }:
        continue
    t = yp.read_text(encoding="utf-8", errors="replace")
    if "XQ-第三方当前线路" not in t or "7890" not in t:
        continue
    if "127.0.0.1" not in t and "127.0.0.1" not in t.replace("'", ""):
        # still check port chain pattern
        if "server: '127.0.0.1'" not in t and 'server: "127.0.0.1"' not in t and "server: 127.0.0.1" not in t:
            continue

    shutil.copy2(yp, yp.with_suffix(yp.suffix + f".bak-{now}"))
    orig = t
    t2, n = proxy_node_re.subn("\n", t)
    if "proxy-providers:" not in t2:
        if re.search(r"^proxies:\s*$", t2, re.M):
            t2 = re.sub(r"^proxies:\s*$", provider_block.rstrip() + "\nproxies:", t2, count=1, flags=re.M)
        elif re.search(r"^proxies:", t2, re.M):
            t2 = re.sub(r"^proxies:", provider_block.rstrip() + "\nproxies:", t2, count=1, flags=re.M)
        else:
            t2 = provider_block + t2

    if not group_re.search(t2):
        if re.search(r"^proxy-groups:\s*$", t2, re.M):
            t2 = re.sub(
                r"^proxy-groups:\s*$",
                "proxy-groups:" + group_block.rstrip("\n"),
                t2,
                count=1,
                flags=re.M,
            )
        elif "proxy-groups:" in t2:
            t2 = t2.replace("proxy-groups:", "proxy-groups:" + group_block.rstrip("\n"), 1)
        else:
            t2 += "\nproxy-groups:" + group_block

    # Ensure old leaf list no longer points only via removed proxy; group name remains same.
    if t2 != orig:
        yp.write_text(t2, encoding="utf-8")
        print(f"patched {yp.name} removed_http_nodes={n}")
    else:
        print(f"skip no change {yp.name}")

# Also patch runtime clash-verge.yaml if it currently chains to 7890, so effect is immediate.
runtime = root / "clash-verge.yaml"
if runtime.exists():
    rt = runtime.read_text(encoding="utf-8", errors="replace")
    if "XQ-第三方当前线路" in rt and "7890" in rt and "127.0.0.1" in rt:
        shutil.copy2(runtime, root / f"clash-verge.yaml.bak-{now}")
        rt2, n = proxy_node_re.subn("\n", rt)
        if "proxy-providers:" not in rt2:
            if re.search(r"^proxies:\s*$", rt2, re.M):
                rt2 = re.sub(r"^proxies:\s*$", provider_block.rstrip() + "\nproxies:", rt2, count=1, flags=re.M)
            elif re.search(r"^proxies:", rt2, re.M):
                rt2 = re.sub(r"^proxies:", provider_block.rstrip() + "\nproxies:", rt2, count=1, flags=re.M)
            else:
                rt2 = provider_block + rt2
        if not group_re.search(rt2):
            if re.search(r"^proxy-groups:\s*$", rt2, re.M):
                rt2 = re.sub(
                    r"^proxy-groups:\s*$",
                    "proxy-groups:" + group_block.rstrip("\n"),
                    rt2,
                    count=1,
                    flags=re.M,
                )
            elif "proxy-groups:" in rt2:
                rt2 = rt2.replace("proxy-groups:", "proxy-groups:" + group_block.rstrip("\n"), 1)
            else:
                rt2 += "\nproxy-groups:" + group_block
        runtime.write_text(rt2, encoding="utf-8")
        print(f"patched runtime clash-verge.yaml removed_http_nodes={n}")

print("DONE")
