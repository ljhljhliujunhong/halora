const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const srcPng = path.join(root, "public", "icon.png");
const srcJpg = path.join(root, "public", "icon.jpg");
const src = fs.existsSync(srcPng) ? srcPng : srcJpg;
const outDir = path.join(root, "build");
const pngPath = path.join(outDir, "icon.png");
const icoPath = path.join(outDir, "icon.ico");
const brandPath = path.join(root, "src", "brand.png");
const sizes = [16, 24, 32, 48, 64, 128, 256];

if (!fs.existsSync(src)) {
  throw new Error(`missing ${srcPng}`);
}

fs.mkdirSync(outDir, { recursive: true });

const workDir = path.join(outDir, "ico-frames");
fs.mkdirSync(workDir, { recursive: true });

const ps = `
Add-Type -AssemblyName System.Drawing
$src = ${JSON.stringify(src)}
$png = ${JSON.stringify(pngPath)}
$brand = ${JSON.stringify(brandPath)}
$work = ${JSON.stringify(workDir)}
$launcherIco = ${JSON.stringify(path.join(outDir, "launcher.ico"))}
$sizes = @(${sizes.join(",")})
$fmt = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$transparent = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)

function CopyHigh($srcImg, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, $fmt
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear($transparent)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($srcImg, (New-Object System.Drawing.Rectangle 0, 0, $w, $h))
  $g.Dispose()
  return $bmp
}

function IsGold($c) {
  if ($c.A -lt 120) { return $false }
  $r = [int]$c.R; $g = [int]$c.G; $b = [int]$c.B
  return ($r -ge 200 -and $g -ge 140 -and $r -ge ($b + 40) -and $g -ge ($b + 20))
}

function CleanSpecks($bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, $fmt)
  $bytes = New-Object byte[] ($data.Stride * $h)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  for ($i = 3; $i -lt $bytes.Length; $i += 4) {
    if ($bytes[$i] -lt 12) { $bytes[$i] = 0 }
  }
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
  $bmp.UnlockBits($data)
}

function MatteCircle($bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $cx = ($w - 1) / 2.0
  $cy = ($h - 1) / 2.0
  $half = [Math]::Min($cx, $cy)
  $rOpaque = $half * 0.99
  $rClear = $half * 0.999
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite, $fmt)
  $bytes = New-Object byte[] ($data.Stride * $h)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $data.Stride
    $dy = $y - $cy
    for ($x = 0; $x -lt $w; $x++) {
      $i = $row + $x * 4
      $dx = $x - $cx
      $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
      $a = [int]$bytes[$i + 3]
      if ($d -ge $rClear) { $a = 0 }
      elseif ($d -gt $rOpaque) { $a = [int]($a * (($rClear - $d) / ($rClear - $rOpaque))) }
      if ($a -lt 12) { $a = 0 }
      $bytes[$i + 3] = [byte]$a
    }
  }
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
  $bmp.UnlockBits($data)
}

function CropSquare($img, $gx, $gy, $half) {
  $side = [Math]::Max(32, [int][Math]::Round(2 * $half))
  $x0 = [int][Math]::Round($gx - $side / 2.0)
  $y0 = [int][Math]::Round($gy - $side / 2.0)
  $crop = New-Object System.Drawing.Bitmap $side, $side, $fmt
  $crop.SetResolution(96, 96)
  $cg = [System.Drawing.Graphics]::FromImage($crop)
  $cg.Clear($transparent)
  $cg.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $cg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $cg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $cg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $cg.DrawImage($img, -$x0, -$y0)
  $cg.Dispose()
  return $crop
}

$img = New-Object System.Drawing.Bitmap $src
$w = $img.Width
$h = $img.Height
$cx = ($w - 1) / 2.0
$cy = ($h - 1) / 2.0
$maxR = [Math]::Min($cx, $cy)
$c0 = $img.GetPixel(0, 0).A
$c1 = $img.GetPixel(($w - 1), 0).A
$c2 = $img.GetPixel(0, ($h - 1)).A
$c3 = $img.GetPixel(($w - 1), ($h - 1)).A
$cornerA = ($c0 + $c1 + $c2 + $c3) / 4.0

if ($cornerA -lt 24) {
  $sumX = 0.0; $sumY = 0.0; $n = 0
  $step = 3
  for ($y = 0; $y -lt $h; $y += $step) {
    for ($x = 0; $x -lt $w; $x += $step) {
      if ($img.GetPixel($x, $y).A -gt 40) { $sumX += $x; $sumY += $y; $n++ }
    }
  }
  if ($n -lt 16) { throw "opaque mark not found" }
  $gx = $sumX / $n
  $gy = $sumY / $n
  $outerR = 0.0
  for ($deg = 0; $deg -lt 360; $deg += 3) {
    $rad = $deg * [Math]::PI / 180.0
    $dx = [Math]::Cos($rad)
    $dy = [Math]::Sin($rad)
    $last = 0.0
    for ($r = [int]($maxR * 0.2); $r -le $maxR; $r++) {
      $x = [int][Math]::Round($gx + $dx * $r)
      $y = [int][Math]::Round($gy + $dy * $r)
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { break }
      if ($img.GetPixel($x, $y).A -gt 32) { $last = $r }
    }
    if ($last -gt $outerR) { $outerR = $last }
  }
  $crop = CropSquare $img $gx $gy ($outerR * 1.02)
} else {
  $sumX = 0.0; $sumY = 0.0; $nGold = 0
  $fromCenter = New-Object System.Collections.Generic.List[double]
  for ($deg = 0; $deg -lt 360; $deg += 4) {
    $rad = $deg * [Math]::PI / 180.0
    $dx = [Math]::Cos($rad)
    $dy = [Math]::Sin($rad)
    $inner = -1.0
    $outer = -1.0
    for ($r = [int]($maxR * 0.62); $r -le $maxR; $r++) {
      $x = [int][Math]::Round($cx + $dx * $r)
      $y = [int][Math]::Round($cy + $dy * $r)
      if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { break }
      if (IsGold ($img.GetPixel($x, $y))) {
        if ($inner -lt 0) { $inner = $r }
        $outer = $r
      }
    }
    if ($outer -gt 0) {
      $mid = ($inner + $outer) / 2.0
      $sumX += $cx + $dx * $mid
      $sumY += $cy + $dy * $mid
      $nGold++
      $fromCenter.Add($outer)
    }
  }
  if ($nGold -lt 8) { throw "gold ring not found" }
  $gx = $sumX / $nGold
  $gy = $sumY / $nGold
  $sorted = $fromCenter.ToArray()
  [Array]::Sort($sorted)
  $pick = [Math]::Max(0, [int][Math]::Floor($sorted.Length * 0.88) - 1)
  $crop = CropSquare $img $gx $gy ($sorted[$pick] * 1.045)
}

$img.Dispose()
$master = CopyHigh $crop 1024 1024
$crop.Dispose()
CleanSpecks $master
MatteCircle $master

$icon256 = CopyHigh $master 256 256
$icon256.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Save($brand, [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Dispose()

foreach ($s in $sizes) {
  if ($s -le 32) {
    $hi = CopyHigh $master ($s * 4) ($s * 4)
    $frame = CopyHigh $hi $s $s
    $hi.Dispose()
  } else {
    $frame = CopyHigh $master $s $s
  }
  $frame.Save((Join-Path $work "$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $frame.Dispose()
}

$dibs = New-Object System.Collections.Generic.List[object]
foreach ($s in $sizes) {
  $frame = New-Object System.Drawing.Bitmap (Join-Path $work "$s.png")
  $w = $frame.Width
  $h = $frame.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $frame.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $fmt)
  $raw = New-Object byte[] ($data.Stride * $h)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $stride = $data.Stride
  $frame.UnlockBits($data)
  $frame.Dispose()
  $xor = New-Object byte[] ($w * $h * 4)
  $rowMask = [int][Math]::Ceiling($w / 32.0) * 4
  $and = New-Object byte[] ($rowMask * $h)
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $si = $y * $stride + $x * 4
      $di = (($h - 1 - $y) * $w + $x) * 4
      $xor[$di] = $raw[$si]
      $xor[$di + 1] = $raw[$si + 1]
      $xor[$di + 2] = $raw[$si + 2]
      $xor[$di + 3] = $raw[$si + 3]
      if ($raw[$si + 3] -lt 128) {
        $byteIndex = ($h - 1 - $y) * $rowMask + [int][Math]::Floor($x / 8)
        $and[$byteIndex] = $and[$byteIndex] -bor [byte](1 -shl (7 - ($x % 8)))
      }
    }
  }
  $hdr = New-Object byte[] 40
  [BitConverter]::GetBytes([int]40).CopyTo($hdr, 0)
  [BitConverter]::GetBytes([int]$w).CopyTo($hdr, 4)
  [BitConverter]::GetBytes([int]($h * 2)).CopyTo($hdr, 8)
  [BitConverter]::GetBytes([int16]1).CopyTo($hdr, 12)
  [BitConverter]::GetBytes([int16]32).CopyTo($hdr, 14)
  [BitConverter]::GetBytes([int]0).CopyTo($hdr, 16)
  [BitConverter]::GetBytes([int]$xor.Length).CopyTo($hdr, 20)
  $blob = New-Object byte[] ($hdr.Length + $xor.Length + $and.Length)
  [Array]::Copy($hdr, 0, $blob, 0, $hdr.Length)
  [Array]::Copy($xor, 0, $blob, $hdr.Length, $xor.Length)
  [Array]::Copy($and, 0, $blob, $hdr.Length + $xor.Length, $and.Length)
  $dibs.Add(@{ w = $w; h = $h; data = $blob })
}

$count = $dibs.Count
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$count)
$offset = 6 + 16 * $count
foreach ($dib in $dibs) {
  $bw.Write([byte]$(if ($dib.w -ge 256) { 0 } else { $dib.w }))
  $bw.Write([byte]$(if ($dib.h -ge 256) { 0 } else { $dib.h }))
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$dib.data.Length)
  $bw.Write([uint32]$offset)
  $offset += $dib.data.Length
}
foreach ($dib in $dibs) { $bw.Write($dib.data) }
$bw.Flush()
[IO.File]::WriteAllBytes($launcherIco, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()

$master.Dispose()
`;

const result = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
  encoding: "utf8",
  windowsHide: true,
});
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || "icon png convert failed");
}

function writeIco(entries, dest) {
  const count = entries.length;
  const headerSize = 6 + 16 * count;
  let offset = headerSize;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const chunks = [header];
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    header.writeUInt8(entry.width >= 256 ? 0 : entry.width, at);
    header.writeUInt8(entry.height >= 256 ? 0 : entry.height, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(entry.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    chunks.push(entry.png);
    offset += entry.png.length;
  });
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

const entries = sizes.map((size) => ({
  width: size,
  height: size,
  png: fs.readFileSync(path.join(workDir, `${size}.png`)),
}));
writeIco(entries, icoPath);
const launcherIco = path.join(outDir, "launcher.ico");
if (!fs.existsSync(launcherIco)) throw new Error("missing launcher.ico");
console.log("wrote", pngPath);
console.log("wrote", icoPath);
console.log("wrote", launcherIco);
console.log("wrote", brandPath);
