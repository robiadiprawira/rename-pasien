# Server web lokal sederhana (hanya untuk komputer ini). Tidak butuh instalasi di Windows.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='application/javascript'; '.css'='text/css';
  '.wasm'='application/wasm'; '.json'='application/json'; '.gz'='application/gzip'; '.png'='image/png'
}
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$port/")
try { $l.Start() } catch {
  Write-Host "Gagal memulai server di port $port. Mungkin aplikasi ini sudah berjalan di jendela lain."
  Read-Host "Tekan Enter untuk menutup"; exit 1
}
Write-Host "Rename File Pasien berjalan di http://localhost:$port/"
Write-Host "Biarkan jendela ini terbuka selama aplikasi dipakai. Tutup jendela ini untuk berhenti."
Start-Process "http://localhost:$port/index.html"
while ($l.IsListening) {
  $c = $l.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $c.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [IO.File]::ReadAllBytes($file)
      $c.Response.ContentLength64 = $bytes.Length
      $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else { $c.Response.StatusCode = 404 }
  } catch { $c.Response.StatusCode = 500 }
  $c.Response.Close()
}
