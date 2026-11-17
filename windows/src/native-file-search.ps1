$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# 通过 Shell Known Folders API 读取当前路径，包含 OneDrive 与组策略重定向。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenAllKnownFolder {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    private static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    public static string Read(string value) {
        Guid id = new Guid(value); IntPtr result = IntPtr.Zero;
        try {
            // 不验证目录是否已创建，不创建目录，也不改变重定向设置。
            int code = SHGetKnownFolderPath(ref id, 0x4000, IntPtr.Zero, out result);
            if (code != 0) Marshal.ThrowExceptionForHR(code);
            return Marshal.PtrToStringUni(result);
        } finally { if (result != IntPtr.Zero) Marshal.FreeCoTaskMem(result); }
    }
}
'@
$script:connection = $null
function Read-KnownFolders {
    $identifiers = [ordered]@{
        Desktop='B4BFCC3A-DB2C-424C-B029-7FE99A87C641'
        Documents='FDD39AD0-238F-46AF-ADB4-6C85480369C7'
        Downloads='374DE290-123F-4565-9164-39C4925E467B'
        Pictures='33E28130-4E1E-4676-835A-98395C3BC3BB'
        Videos='18989B1D-99B5-455B-841C-AB7C74E4DDFC'
        Music='4BD8D571-6D19-48D3-BE97-422220080E43'
    }
    $folders = [System.Collections.Generic.List[object]]::new()
    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $identifiers.GetEnumerator()) {
        try { $value=[OpenAllKnownFolder]::Read($entry.Value);if ($value) {$folders.Add(@{name=$entry.Key;id=$entry.Value;path=$value})} }
        catch { $failures.Add($entry.Key+': '+$_.Exception.Message) }
    }
    return @{available=$folders.Count -gt 0;folders=@($folders.ToArray());paths=@($folders.ToArray() | ForEach-Object {$_.path} | Select-Object -Unique);errors=@($failures.ToArray())}
}
function Read-IndexedFiles($payload) {
    $service=Get-Service -Name WSearch -ErrorAction SilentlyContinue
    if ($null -eq $service) {return @{available=$false;code='service-missing';reason='未安装 Windows Search 服务，使用本地文件索引';rows=@()}}
    if ($service.Status -ne 'Running') {return @{available=$false;code='service-stopped';reason=('Windows Search 服务未运行（'+$service.Status+'），使用本地文件索引');rows=@()}}
    $recordset=$null;$command=$null
    try {
        if ($null -eq $script:connection -or $script:connection.State -eq 0) {
            $script:connection=New-Object -ComObject ADODB.Connection
            $script:connection.ConnectionTimeout=2
            $script:connection.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
        }
        # 不运行 PowerShell 命令文本；只执行 JS 固定模板构造的只读 SystemIndex SQL。
        $sql=[string]$payload.sql
        if ($sql.Length -gt 32768 -or $sql -notmatch '^SELECT TOP [0-9]+ System.ItemPathDisplay, System.FileName, System.ItemType, System.FileAttributes FROM SYSTEMINDEX WHERE ') {throw '无效的索引查询'}
        $command=New-Object -ComObject ADODB.Command
        $command.ActiveConnection=$script:connection
        $command.CommandType=1
        $command.CommandTimeout=3
        $command.CommandText=$sql
        $recordset=$command.Execute()
        $rows=[System.Collections.Generic.List[object]]::new()
        $maximum=[Math]::Min(1001,[Math]::Max(2,[int]$payload.limit+1))
        while (-not $recordset.EOF -and $rows.Count -lt $maximum) {
            $attributeValue=$recordset.Fields.Item('System.FileAttributes').Value
            $attributes=0;if ($null -ne $attributeValue -and $attributeValue -isnot [DBNull]) {$attributes=[long]$attributeValue}
            $rows.Add(@{path=[string]$recordset.Fields.Item('System.ItemPathDisplay').Value;name=[string]$recordset.Fields.Item('System.FileName').Value;itemType=[string]$recordset.Fields.Item('System.ItemType').Value;attributes=$attributes})
            $recordset.MoveNext()
        }
        return @{available=$true;code='ready';reason='当前用户可访问的 Windows Search 文件索引';rows=@($rows.ToArray())}
    } catch {
        if ($null -ne $script:connection) {try {$script:connection.Close()}catch{};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:connection);$script:connection=$null}
        return @{available=$false;code='provider-unavailable';reason=('Windows Search 索引查询不可用，使用本地文件索引：'+$_.Exception.Message);rows=@()}
    } finally {
        if ($null -ne $recordset) {try {$recordset.Close()}catch{};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($recordset)}
        if ($null -ne $command) {[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($command)}
    }
}
try {
    while ($null -ne ($line=[Console]::ReadLine())) {
        $id=$null
        try {
            $message=$line | ConvertFrom-Json;$id=$message.id
            switch ($message.action) {
                'knownFolders' {$result=Read-KnownFolders}
                'query' {$result=Read-IndexedFiles $message.payload}
                default {throw '未知文件搜索操作'}
            }
            [Console]::WriteLine((@{id=$id;result=$result} | ConvertTo-Json -Compress -Depth 8))
        } catch {[Console]::WriteLine((@{id=$id;error=$_.Exception.Message} | ConvertTo-Json -Compress -Depth 4))}
    }
} finally {
    if ($null -ne $script:connection) {try {$script:connection.Close()}catch{};[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:connection)}
}
