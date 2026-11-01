[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('doctor', 'configure-vscode', 'install-rust-tools', 'install', 'dev', 'web', 'check', 'test', 'test-rust', 'test-ui',
        'build-debug', 'build', 'build-app', 'installer', 'prepare-ollama', 'fmt', 'clippy', 'cargo')]
    [string]$Action = 'doctor',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs = @()
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-env.ps1')
Set-Location $namuRoot

function Require-NamuTool([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required tool not found: $Name. See docs/VSCODE.md for setup instructions."
    }
}

try {
    if ($Action -eq 'configure-vscode') {
        # Extension processes do not inherit the integrated terminal's environment.
        $namuSettingsPath = Join-Path $namuRoot '.vscode/settings.json'
        $namuSettings = Get-Content -LiteralPath $namuSettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $namuRustEnvironment = @{}
        foreach ($namuKey in @('LIB', 'INCLUDE', 'CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR')) {
            $namuValue = [Environment]::GetEnvironmentVariable($namuKey, 'Process')
            if ($namuValue) { $namuRustEnvironment[$namuKey] = $namuValue.Replace($namuRoot, '${workspaceFolder}') }
        }
        $namuToolDirectories = @('cargo.exe', 'rustc.exe', 'link.exe', 'rc.exe', 'node.exe') |
            ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } |
            ForEach-Object { Split-Path -Parent $_.Source } | Select-Object -Unique
        # Use Windows' case-insensitive Path alias to avoid a self-reference in the
        # extension's ${env:...} expansion, and preserve the editor's original PATH.
        $namuRustEnvironment['PATH'] = (($namuToolDirectories -join ';') + ';${env:Path}').Replace($namuRoot, '${workspaceFolder}')
        $namuSettings | Add-Member -NotePropertyName 'rust-analyzer.server.extraEnv' -NotePropertyValue $namuRustEnvironment -Force
        $namuJson = ($namuSettings | ConvertTo-Json -Depth 20) + [Environment]::NewLine
        [IO.File]::WriteAllText($namuSettingsPath, $namuJson, (New-Object Text.UTF8Encoding $false))
        Write-Host 'Rust extension environment saved. Run Developer: Reload Window in VS Code.'
        exit 0
    }
    if ($Action -eq 'install-rust-tools') {
        Require-NamuTool 'rustup.exe'
        & rustup.exe component add rustfmt clippy
        exit $LASTEXITCODE
    }
    if ($Action -eq 'doctor') {
        foreach ($namuTool in @('node.exe', 'npm.cmd', 'cargo.exe', 'rustc.exe', 'link.exe')) {
            $namuCommand = Get-Command $namuTool -ErrorAction SilentlyContinue
            if ($namuCommand) { Write-Host "[OK] $namuTool : $($namuCommand.Source)" }
            else { Write-Warning "[MISSING] $namuTool" }
        }
        Write-Host "CARGO_HOME       = $env:CARGO_HOME"
        Write-Host "RUSTUP_HOME      = $env:RUSTUP_HOME"
        Write-Host "CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR"
        if (Get-Command cargo.exe -ErrorAction SilentlyContinue) {
            & cargo.exe --version
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        if (-not (Test-Path -LiteralPath 'node_modules/@tauri-apps/cli/package.json')) {
            Write-Warning 'Run the dependencies:install task (npm ci) before desktop development.'
        }
        if (-not (Test-Path -LiteralPath 'src-tauri/ollama-bundle/ollama.exe')) {
            Write-Host '[OPTIONAL] Bundled Ollama is absent. Use a running/installed Ollama for development.'
        }
        Write-Host 'Installer builds additionally require Inno Setup 6 and the Ollama CPU bundle.'
        exit 0
    }

    if ($Action -in @('check', 'test-rust', 'build-debug', 'fmt', 'clippy', 'cargo')) {
        Require-NamuTool 'cargo.exe'
        Push-Location (Join-Path $namuRoot 'src-tauri')
        try {
            switch ($Action) {
                'check'       { & cargo.exe check --locked @CommandArgs }
                'test-rust'   { & cargo.exe test --locked @CommandArgs }
                'build-debug' { & cargo.exe build --locked --bin Namu @CommandArgs }
                'fmt'         { & cargo.exe fmt --all @CommandArgs }
                'clippy'      { & cargo.exe clippy --locked --all-targets @CommandArgs }
                'cargo'       { & cargo.exe @CommandArgs }
            }
            $namuExitCode = $LASTEXITCODE
        } finally { Pop-Location }
        exit $namuExitCode
    }

    Require-NamuTool 'node.exe'
    if ($Action -eq 'web') {
        & node.exe scripts/dev-server.mjs @CommandArgs
    } elseif ($Action -eq 'prepare-ollama') {
        & (Join-Path $PSScriptRoot 'prepare-ollama-bundle.ps1') @CommandArgs
        exit 0
    } elseif ($Action -eq 'installer') {
        Require-NamuTool 'npm.cmd'
        Require-NamuTool 'cargo.exe'
        & (Join-Path $PSScriptRoot 'build-installer.ps1') @CommandArgs
        exit 0
    } else {
        Require-NamuTool 'npm.cmd'
        if ($Action -in @('dev', 'build', 'build-app')) { Require-NamuTool 'cargo.exe' }
        switch ($Action) {
            'install'   { & npm.cmd ci @CommandArgs }
            'dev'       { & npm.cmd run dev -- @CommandArgs }
            'test'      { & npm.cmd test -- @CommandArgs }
            'test-ui'   { & npm.cmd run test:ui -- @CommandArgs }
            'build'     { & npm.cmd run build -- @CommandArgs }
            'build-app' { & npm.cmd run build -- --no-bundle @CommandArgs }
        }
    }
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
