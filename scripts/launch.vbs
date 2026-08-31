' Zhuxing Harness hidden launcher: starts the web service without a console window.
' Located in <install>\bin\launch.vbs; walks up two levels to find the install root.
Dim fso, shell, base, node, launcher
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = base & "\node\node.exe"
launcher = base & "\bin\web-launcher.mjs"
shell.Run """" & node & """ """ & launcher & """", 0, False
