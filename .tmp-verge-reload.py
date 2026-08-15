import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

root = Path(os.environ["APPDATA"]) / "io.github.clash-verge-rev.clash-verge-rev"
url = "https://106.75.251.92/myhuaweicloud/51bbf2?token=8f13aead36e5cd95a99749f09dd7ca96"

# provider path in runtime config is ./xq-provider.yaml relative to -d home
provider_path = root / "xq-provider.yaml"
req = urllib.request.Request(url, headers={"User-Agent": "clash-verge/v2.5.2"})
with urllib.request.urlopen(req, timeout=20) as r:
    data = r.read()
provider_path.write_bytes(data)
print("provider_bytes", len(data), "path", provider_path)
text = data.decode("utf-8", "replace")
assert "proxies:" in text
print("provider_ok")

# Restart verge-mihomo by restarting Clash Verge app gently:
# 1) find clash-verge.exe path
# 2) stop only verge-mihomo first? Better restart whole app so UI reloads profiles.yaml

ps = r"""
$ErrorActionPreference='SilentlyContinue'
$cv = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'clash-verge.exe' } | Select-Object -First 1
if (-not $cv) { Write-Host 'NO_CLASH_VERGE'; exit 2 }
$path = ($cv.CommandLine -replace '^\"([^\"]+)\".*','$1')
if (-not (Test-Path $path)) { $path = 'C:\Program Files\Clash Verge\clash-verge.exe' }
Write-Host ('PATH=' + $path)
Write-Host 'Stopping clash-verge + verge-mihomo'
Stop-Process -Name 'verge-mihomo','clash-verge' -Force
Start-Sleep -Seconds 2
Write-Host 'Starting clash-verge'
Start-Process -FilePath $path
Start-Sleep -Seconds 4
$procs = Get-Process clash-verge,verge-mihomo -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName
$procs | Format-Table -AutoSize | Out-String | Write-Host
$listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 17890,17891 } |
  Select-Object LocalAddress,LocalPort,OwningProcess
$listen | Format-Table -AutoSize | Out-String | Write-Host
if (Get-Process verge-mihomo -ErrorAction SilentlyContinue) { Write-Host 'OK_CORE' } else { Write-Host 'FAIL_CORE'; exit 1 }
"""
tmp = Path(os.environ["TEMP"]) / "verge-reload.ps1"
tmp.write_text(ps, encoding="utf-8")
subprocess.check_call(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp)])

# quick local port check
import socket

for port in (17890, 17891):
    s = socket.socket()
    s.settimeout(1)
    try:
        s.connect(("127.0.0.1", port))
        print(f"port {port}: open")
    except Exception as e:
        print(f"port {port}: closed ({e})")
    finally:
        s.close()

print("DONE_RELOAD")
