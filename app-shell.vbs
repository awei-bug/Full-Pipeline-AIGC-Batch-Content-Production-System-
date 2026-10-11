' Runs the app without flashing a console window.
' Usage: wscript.exe app-shell.vbs [start|stop]
Option Explicit

Dim shell, fso, root, action, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
  action = LCase(WScript.Arguments(0))
Else
  action = "start"
End If

If action = "stop" Then
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
    & root & "\scripts\stop-app.ps1"""
Else
  command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ _
    & root & "\scripts\launch-app-shell.ps1"""
End If

' 0 = hidden window, False = do not wait for the child process
shell.Run command, 0, False
