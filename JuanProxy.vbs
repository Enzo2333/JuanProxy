Option Explicit

Dim shell
Dim fso
Dim appDir
Dim electronExe
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")
shell.CurrentDirectory = appDir

If fso.FileExists(electronExe) Then
  command = Chr(34) & electronExe & Chr(34) & " ."
  shell.Run command, 1, False
Else
  command = Chr(34) & fso.BuildPath(appDir, "JuanProxy.cmd") & Chr(34)
  shell.Run command, 1, False
End If
