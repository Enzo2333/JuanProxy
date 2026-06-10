Option Explicit

Dim shell
Dim fso
Dim appDir
Dim electronCmd
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronCmd = fso.BuildPath(appDir, "node_modules\.bin\electron.cmd")
shell.CurrentDirectory = appDir

If fso.FileExists(electronCmd) Then
  command = Chr(34) & electronCmd & Chr(34) & " ."
  shell.Run command, 1, False
Else
  command = Chr(34) & fso.BuildPath(appDir, "JuanProxy.cmd") & Chr(34)
  shell.Run command, 1, False
End If
