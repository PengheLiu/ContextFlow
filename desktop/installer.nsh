!include "WinVer.nsh"

!macro customInit
  ; Match the bundled Electron/Node runtime, rather than installing successfully
  ; on a system where the companion can never start.
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "ContextFlow requires Windows 10 or later."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ; Only remove the host registration if it still belongs to this installation.
  ReadRegStr $0 HKCU "Software\Google\Chrome\NativeMessagingHosts\io.github.pengheliu.contextflow" ""
  ${If} $0 == "$INSTDIR\resources\native-messaging.json"
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\io.github.pengheliu.contextflow"
  ${EndIf}
  ${IfNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ContextFlow"
    ${If} $0 == '"$INSTDIR\ContextFlow.exe" --hidden'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ContextFlow"
    ${EndIf}
  ${EndIf}
!macroend
