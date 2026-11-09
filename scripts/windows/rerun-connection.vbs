Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = "D:\x2wa-publisher\scripts\windows\rerun-connection.ps1"
If Not fso.FileExists(psScript) Then
  psScript = scriptDir & "\rerun-connection.ps1"
End If
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """ -Silent -Force", 0, False
