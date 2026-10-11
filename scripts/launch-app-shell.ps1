# Desktop app shell: hosts the studio web UI inside our own WebView2 window so the
# taskbar icon, tray icon, and desktop shortcut all show app-icon.ico (single icon,
# like WeChat/QQ). Falls back to the browser "--app" window (launch-app.ps1) when
# WebView2 cannot be loaded on this machine.
#
# ASCII-only on purpose: this file has no BOM and PowerShell 5.1 decodes non-ASCII
# bytes as ANSI, which would break parsing. Chinese UI strings are built from code
# points in New-Text calls below.
param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".local-stack"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$logPath = Join-Path $stateDir "app-shell.log"
$pidFile = Join-Path $stateDir "app-shell.pid"
$iconPath = Join-Path $root "apps\studio-web\public\app-icon.ico"
$libDir = Join-Path $root "app-shell\lib"
$webView2Version = "1.0.2849.0"

$script:ownsPidFile = $false

$transcribing = $false
try {
  Start-Transcript -Path $logPath -Append | Out-Null
  $transcribing = $true
} catch {
  $transcribing = $false
}

function Say([string]$message) {
  Write-Host ("[{0}] {1}" -f (Get-Date).ToString("HH:mm:ss"), $message)
}

function New-Text([int[]]$codes) {
  return -join ($codes | ForEach-Object { [char]$_ })
}

# Chinese strings as code points so this file stays pure ASCII.
$script:L_APP = New-Text @(0x5185, 0x5BB9, 0x521B, 0x4F5C, 0x5E73, 0x53F0)
$script:L_FAIL = New-Text @(0x65E0, 0x6CD5, 0x52A0, 0x8F7D, 0x684C, 0x9762, 0x7A97, 0x53E3)
$script:L_FALLBACK = New-Text @(0x5DF2, 0x5207, 0x6362, 0x5230, 0x6D4F, 0x89C8, 0x5668, 0x6A21, 0x5F0F)

function Get-StudioUrl {
  $stateFile = Join-Path $stateDir "state.json"
  if (-not (Test-Path $stateFile)) { return "" }
  try {
    return [string](Get-Content $stateFile -Raw | ConvertFrom-Json).urls.studio
  } catch {
    return ""
  }
}

function Test-Url([string]$url) {
  if ([string]::IsNullOrWhiteSpace($url)) { return $false }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 4
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

# user32 helpers for focusing an already-running window (single-instance).
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ShellWinApi {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@

function Focus-ExistingWindow([string]$title) {
  try {
    $h = [ShellWinApi]::FindWindow($null, $title)
    if ($h -ne [IntPtr]::Zero) {
      [ShellWinApi]::ShowWindow($h, 9)           # SW_RESTORE
      [ShellWinApi]::SetForegroundWindow($h)
      return $true
    }
  } catch { }
  return $false
}

function Start-Backend {
  $url = Get-StudioUrl
  if (Test-Url $url) {
    Say "services already running at $url"
    return $url
  }
  Say "starting content profile"
  $dev = Join-Path $root "dev.ps1"
  if (-not (Test-Path $dev)) { throw "dev.ps1 not found at $dev" }
  & $dev content
  $url = Get-StudioUrl
  if ([string]::IsNullOrWhiteSpace($url)) {
    throw "No studio url recorded in .local-stack/state.json"
  }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $url) { break }
    Start-Sleep -Milliseconds 600
  }
  if (-not (Test-Url $url)) { throw "Studio not reachable: $url" }
  Say "studio ready at $url"
  return $url
}

function Find-Wv2Dll([string]$name) {
  $cands = @(
    (Join-Path $libDir "lib/net472/$name"),
    (Join-Path $libDir "lib/net462/$name"),
    (Join-Path $libDir "lib/netcoreapp3.0/$name"),
    (Join-Path $libDir $name)
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $found = Get-ChildItem $libDir -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

function Ensure-WebView2 {
  $winFormsDll = Find-Wv2Dll "Microsoft.Web.WebView2.WinForms.dll"
  $coreDll = Find-Wv2Dll "Microsoft.Web.WebView2.Core.dll"
  if ($winFormsDll -and $coreDll) { return $winFormsDll, $coreDll }

  Say "WebView2 component not present, downloading (needs internet once)..."
  New-Item -ItemType Directory -Force -Path $libDir | Out-Null
  $pkgUrl = ("https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{0}/microsoft.web.webview2.{0}.nupkg" -f $webView2Version)
  $nupkg = Join-Path $libDir "wv2.nupkg"
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $pkgUrl -OutFile $nupkg -TimeoutSec 180

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $extract = Join-Path $libDir "package"
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $extract)

  $w = Find-Wv2Dll "Microsoft.Web.WebView2.WinForms.dll"
  $c = Find-Wv2Dll "Microsoft.Web.WebView2.Core.dll"
  if (-not $w -or -not $c) { throw "WebView2 assemblies not found in the downloaded package" }

  # Flatten the assemblies we reference to the lib root for clean Add-Type paths.
  Copy-Item $w $libDir -Force
  Copy-Item $c $libDir -Force
  $native = Get-ChildItem $extract -Recurse -Filter "WebView2Loader.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($native) { Copy-Item $native.FullName $libDir -Force }
  Remove-Item $nupkg -Force -ErrorAction SilentlyContinue

  $winFormsDll = Join-Path $libDir "Microsoft.Web.WebView2.WinForms.dll"
  $coreDll = Join-Path $libDir "Microsoft.Web.WebView2.Core.dll"
  if (-not (Test-Path $winFormsDll) -or -not (Test-Path $coreDll)) {
    throw "WebView2 assemblies could not be prepared"
  }
  return $winFormsDll, $coreDll
}

function Stop-Backend {
  $stopScript = Join-Path $PSScriptRoot "stop-local-stack.ps1"
  if (Test-Path $stopScript) {
    try { & $stopScript } catch { Say ("stop reported: " + $_.Exception.Message) }
  }
  if ($script:ownsPidFile) {
    try { [System.IO.File]::Delete($pidFile) } catch { }
  }
}

# C# form source kept ASCII; user-facing title comes from PowerShell at runtime.
$formSource = @'
using System;
using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

public class AppShellForm : Form
{
    private WebView2 webView;
    private NotifyIcon tray;
    private string studioUrl;
    private string appTitle;
    private string iconPath;

    public AppShellForm(string url, string icon, string title)
    {
        this.studioUrl = url;
        this.iconPath = icon;
        this.appTitle = title;
        this.Text = title;
        this.Width = 1280;
        this.Height = 800;
        this.StartPosition = FormStartPosition.CenterScreen;
        this.MinimumSize = new Size(480, 320);

        Icon ico = LoadIcon(icon);
        if (ico != null) this.Icon = ico;

        webView = new WebView2();
        webView.Dock = DockStyle.Fill;
        this.Controls.Add(webView);
        webView.CoreWebView2InitializationCompleted += (s, e) => {
            if (e.IsSuccess && !string.IsNullOrEmpty(this.studioUrl))
                webView.CoreWebView2.Navigate(this.studioUrl);
        };

        tray = new NotifyIcon();
        tray.Icon = (ico == null) ? SystemIcons.Application : ico;
        tray.Text = title;
        tray.Visible = true;
        var menu = new ContextMenuStrip();
        var openItem = menu.Items.Add("Open");
        var quitItem = menu.Items.Add("Quit");
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (s, e) => { ShowAndFocus(); };
        openItem.Click += (s, e) => { ShowAndFocus(); };
        quitItem.Click += (s, e) => { this.Close(); };

        this.FormClosing += (s, e) => {
            try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch { }
        };
        this.Load += (s, e) => {
            try { webView.EnsureCoreWebView2Async(); } catch { }
        };
    }

    private Icon LoadIcon(string path)
    {
        try {
            if (!string.IsNullOrEmpty(path) && System.IO.File.Exists(path))
                return new Icon(path);
        } catch { }
        return null;
    }

    private void ShowAndFocus()
    {
        this.Show();
        if (this.WindowState == FormWindowState.Minimized)
            this.WindowState = FormWindowState.Normal;
        this.BringToFront();
    }
}
'@

try {
  Say ("app shell started (pid=" + $PID + ")")

  # Single-instance via a named mutex. It is released automatically when the
  # owning process exits, so it can NEVER deadlock on a leftover pid file the way
  # the old scheme did (a stuck/crashed instance used to block every later launch).
  $script:haveLock = $false
  $mutex = $null
  try {
    $mutex = New-Object System.Threading.Mutex($false, "Global\ContentCreateAppShell")
    $script:haveLock = $mutex.WaitOne(0)
  } catch {
    $script:haveLock = $true
  }

  if (-not $Force -and -not $script:haveLock) {
    Say "another instance owns the app, focusing its window"
    $deadline = (Get-Date).AddSeconds(30)
    $focused = $false
    while ((Get-Date) -lt $deadline) {
      if (Focus-ExistingWindow $script:L_APP) { $focused = $true; break }
      Start-Sleep -Milliseconds 800
    }
    Say ("focus result: " + $focused)
    exit 0
  }

  $stamp = (Get-Date).ToString("yyyyMMddHHmmss")
  Set-Content -LiteralPath $pidFile -Value @($PID, $stamp) -Encoding ASCII
  $script:ownsPidFile = $true
  Say ("shell pid recorded: " + $PID)

  $url = Start-Backend

  try {
    $winFormsDll, $coreDll = Ensure-WebView2
    # Make the native loader discoverable to the WebView2 control.
    if (Test-Path (Join-Path $libDir "WebView2Loader.dll")) {
      $env:PATH = ($libDir + ";" + $env:PATH)
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition $formSource -ReferencedAssemblies @(
      $winFormsDll, $coreDll, "System.Windows.Forms", "System.Drawing", "System"
    )
    $form = New-Object AppShellForm($url, $iconPath, $script:L_APP)
    Say "opening desktop window (WebView2)"
    $form.ShowDialog() | Out-Null
    Say "window closed, shutting down"
  } catch {
    Say ("WebView2 shell failed: " + $_.Exception.Message)
    Say $script:L_FALLBACK
    try { [System.IO.File]::Delete($pidFile) } catch { }
    $script:ownsPidFile = $false
    & (Join-Path $PSScriptRoot "launch-app.ps1") -Force
    exit 0
  }

  Stop-Backend
} catch {
  Say ("ERROR " + $_.Exception.Message)
  if ($script:ownsPidFile) {
    try { [System.IO.File]::Delete($pidFile) } catch { }
  }
  $dlg = New-Text @(0x5185, 0x5BB9, 0x521B, 0x4F5C, 0x5E73, 0x53F0)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(("Could not start the app.`r`n`r`nLog: " + $logPath + "`r`n`r`n" + $_.Exception.Message), $dlg) | Out-Null
  } catch { }
} finally {
  if ($transcribing) { try { Stop-Transcript | Out-Null } catch { } }
}
