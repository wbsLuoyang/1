' AI Hub 后台启动（无黑窗口）
' 由 install-autostart.bat 使用，也可以直接双击本文件启动服务
Dim fso, shell, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir

' 0 = 隐藏窗口, False = 不等待
shell.Run "cmd /c node server.js >> server.log 2>&1", 0, False
