; Extra steps for the NSIS installer (electron-builder includes this file automatically).
;
; AI apps (Claude Desktop and others) start Cadrel's assistant server as a child process, and it runs as Cadrel.exe from the install folder. While it runs,
; Windows will not let an update replace that file, and the stock "is Cadrel running" check can lose a race with an AI app that starts it again. So before
; that check, the installer asks every such server to leave by writing a marker file next to the program; they watch for it and exit within a couple of
; seconds (packages/mcp/src/lifecycle.ts). A marker is only honoured when it is recent, and it is removed once the new files are in place.

!macro customInit
  Push $R7
  Push $R8
  Push $R9
  StrCpy $R9 "0"
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R8 != ""
    ClearErrors
    FileOpen $R7 "$R8\.cadrel-retire" w
    ${IfNot} ${Errors}
      FileClose $R7
      StrCpy $R9 "1"
    ${EndIf}
  ${EndIf}
  ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R8 != ""
    ClearErrors
    FileOpen $R7 "$R8\.cadrel-retire" w
    ${IfNot} ${Errors}
      FileClose $R7
      StrCpy $R9 "1"
    ${EndIf}
  ${EndIf}
  ${If} $R9 == "1"
    Sleep 3000 ; long enough for a running assistant server to notice the marker and exit
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

!macro customInstall
  Delete "$INSTDIR\.cadrel-retire"
!macroend
