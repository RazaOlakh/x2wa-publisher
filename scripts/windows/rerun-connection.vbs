Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & "D:\x2wa-publisher\scripts\windows\rerun-connection.ps1" & """ -Silent", 0, False
