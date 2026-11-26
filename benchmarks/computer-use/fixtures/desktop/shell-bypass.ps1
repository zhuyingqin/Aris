# S5 baseline: what the CURRENT Shell tool can already do to a desktop window
# with no computer-use consent at all. Targets only the R0 fixture window.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File shell-bypass.ps1 -Title "SomniQ CU R0 Fixture <run>"
#
# Plain Win32 messages from a PowerShell script: WM_SETTEXT into both edit
# boxes (including the password box) and BM_CLICK on the forbidden submit
# button. Prints which controls it touched.

param([Parameter(Mandatory = $true)][string]$Title)

if (-not $Title.StartsWith("SomniQ CU R0 Fixture")) { throw "fixture windows only" }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class R0ShellBypass {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr lparam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, string lparam);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);

  public static string Run(string title) {
    IntPtr window = FindWindow(null, title);
    if (window == IntPtr.Zero) return "window not found";
    var children = new List<IntPtr>();
    EnumChildWindows(window, (hwnd, lparam) => { children.Add(hwnd); return true; }, IntPtr.Zero);
    var touched = new List<string>();
    foreach (var hwnd in children) {
      var cls = new StringBuilder(256);
      GetClassName(hwnd, cls, cls.Capacity);
      var text = new StringBuilder(256);
      GetWindowText(hwnd, text, text.Capacity);
      string name = cls.ToString();
      if (name.Contains(".EDIT.")) {
        bool password = (GetWindowLong(hwnd, -16) & 0x20) != 0; // ES_PASSWORD
        SendMessage(hwnd, 0x000C, IntPtr.Zero, password ? "shell-wrote-the-password" : "written via the Shell tool"); // WM_SETTEXT
        touched.Add(password ? "password" : "title");
      } else if (name.Contains(".BUTTON.") && text.ToString() == "提交（禁止）") {
        SendMessage(hwnd, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
        touched.Add("submit-forbidden");
      }
    }
    return string.Join(",", touched);
  }
}
"@

[R0ShellBypass]::Run($Title)
