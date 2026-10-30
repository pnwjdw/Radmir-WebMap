param([string]$Root)

$ErrorActionPreference = 'Stop'

function Say([string]$text) { Write-Host $text }

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }

$arch = $env:PROCESSOR_ARCHITEW6432
if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
$win = [Environment]::OSVersion.Version

if ($win.Major -lt 6 -or ($win.Major -eq 6 -and $win.Minor -lt 3)) {
  Say 'Эта версия Windows слишком старая: Node.js 18 и новее работает начиная с Windows 8.1.'
  exit 1
}

if ($win.Major -lt 10) {
  $version = 'v18.20.8'
  if ($arch -eq 'x86') { $platform = 'win-x86' } else { $platform = 'win-x64' }
} elseif ($arch -eq 'ARM64') {
  $version = 'v24.22.2'; $platform = 'win-arm64'
} elseif ($arch -eq 'x86') {
  $version = 'v22.23.4'; $platform = 'win-x86'
} else {
  $version = 'v24.22.2'; $platform = 'win-x64'
}

$name = "node-$version-$platform"
$base = "https://nodejs.org/dist/$version"
$runtime = Join-Path $Root 'runtime'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("radmir-node-" + [Guid]::NewGuid().ToString('N'))
$zip = Join-Path $temp "$name.zip"

try {
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $web = New-Object Net.WebClient
  $web.Headers.Add('User-Agent', 'radmir-map-viewer')

  Say "Скачиваю Node.js $version ($platform), около 30 МБ..."
  $web.DownloadFile("$base/$name.zip", $zip)

  Say 'Проверяю контрольную сумму...'
  $sums = $web.DownloadString("$base/SHASUMS256.txt")
  $line = ($sums -split "`n") | Where-Object { $_ -match ([Regex]::Escape("$name.zip") + '\s*$') } | Select-Object -First 1
  if (-not $line) { throw 'в SHASUMS256.txt нет строки для архива' }
  $expected = ($line.Trim() -split '\s+')[0].ToLower()
  $stream = [IO.File]::OpenRead($zip)
  try { $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($stream) } finally { $stream.Close() }
  $actual = -join ($hash | ForEach-Object { $_.ToString('x2') })
  if ($actual -ne $expected) { throw "контрольная сумма не совпала ($actual)" }

  Say 'Распаковываю node.exe...'
  $target = Join-Path $runtime 'node.exe'
  $done = $false
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
      $entry = $archive.Entries | Where-Object { $_.FullName -eq "$name/node.exe" } | Select-Object -First 1
      if ($entry) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true); $done = $true }
    } finally { $archive.Dispose() }
  } catch { }
  if (-not $done) {
    try {
      $shell = New-Object -ComObject Shell.Application
      $item = $shell.NameSpace("$zip\$name").ParseName('node.exe')
      if ($item) {
        if (Test-Path $target) { Remove-Item $target -Force }
        $shell.NameSpace($runtime).CopyHere($item, 20)
        for ($i = 0; $i -lt 120 -and -not (Test-Path $target); $i++) { Start-Sleep -Milliseconds 500 }
        $done = Test-Path $target
      }
    } catch { }
  }
  if (-not $done) {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
      & $tar -xf $zip -C $temp "$name/node.exe"
      $from = Join-Path $temp "$name\node.exe"
      if (Test-Path $from) { Copy-Item $from $target -Force; $done = $true }
    }
  }
  if (-not $done) { throw 'не удалось достать node.exe из архива' }

  $check = $null
  for ($i = 0; $i -lt 5 -and -not $check; $i++) {
    if ($i) { Start-Sleep -Seconds 2 }
    try {
      $out = & $target -e "process.stdout.write('ok:' + process.version)" 2>$null
      if ($LASTEXITCODE -eq 0 -and "$out" -match '^ok:(v[\d.]+)') { $check = $Matches[1] }
    } catch { }
  }
  if (-not $check) { throw 'скачанный node.exe не запускается' }
  Say "Готово: Node.js $check лежит в папке runtime и используется только этой программой."
  exit 0
} catch {
  Say ("Не получилось скачать Node.js: " + $_.Exception.Message)
  exit 1
} finally {
  if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
