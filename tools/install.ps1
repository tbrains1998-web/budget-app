<#
.SYNOPSIS
  Installs the budget app: copies Budget.html into the target folder and creates the desktop shortcut "Budget".

.DESCRIPTION
  An existing <Target>\Budget.html with different content is first copied to <Target>\old\Budget-<yyyyMMdd-HHmmss>.html.
  The user's budget data lives in the browser's storage, not in this file, so replacing the file keeps the data.
  Windows PowerShell 5.1 compatible; this file is ASCII only on purpose.

.PARAMETER Source
  The built single-file app. Default: dist\Budget.html in this project.

.PARAMETER Target
  Folder to install into. Default: a Budget folder in your user profile (%USERPROFILE%\Budget).

.PARAMETER NoShortcut
  Do not create or update the desktop shortcut.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install.ps1 -Target .\.tmp\install-test -NoShortcut
#>
[CmdletBinding()]
param(
  [string]$Source,
  [string]$Target = (Join-Path $env:USERPROFILE 'Budget'),
  [switch]$NoShortcut
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# Set here, not as a param() default: with [CmdletBinding()] and -File, Windows PowerShell 5.1 leaves $PSScriptRoot empty there.
if (-not $Source) { $Source = Join-Path $PSScriptRoot '..\dist\Budget.html' }

$ShortcutIcon = "$env:SystemRoot\System32\imageres.dll,227" # briefcase

function New-BudgetShortcut {
  param([string]$LinkPath, [string]$FilePath)
  $shell = New-Object -ComObject WScript.Shell
  try {
    $link = $shell.CreateShortcut($LinkPath)
    $link.TargetPath = $FilePath
    $link.WorkingDirectory = Split-Path -Parent $FilePath
    $link.IconLocation = $ShortcutIcon
    $link.Description = 'Budget - household budget'
    $link.Save()
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
  }
}

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Source file not found: $Source (build it first with: npm run build)"
}
$Source = (Resolve-Path -LiteralPath $Source).Path
New-Item -ItemType Directory -Force -Path $Target | Out-Null
$Target = (Resolve-Path -LiteralPath $Target).Path
$dest = Join-Path $Target 'Budget.html'
if ($Source -eq $dest) {
  throw "Source and target are the same file: $dest"
}

if (Test-Path -LiteralPath $dest -PathType Leaf) {
  if ((Get-FileHash -LiteralPath $dest).Hash -eq (Get-FileHash -LiteralPath $Source).Hash) {
    Write-Host "Unchanged: $dest already has the same content."
  } else {
    $oldDir = Join-Path $Target 'old'
    New-Item -ItemType Directory -Force -Path $oldDir | Out-Null
    $keep = Join-Path $oldDir ('Budget-{0}.html' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $dest -Destination $keep -Force
    Copy-Item -LiteralPath $Source -Destination $dest -Force
    Write-Host "Old version kept: $keep"
    Write-Host "Updated: $dest"
  }
} else {
  Copy-Item -LiteralPath $Source -Destination $dest
  Write-Host "Installed: $dest"
}

if ($NoShortcut) {
  Write-Host 'No shortcut made (-NoShortcut).'
} else {
  $link = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Budget.lnk'
  New-BudgetShortcut -LinkPath $link -FilePath $dest
  Write-Host "Desktop shortcut: $link -> $dest"
}
