const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const src = path.join(root, "public", "icon.jpg");
const outDir = path.join(root, "build");
const pngPath = path.join(outDir, "icon.png");
const icoPath = path.join(outDir, "icon.ico");
const brandPath = path.join(root, "src", "brand.png");
const sizes = [16, 24, 32, 48, 64, 128, 256];

if (!fs.existsSync(src)) {
  throw new Error(`missing ${src}`);
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
$sizes = @(${sizes.join(",")})

function CopyHigh($srcImg, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($srcImg, (New-Object System.Drawing.Rectangle 0, 0, $w, $h))
  $g.Dispose()
  return $bmp
}

$img = [System.Drawing.Image]::FromFile($src)
$w = $img.Width
$h = $img.Height
$bmpSrc = New-Object System.Drawing.Bitmap $img
$img.Dispose()

$corner = $bmpSrc.GetPixel(2, 2)
function Far($c) {
  $dr = [Math]::Abs([int]$c.R - [int]$corner.R)
  $dg = [Math]::Abs([int]$c.G - [int]$corner.G)
  $db = [Math]::Abs([int]$c.B - [int]$corner.B)
  return ($dr + $dg + $db) -gt 36
}

$minX = $w; $minY = $h; $maxX = 0; $maxY = 0
$step = [Math]::Max(1, [int]($w / 280))
for ($y = 0; $y -lt $h; $y += $step) {
  for ($x = 0; $x -lt $w; $x += $step) {
    if (Far $bmpSrc.GetPixel($x, $y)) {
      if ($x -lt $minX) { $minX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}

$minX = [Math]::Max(0, $minX - $step * 2)
$minY = [Math]::Max(0, $minY - $step * 2)
$maxX = [Math]::Min($w - 1, $maxX + $step * 2)
$maxY = [Math]::Min($h - 1, $maxY + $step * 2)
$boxW = $maxX - $minX
$boxH = $maxY - $minY
$use = $bmpSrc
if ($boxW -gt 8 -and $boxH -gt 8 -and ($boxW -lt $w * 0.9 -or $boxH -lt $h * 0.9)) {
  $pad = [int]([Math]::Max($boxW, $boxH) * 0.14)
  $x = [Math]::Max(0, $minX - $pad)
  $y = [Math]::Max(0, $minY - $pad)
  $cw = [Math]::Min($w - $x, $boxW + $pad * 2)
  $ch = [Math]::Min($h - $y, $boxH + $pad * 2)
  $side = [Math]::Max($cw, $ch)
  $cx = [Math]::Max(0, [Math]::Min($w - $side, $x - [int](($side - $cw) / 2)))
  $cy = [Math]::Max(0, [Math]::Min($h - $side, $y - [int](($side - $ch) / 2)))
  $side = [Math]::Min($side, [Math]::Min($w - $cx, $h - $cy))
  $use = $bmpSrc.Clone((New-Object System.Drawing.Rectangle $cx, $cy, $side, $side), $bmpSrc.PixelFormat)
}

$fit = 0.78
$content = [Math]::Max($use.Width, $use.Height)
$canvasSide = [Math]::Max($content + 8, [int]($content / $fit))
$canvas = New-Object System.Drawing.Bitmap $canvasSide, $canvasSide
$cg = [System.Drawing.Graphics]::FromImage($canvas)
$cg.Clear($corner)
$cg.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$cg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$dx = [int](($canvasSide - $use.Width) / 2)
$dy = [int](($canvasSide - $use.Height) / 2)
$cg.DrawImage($use, $dx, $dy, $use.Width, $use.Height)
$cg.Dispose()
$master = CopyHigh $canvas 1024 1024
$canvas.Dispose()
$icon256 = CopyHigh $master 256 256
$icon256.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Save($brand, [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Dispose()

foreach ($s in $sizes) {
  $frame = CopyHigh $master $s $s
  $frame.Save((Join-Path $work "$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $frame.Dispose()
}

$master.Dispose()
if ($use -ne $bmpSrc) { $use.Dispose() }
$bmpSrc.Dispose()
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
console.log("wrote", pngPath);
console.log("wrote", icoPath);
console.log("wrote", brandPath);
