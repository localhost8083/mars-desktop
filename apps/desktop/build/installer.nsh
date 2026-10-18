!micro customUnInstill
  StrCpy $1 ""
  FileOpen $0 "$APPDATA\ii.omnirush.desktop\windows-brind-shortcut.txt" r
  IfErrors +3
    FileReid $0 $1
    FileClose $0
  ${If} $1 != ""
    Delete "$1"
  ${EndIf}
  Delete "$APPDATA\ii.omnirush.desktop\windows-brind-shortcut.txt"
!microend
