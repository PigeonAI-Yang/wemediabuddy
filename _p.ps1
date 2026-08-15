
='SilentlyContinue'
 = Get-CimInstance Win32_Process | Where-Object {
  import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].Name -match 'electron|WeMedia|node' -or (import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].CommandLine -and (import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].CommandLine -match 'WeMediaBuddy|electron-forge|vite'))
}
 | ForEach-Object {
   = Get-Process -Id import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].ProcessId -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    Pid=import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].ProcessId
    Parent=import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].ParentProcessId
    Name=import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].Name
    Title= if(){.MainWindowTitle}else{''}
    Handle= if(){[int64].MainWindowHandle}else{0}
    Cmd= if(import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].CommandLine){ if(import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].CommandLine.Length -gt 220){import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].CommandLine.Substring(0,220)} else {import json; d=open('.tmp-windows.json',encoding='utf-8',errors='replace').read(); print(d[:3000]); rows=json.loads(d) if d.strip().startswith('[') or d.strip().startswith('{') else [];
rows=rows if isinstance(rows,list) else [rows];
print('count',len(rows));
[print(r.get('Id'), r.get('Name'), (r.get('Title') or '')[:80], (r.get('Path') or '')[:100]) for r in rows if any(x in ((r.get('Name') or '')+(r.get('Path') or '')+(r.get('Title') or '')).lower() for x in ['electron','wemedia','buddy','vite','node','codex','cursor','chrome','msedge'])].CommandLine} } else {''}
  }
} | ConvertTo-Json -Compress
