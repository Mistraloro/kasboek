; Kasboek additions to the .exe (NSIS) installer.
; A "Shortcuts" page with two checkboxes (desktop, Start menu). On an update the boxes start in the
; state of the current install, so a removed shortcut isn't brought back. Silent installs and
; automatic updates skip the page and keep electron-builder's normal behaviour.
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var kbDesktopBox
Var kbStartMenuBox
Var kbWantDesktop
Var kbWantStartMenu
Var kbPageShown
!endif

; The page and its functions are defined here because the MUI macros only exist at this point.
!macro customPageAfterChangeDir
Page custom kbShortcutsPage kbShortcutsLeave

Function kbShortcutsPage
  !insertmacro MUI_HEADER_TEXT "Shortcuts" "Choose where you want to start ${PRODUCT_NAME} from."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateCheckbox} 0 10u 100% 12u "Create a shortcut on the &desktop"
  Pop $kbDesktopBox
  ${NSD_CreateCheckbox} 0 30u 100% 12u "Create a shortcut in the &Start menu"
  Pop $kbStartMenuBox
  ${NSD_CreateLabel} 0 56u 100% 24u "You can change this later by running the installer again."
  Pop $0
  ; Updating: start from what is there now. New install: both ticked.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${IfNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Goto kbDesktopDone
    ${EndIf}
  ${EndIf}
  ${NSD_Check} $kbDesktopBox
  kbDesktopDone:
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${IfNot} ${FileExists} "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      Goto kbStartDone
    ${EndIf}
  ${EndIf}
  ${NSD_Check} $kbStartMenuBox
  kbStartDone:
  nsDialogs::Show
FunctionEnd

Function kbShortcutsLeave
  StrCpy $kbPageShown "1"
  ${NSD_GetState} $kbDesktopBox $kbWantDesktop
  ${NSD_GetState} $kbStartMenuBox $kbWantStartMenu
FunctionEnd
!macroend

!macro customInstall
  ${If} $kbPageShown == "1"
    ${If} $kbWantDesktop != ${BST_CHECKED}
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${EndIf}
    ${If} $kbWantStartMenu != ${BST_CHECKED}
      Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    ${EndIf}
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
