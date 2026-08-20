; 筑星 Harness —— NSIS 安装脚本
; 构建：node scripts/build-nsis.mjs
; 特性：免管理员（%LOCALAPPDATA%）、PATH 追加、开始菜单快捷方式、卸载器

Unicode true

!include "MUI2.nsh"
!include "WordFunc.nsh"
!include "WinMessages.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif

Name "筑星 Harness"
OutFile "zhuxing-harness-setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\ZhuxingHarness"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装" SEC01
  SetOutPath "$INSTDIR"
  File /r /x "*.tsbuildinfo" "app\*"

  ; 追加安装目录到用户 PATH（免管理员）
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 "$INSTDIR"
  ${If} $0 != ""
    StrCpy $0 "$0;$1"
  ${Else}
    StrCpy $0 "$1"
  ${EndIf}
  WriteRegExpandStr HKCU "Environment" "Path" $0
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; 开始菜单快捷方式
  CreateDirectory "$SMPROGRAMS\筑星 Harness"
  CreateShortcut "$SMPROGRAMS\筑星 Harness\Harness 命令行.lnk" "$INSTDIR\harness.cmd" "" "$INSTDIR\harness.cmd"
  CreateShortcut "$SMPROGRAMS\筑星 Harness\卸载筑星 Harness.lnk" "$INSTDIR\uninstall.exe"

  ; 卸载器与注册表信息
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness" "DisplayName" "筑星 Harness"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness" "Publisher" "Zhuxing"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; 从 PATH 移除安装目录
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 != ""
    ${WordReplace} $0 ";$INSTDIR" "" "+" $1
    ${WordReplace} $1 "$INSTDIR" "" "+" $1
    WriteRegExpandStr HKCU "Environment" "Path" $1
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; 清理快捷方式与注册表
  RMDir /r "$SMPROGRAMS\筑星 Harness"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZhuxingHarness"

  ; 删除安装目录
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
SectionEnd
