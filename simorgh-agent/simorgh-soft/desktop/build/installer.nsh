; Simorgh Design Suite — the installer's look, after the office's setup artwork.
;
; electron-builder puts this file ahead of its own NSIS script, so what is
; defined here is in place before the Modern UI pages are laid out:
;
;   Welcome  — the Simorgh over the lit globe beside it (installerSidebar.bmp)
;   License  — the EULA, with "I accept" as a checkbox, not two radio buttons
;   Install  — the logo in the header strip (installerHeader.bmp)
;   Finish   — the same artwork, and "Launch Simorgh Design Suite now"
;
; The header strip and the welcome and finish pages are drawn in the
; artwork's night blue with white text. The pages in between keep the
; system's own colours: their controls are Windows' and would not read on it.

!define MUI_BGCOLOR "01112A"
!define MUI_TEXTCOLOR "FFFFFF"

; Page settings are consumed by the next page of their kind, so these two
; reach the one license page.
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "I accept the terms of the License Agreement"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to the Simorgh Design Suite Setup Wizard"
  !define MUI_WELCOMEPAGE_TEXT "Professional Electrical Design Software$\r$\n$\r$\nThis wizard will install Simorgh Design Suite on your computer.$\r$\n$\r$\nClick Next to continue or Cancel to exit the setup.$\r$\n$\r$\n$\r$\nSimorgh Technology  |  All rights reserved."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; The finish page, as electron-builder's own (the same StartApp), with the
; wording of the artwork and a launch checkbox that can be read.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "Installation Completed"
  !define MUI_FINISHPAGE_TEXT "Simorgh Design Suite has been successfully installed on your computer.$\r$\n$\r$\n$\r$\nSimorgh Technology  |  All rights reserved."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Simorgh Design Suite now"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW simorghFinishShow
  !insertmacro MUI_PAGE_FINISH

  ; After the page: the checkbox's variable is declared by MUI_PAGE_FINISH.
  ; A themed checkbox takes its text colour from the Windows theme, not from
  ; the page, and would be black on the night blue. Unthemed, it takes the
  ; page's colours like the text around it.
  Function simorghFinishShow
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run , w " ", w " ")'
    SetCtlColors $mui.FinishPage.Run "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  FunctionEnd
!macroend
