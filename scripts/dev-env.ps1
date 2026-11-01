# Dot-source this file to prepare the current PowerShell session.
$namuRoot = Split-Path -Parent $PSScriptRoot

function Add-NamuPath([string]$Directory) {
    if ((Test-Path -LiteralPath $Directory) -and ($env:PATH -split ';' -notcontains $Directory)) {
        $env:PATH = "$Directory;$env:PATH"
    }
}

# Prefer the existing, project-local Rust installation unless the caller selected one.
$namuLocalCargo = Join-Path $namuRoot '.tools\cargo'
$namuLocalRustup = Join-Path $namuRoot '.tools\rustup'
if (-not $env:CARGO_HOME -and (Test-Path -LiteralPath "$namuLocalCargo\bin\cargo.exe") -and
    (Test-Path -LiteralPath "$namuLocalRustup\settings.toml")) {
    $env:CARGO_HOME = $namuLocalCargo
    if (-not $env:RUSTUP_HOME) { $env:RUSTUP_HOME = $namuLocalRustup }
}
Add-NamuPath (Join-Path $env:USERPROFILE '.cargo\bin')
if ($env:CARGO_HOME) { Add-NamuPath (Join-Path $env:CARGO_HOME 'bin') }

# Keep the executable/PDB paths used by launch.json and the installer consistent.
$env:CARGO_TARGET_DIR = Join-Path $namuRoot 'src-tauri\target'
$env:RUST_BACKTRACE = '1'

# Rust's MSVC target needs both the linker and the Windows SDK libraries.
if (-not $env:LIB -or -not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    $namuVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $namuVswhere) {
        $namuVsRoot = & $namuVswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($namuVsRoot) {
            $namuVsDev = Join-Path $namuVsRoot 'Common7\Tools\VsDevCmd.bat'
            if (Test-Path -LiteralPath $namuVsDev) {
                $namuVsEnvironment = & $env:ComSpec /d /s /c "`"`"$namuVsDev`" -no_logo -arch=x64 -host_arch=x64 >nul && set`""
                if ($LASTEXITCODE -ne 0) { throw 'Visual Studio developer environment initialization failed.' }
                foreach ($namuLine in $namuVsEnvironment) {
                    if ($namuLine -match '^([^=]+)=(.*)$') {
                        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
                    }
                }
            }
        } else {
            # Some VS installations include the self-contained Scope C++ SDK only.
            $namuVsRoots = & $namuVswhere -all -products '*' -property installationPath
            foreach ($namuInstallation in $namuVsRoots) {
                $namuScope = Join-Path $namuInstallation 'SDK\ScopeCppSDK\vc15'
                if ((Test-Path -LiteralPath "$namuScope\VC\bin\link.exe") -and
                    (Test-Path -LiteralPath "$namuScope\SDK\lib\kernel32.lib")) {
                    Add-NamuPath "$namuScope\VC\bin"
                    Add-NamuPath "$namuScope\SDK\bin"
                    $env:LIB = "$namuScope\VC\lib;$namuScope\SDK\lib"
                    $env:INCLUDE = "$namuScope\VC\include;$namuScope\SDK\include\ucrt;$namuScope\SDK\include\shared;$namuScope\SDK\include\um"
                    break
                }
            }
        }
    }
}
