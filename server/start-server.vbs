' Hermes 网页助手 - 开机自启动
' 静默调用 ensure-server-running.py（自动探测 Python，无窗口无控制台）
Dim fso, baseDir, shell, exec
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

' 探测 pythonw：存在则用（无窗口），否则回退 python
Set exec = shell.Exec("where pythonw")
If exec.StdOut.AtEndOfStream Then
    shell.Run "python """ & baseDir & "\ensure-server-running.py""", 0, False
Else
    shell.Run "pythonw """ & baseDir & "\ensure-server-running.py""", 0, False
End If
