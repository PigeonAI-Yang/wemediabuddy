$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class AltTab {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  const int GWL_EXSTYLE = -20;
  const int GWL_STYLE = -16;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const int WS_EX_APPWINDOW = 0x00040000;
  const int WS_CHILD = 0x40000000;
  const uint GW_OWNER = 4;
  const uint WM_CLOSE = 0x0010;
  static bool IsAltTabWindow(IntPtr hWnd) {
    if (!IsWindowVisible(hWnd)) return false;
    int style = GetWindowLong(hWnd, GWL_STYLE);
    if ((style & WS_CHILD) != 0) return false;
    IntPtr owner = GetWindow(hWnd, GW_OWNER);
    int ex = GetWindowLong(hWnd, GWL_EXSTYLE);
    if (owner == IntPtr.Zero) {
      if ((ex & WS_EX_TOOLWINDOW) != 0) return false;
      return true;
    }
    // owned windows sometimes still appear
    if ((ex & WS_EX_APPWINDOW) != 0) return true;
    return false;
  }
  public static List<string> Run() {
    var list = new List<string>();
    IntPtr shell = GetShellWindow();
    EnumWindows((h, l) => {
      if (h == shell) return true;
      if (!IsAltTabWindow(h)) return true;
      var title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      int w=r.Right-r.Left, ht=r.Bottom-r.Top;
      list.Add(pid + "\t" + h.ToInt64() + "\t" + w + "x" + ht + "\t@(" + r.Left + "," + r.Top + ")\ticonic=" + IsIconic(h) + "\t" + cls.ToString() + "\t[" + title.ToString() + "]");
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string CloseHwnd(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    SetForegroundWindow(h);
    ShowWindow(h, 9);
    PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    return "closed " + hwnd;
  }
}
"@
[AltTab]::Run() | ForEach-Object { $_ }
