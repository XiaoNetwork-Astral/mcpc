# mcpc installer for Windows PowerShell 5.1 and PowerShell 7.
#
#   .\installer.ps1 [install [claude|codex|other <SKILLS_DIR>]]
#   .\installer.ps1 uninstall [claude|codex|other <SKILLS_DIR>]
#   .\installer.ps1 -h | --help
#
# Piped:
#   irm https://github.com/XiaoNetwork-Astral/mcpc/releases/latest/download/installer.ps1 | iex
#   & ([scriptblock]::Create((irm https://github.com/XiaoNetwork-Astral/mcpc/releases/latest/download/installer.ps1))) uninstall
#
# Installing clones the latest release into ~\.mcpc\app, or upgrades the
# checkout found there or next to this script, and hands over to
# scripts\installer.mjs. Uninstalling needs no checkout, so it also cleans up
# after a broken install. MCPC_INSTALL_REPO overrides the repository to clone.
#
# This file is ASCII only: Windows PowerShell 5.1 reads a file without a
# byte-order mark, and piped source, in the legacy code page. There is no
# param() block, so arguments work the same from a file and from a script
# block. Failures throw instead of calling exit, so a piped run never closes
# the window; a run from a file still ends with exit code 1.

$McpcScriptPath = $MyInvocation.MyCommand.Path
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}

function Invoke-McpcInstaller {
    $ErrorActionPreference = 'Continue'
    $usageLine = 'Usage: installer [install|uninstall] [claude|codex|other <SKILLS_DIR>]'
    $okMark = [string][char]0x2713
    $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
    $repoUrl = if ($env:MCPC_INSTALL_REPO) { $env:MCPC_INSTALL_REPO } else { 'https://github.com/XiaoNetwork-Astral/mcpc.git' }
    $stateDir = Join-Path $homeDir '.mcpc'
    $appDir = Join-Path $stateDir 'app'
    $record = Join-Path $stateDir 'installed-skills.txt'
    $utf8 = New-Object System.Text.UTF8Encoding $false

    function Write-Ok([string]$Message, [string]$Detail) {
        if ($Detail) { Write-Host "  $okMark $Message  $Detail" } else { Write-Host "  $okMark $Message" }
    }
    function Write-Warn([string]$Message, [string]$Detail) {
        if ($Detail) { Write-Host "  ! $Message  $Detail" } else { Write-Host "  ! $Message" }
    }
    function Stop-Installer([string]$Message, [string]$Fix) {
        $failure = New-Object System.Exception $Message
        $failure.Data['Fix'] = $Fix
        throw $failure
    }
    function Test-Checkout([string]$Dir) {
        if (-not $Dir) { return $false }
        $package = Join-Path $Dir 'package.json'
        if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { return $false }
        if (-not (Test-Path -LiteralPath (Join-Path $Dir 'scripts\installer.mjs') -PathType Leaf)) { return $false }
        return [bool](Select-String -LiteralPath $package -Pattern '"name": "mcpc"' -SimpleMatch -Quiet)
    }
    function Test-Skill([string]$Dir) {
        $file = Join-Path $Dir 'SKILL.md'
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
        return [bool](Select-String -LiteralPath $file -Pattern '^name:\s*mcp-client\s*$' -CaseSensitive -Quiet)
    }
    function Remove-Skill([string]$Dir) {
        if (Test-Skill $Dir) {
            Remove-Item -LiteralPath $Dir -Recurse -Force
            Write-Ok 'Removed the mcp-client skill' $Dir
        } elseif (Test-Path -LiteralPath $Dir) {
            Write-Warn 'Not the mcp-client skill; left it in place' $Dir
        }
    }
    function Read-Record {
        if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { return @() }
        return @([IO.File]::ReadAllLines($record, $utf8) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }

    # -----------------------------------------------------------------------
    # Command line
    # -----------------------------------------------------------------------

    $rest = @($args)
    $action = 'install'
    if ($rest.Count -gt 0) {
        $first = [string]$rest[0]
        if ($first -ceq 'install' -or $first -ceq 'uninstall') {
            $action = $first
            $rest = @($rest | Select-Object -Skip 1)
        } elseif ($first -eq '-h' -or $first -eq '--help') {
            Write-Host @'
mcpc installer (Windows)

Usage:
  installer [install [claude|codex|other <SKILLS_DIR>]]
  installer uninstall [claude|codex|other <SKILLS_DIR>]
  installer -h | --help

install    Install mcpc into ~\.mcpc\app, or upgrade it to the latest release,
           link the mcpc command, and copy the mcp-client skill into every
           harness found (with a harness named, into that one as well).
uninstall  Remove the skill from every harness it was copied to, the mcpc
           command and ~\.mcpc\app. Configuration, caches and logs in ~\.mcpc
           stay. With a harness named, remove only that copy of the skill.

Harnesses:
  claude   ~\.claude\skills (found when ~\.claude exists)
  codex    ~\.agents\skills (found when ~\.agents or ~\.codex exists)
  other    any absolute skills directory

After installing, mcpc update upgrades to the latest release.
'@
            return
        } else {
            Stop-Installer "Unknown command: $first" $usageLine
        }
    }

    $skillsDir = $null
    if ($rest.Count -gt 0) {
        $harness = [string]$rest[0]
        $rest = @($rest | Select-Object -Skip 1)
        if ($harness -ceq 'claude') {
            $skillsDir = Join-Path (Join-Path $homeDir '.claude') 'skills'
        } elseif ($harness -ceq 'codex') {
            $skillsDir = Join-Path (Join-Path $homeDir '.agents') 'skills'
        } elseif ($harness -ceq 'other') {
            if ($rest.Count -eq 0 -or -not [string]$rest[0]) { Stop-Installer 'other needs an absolute skills directory' $usageLine }
            $skillsDir = [string]$rest[0]
            $rest = @($rest | Select-Object -Skip 1)
            if (-not [IO.Path]::IsPathRooted($skillsDir)) { Stop-Installer "The skills directory must be absolute: $skillsDir" $usageLine }
            $skillsDir = [IO.Path]::GetFullPath($skillsDir).TrimEnd('\', '/')
        } else {
            Stop-Installer "Unknown harness: $harness" $usageLine
        }
    }
    if ($rest.Count -gt 0) { Stop-Installer "Unexpected argument: $($rest[0])" $usageLine }

    # -----------------------------------------------------------------------
    # Uninstall
    # -----------------------------------------------------------------------

    if ($action -eq 'uninstall') {
        Write-Host 'mcpc uninstaller'
        if ($skillsDir) {
            $target = Join-Path $skillsDir 'mcp-client'
            if (Test-Path -LiteralPath $target) { Remove-Skill $target } else { Write-Ok "No mcp-client skill in $skillsDir" }
            if (Test-Path -LiteralPath $record -PathType Leaf) {
                $kept = @(Read-Record | Where-Object { $_ -ne $target })
                [IO.File]::WriteAllLines($record, [string[]]$kept, $utf8)
            }
            return
        }

        $entries = @(
            (Join-Path $homeDir '.claude\skills\mcp-client'),
            (Join-Path $homeDir '.agents\skills\mcp-client')
        ) + @(Read-Record)
        foreach ($entry in $entries) { Remove-Skill $entry }

        if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
            & npm.cmd ls --global --depth=0 mcpc 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                & npm.cmd uninstall --global mcpc 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { Write-Ok 'Removed the mcpc command' }
                else { Write-Warn 'Cannot remove the mcpc command' 'npm uninstall -g mcpc' }
            }
        } else {
            Write-Warn 'npm was not found, so the mcpc command was not checked'
        }

        if (Test-Checkout $appDir) {
            Remove-Item -LiteralPath $appDir -Recurse -Force
            Write-Ok 'Removed the checkout' $appDir
        }
        if (Test-Path -LiteralPath $record) { Remove-Item -LiteralPath $record -Force }
        Write-Ok 'mcpc is uninstalled' "configuration, caches and logs stay in $stateDir"
        return
    }

    # -----------------------------------------------------------------------
    # Install or upgrade
    # -----------------------------------------------------------------------

    Write-Host 'mcpc installer'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Stop-Installer 'Git is required' 'Install Git from https://git-scm.com/downloads, then reopen the terminal'
    }
    Write-Ok ([string](@(& git --version)[0]))
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Stop-Installer 'Node.js 24.9 or newer is required' 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
    }
    $nodeVersion = [string](@(& node --version)[0])
    & node -e 'const [a, b] = process.versions.node.split(''.'').map(Number); process.exit(a > 24 || (a === 24 && b >= 9) ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) {
        Stop-Installer "Node.js 24.9 or newer is required; found $nodeVersion" 'Install the current Node.js LTS from https://nodejs.org, then reopen the terminal'
    }
    Write-Ok "Node.js $nodeVersion"
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        Stop-Installer 'npm is required' 'Reinstall Node.js with npm from https://nodejs.org, then reopen the terminal'
    }
    Write-Ok "npm $([string](@(& npm.cmd --version)[0]))"

    $checkout = $null
    if ($McpcScriptPath) {
        $scriptDir = Split-Path -Parent $McpcScriptPath
        if (Test-Checkout $scriptDir) { $checkout = $scriptDir }
    }
    if (-not $checkout -and (Test-Checkout $appDir)) { $checkout = $appDir }

    if ($checkout) {
        Write-Ok 'Found mcpc' $checkout
    } else {
        if ((Test-Path -LiteralPath $appDir) -and @(Get-ChildItem -LiteralPath $appDir -Force).Count -gt 0) {
            Stop-Installer "$appDir exists but is not an mcpc checkout" 'Move or remove it, then run the installer again'
        }
        $listing = @(& git ls-remote --tags --refs --sort=-v:refname $repoUrl 2>$null)
        $tag = $null
        foreach ($line in $listing) {
            $name = ([string]$line -split 'refs/tags/', 2)[-1].Trim()
            if ($name -match '^v?\d+\.\d+\.\d+$') { $tag = $name; break }
        }
        if (-not $tag) { Stop-Installer 'Cannot find the latest mcpc release' "Check network access: git ls-remote --tags $repoUrl" }
        New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
        & git -c advice.detachedHead=false clone --quiet --branch $tag $repoUrl $appDir
        if ($LASTEXITCODE -ne 0) { Stop-Installer "Cannot clone mcpc $tag" "git clone --branch $tag $repoUrl `"$appDir`"" }
        Write-Ok "Cloned mcpc $tag" $appDir
        $checkout = $appDir
    }

    $core = Join-Path $checkout 'scripts\installer.mjs'
    if ($skillsDir) { & node $core install --skills $skillsDir } else { & node $core install }
    if ($LASTEXITCODE -ne 0) { Stop-Installer "mcpc install failed (exit $LASTEXITCODE)" '' }
    Write-Ok 'mcpc is installed' 'run mcpc --help to start, mcpc update to upgrade'
}

$McpcExitCode = 0
try {
    Invoke-McpcInstaller @args
} catch {
    $McpcExitCode = 1
    [Console]::Error.WriteLine("  $([char]0x2717) $($_.Exception.Message)")
    $fix = $_.Exception.Data['Fix']
    if ($fix) { [Console]::Error.WriteLine("    -> $fix") }
}
if ($McpcScriptPath) { exit $McpcExitCode }
$global:LASTEXITCODE = $McpcExitCode
