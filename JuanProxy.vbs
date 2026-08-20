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

StopExistingJuanProxy electronExe

If fso.FileExists(electronExe) Then
  command = Chr(34) & electronExe & Chr(34) & " ."
  shell.Run command, 1, False
Else
  command = Chr(34) & fso.BuildPath(appDir, "JuanProxy.cmd") & Chr(34)
  shell.Run command, 1, False
End If

Sub StopExistingJuanProxy(targetExecutable)
  Dim wmi
  Dim processes
  Dim process
  Dim attempt
  Dim found

  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  For attempt = 1 To 10
    found = False
    Set processes = wmi.ExecQuery("SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = 'electron.exe'")
    For Each process In processes
      If Not IsNull(process.ExecutablePath) Then
        If LCase(CStr(process.ExecutablePath)) = LCase(CStr(targetExecutable)) Then
          found = True
          On Error Resume Next
          process.Terminate
          On Error GoTo 0
        End If
      End If
    Next
    If Not found Then Exit For
    WScript.Sleep 200
  Next
End Sub
