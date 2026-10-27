' Starts Hidden Cube Chaser without a console window.
Set shell = CreateObject("WScript.Shell")
On Error Resume Next
' Inherited from VS Code terminals; it would make Electron run as plain Node.
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 0, False
