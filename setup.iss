; Namu (나무) — Windows 설치 프로그램
; 빌드: scripts\build-installer.ps1 (payload 스테이징 후 ISCC 자동 호출)
; 수동: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" setup.iss

#define MyAppName "Namu"
#define MyAppNameKo "나무"
#define MyAppVersion "0.1.0"
; TODO: 배포자·저장소 주소를 실제 값으로 채우세요.
#define MyAppPublisher "Namu"
#define MyAppURL "https://example.com/namu"
#define MyAppExeName "Namu.exe"
#define MyAppGUID "{{0E1F359D-09D0-4F3C-BE2E-032F1D4E56D1}"
; scripts\build-installer.ps1 이 여기에 exe + ollama 런타임을 스테이징한다.
#define PayloadDir "installer\payload"

[Setup]
AppId={#MyAppGUID}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
AppCopyright=Copyright (C) 2026 {#MyAppPublisher}
AppComments=여러 로컬 채팅 AI를 iOS 느낌의 GUI에서 사용하는 데스크톱 앱
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 관리자 권한 없이 사용자 폴더에 설치 (Ollama·모델은 %USERPROFILE% 에 저장됨)
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=installer\output
OutputBaseFilename={#MyAppName}-Setup-{#MyAppVersion}
SetupIconFile=src-tauri\icons\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
; 업그레이드 설치 시 실행 중인 앱을 닫는다 (앱 자체도 단일 인스턴스라 중복 실행은 기존 창을 띄움).
CloseApplications=force
CloseApplicationsFilter={#MyAppExeName}
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Windows 10 1809+ (WebView2 런타임 기본 내장 시점)
MinVersion=10.0.17763
VersionInfoVersion={#MyAppVersion}.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 설치 프로그램
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; 앱 실행 파일 + 동봉 Ollama 런타임 (scripts\build-installer.ps1 이 스테이징).
; ollama\ollama.exe 와 ollama\lib\ollama\* 는 앱 실행 파일 기준 상대 경로를 유지해야 한다.
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.pdb,*.log,*.tmp"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
