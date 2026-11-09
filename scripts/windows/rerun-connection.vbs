Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appData = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%")
psScript = appData & "\x-whatsapp-poster\rerun-connection.ps1"
If Not fso.FileExists(psScript) Then
  psScript = "D:\x2wa-publisher\scripts\windows\rerun-connection.ps1"
End If
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """ -Silent", 0, False
