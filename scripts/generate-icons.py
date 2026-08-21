#!/usr/bin/env python3
"""
Generate app icons from a source JPEG.

Usage:
    python3 scripts/generate-icons.py

Reads fund01.jpeg at the repo root, removes the white background, and
regenerates:
  - icon.png (repo root)
  - apps/chrome/public/icons/icon-{16,48,128}.png
  - apps/chrome/dist/icons/icon-{16,48,128}.png
  - apps/tauri/src-tauri/icons/* (PNG sizes, icon.icns, icon.ico, plus Android/iOS)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_JPEG = REPO_ROOT / "fund01.jpeg"
MASTER_PNG = REPO_ROOT / "icon.png"

CHROME_PUBLIC_DIR = REPO_ROOT / "apps" / "chrome" / "public" / "icons"
CHROME_DIST_DIR = REPO_ROOT / "apps" / "chrome" / "dist" / "icons"
TAURI_ICONS_DIR = REPO_ROOT / "apps" / "tauri" / "src-tauri" / "icons"

CHROME_SIZES = [16, 48, 128]

TAURI_PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 1024,
}

WINDOWS_SQUARE_SIZES = {
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}

STORE_LOGO_SIZE = {"StoreLogo.png": 50}

ANDROID_SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

IOS_SIZES = [
    (20, 1),
    (20, 2),
    (20, 3),
    (29, 1),
    (29, 2),
    (29, 3),
    (40, 1),
    (40, 2),
    (40, 3),
    (60, 2),
    (60, 3),
    (76, 1),
    (76, 2),
    (83.5, 2),
    (512, 2),  # AppIcon-512@2x is 1024x1024
]


def remove_white_background(src: Image.Image) -> Image.Image:
    """Remove the white/light background from a JPEG icon source."""
    img = src.convert("RGBA")

    # Strategy: build a binary mask of the connected white-ish background,
    # then dilate it slightly to swallow anti-aliased JPEG edge pixels.
    gray = img.convert("L")

    # White-ish pixels. JPEG background is ~255, anti-aliased edges ~200-240.
    mask = gray.point(lambda p: 255 if p > 220 else 0, mode="1")

    # Flood fill from each corner so we only remove the outer background,
    # not any bright highlights inside the icon.
    from PIL import ImageDraw

    draw = ImageDraw.Draw(mask)
    w, h = mask.size
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    for x, y in corners:
        if mask.getpixel((x, y)) == 255:
            ImageDraw.floodfill(mask, xy=(x, y), value=128)

    # 128 = visited background during flood fill. Convert to a clean mask.
    mask = mask.point(lambda p: 255 if p == 128 else 0, mode="L")

    # Dilate by 2 px to remove the gray halo around the icon.
    mask = mask.filter(ImageFilter.MaxFilter(5))  # 5x5 max filter ~= radius 2

    # Apply mask to alpha channel.
    r, g, b, a = img.split()
    a = ImageChops.multiply(a, mask.point(lambda p: 255 - p))
    img.putalpha(a)

    return img


def resize_preserve_aspect(src: Image.Image, size: int, padding: float = 0.0) -> Image.Image:
    """Resize to fit inside a square of `size`, preserving aspect ratio."""
    src = src.convert("RGBA")
    if padding:
        canvas_size = size
        target_size = int(size * (1 - 2 * padding))
        src.thumbnail((target_size, target_size), Image.LANCZOS)
        canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
        x = (canvas_size - src.width) // 2
        y = (canvas_size - src.height) // 2
        canvas.paste(src, (x, y), src)
        return canvas
    else:
        return src.resize((size, size), Image.LANCZOS)


def generate_tauri_ico(src: Image.Image, path: Path) -> None:
    """Generate a Windows .ico containing common sizes."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [src.resize((s, s), Image.LANCZOS) for s in sizes]
    # Save the largest first, append the rest so all sizes are embedded.
    imgs[-1].save(
        path,
        format="ICO",
        append_images=imgs[:-1],
        sizes=[(s, s) for s in sizes],
    )


def generate_icns(src: Image.Image, path: Path) -> None:
    """Generate a macOS .icns using iconutil."""
    iconset = tempfile.mkdtemp(suffix=".iconset")
    try:
        sizes = [16, 32, 128, 256, 512]
        for s in sizes:
            img = src.resize((s, s), Image.LANCZOS)
            img.save(Path(iconset) / f"icon_{s}x{s}.png")
            img2 = src.resize((s * 2, s * 2), Image.LANCZOS)
            img2.save(Path(iconset) / f"icon_{s}x{s}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", str(path)], check=True)
    finally:
        shutil.rmtree(iconset)


def generate_android(src: Image.Image, base_dir: Path) -> None:
    """Regenerate Android launcher icons."""
    for folder, size in ANDROID_SIZES.items():
        d = base_dir / folder
        d.mkdir(parents=True, exist_ok=True)
        # launcher / round / foreground all get the same icon for now.
        img = resize_preserve_aspect(src, size, padding=0.05)
        img.save(d / "ic_launcher.png")
        img.save(d / "ic_launcher_round.png")
        img.save(d / "ic_launcher_foreground.png")


def generate_ios(src: Image.Image, base_dir: Path) -> None:
    """Regenerate iOS app icon set."""
    base_dir.mkdir(parents=True, exist_ok=True)
    for base, scale in IOS_SIZES:
        size = int(base * scale)
        name = f"AppIcon-{base}x{base}@{scale}x.png"
        if base == 512 and scale == 2:
            name = "AppIcon-512@2x.png"
        img = resize_preserve_aspect(src, size)
        img.save(base_dir / name)


def main() -> None:
    if not SOURCE_JPEG.exists():
        raise FileNotFoundError(f"Source icon not found: {SOURCE_JPEG}")

    print(f"Loading {SOURCE_JPEG} ...")
    src = Image.open(SOURCE_JPEG)
    print(f"Source size: {src.size}")

    print("Removing white background ...")
    icon = remove_white_background(src)

    print(f"Saving master transparent PNG -> {MASTER_PNG}")
    icon.save(MASTER_PNG)

    # Chrome
    CHROME_PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    CHROME_DIST_DIR.mkdir(parents=True, exist_ok=True)
    for size in CHROME_SIZES:
        img = resize_preserve_aspect(icon, size)
        img.save(CHROME_PUBLIC_DIR / f"icon-{size}.png")
        img.save(CHROME_DIST_DIR / f"icon-{size}.png")
        print(f"Generated Chrome icon-{size}.png")

    # Tauri PNG sizes
    TAURI_ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for filename, size in TAURI_PNG_SIZES.items():
        img = resize_preserve_aspect(icon, size)
        img.save(TAURI_ICONS_DIR / filename)
        print(f"Generated Tauri {filename}")

    # Windows square / store logos
    for filename, size in {**WINDOWS_SQUARE_SIZES, **STORE_LOGO_SIZE}.items():
        img = resize_preserve_aspect(icon, size)
        img.save(TAURI_ICONS_DIR / filename)
        print(f"Generated Tauri {filename}")

    # .ico
    generate_tauri_ico(icon, TAURI_ICONS_DIR / "icon.ico")
    print("Generated Tauri icon.ico")

    # .icns
    generate_icns(icon, TAURI_ICONS_DIR / "icon.icns")
    print("Generated Tauri icon.icns")

    # Android
    generate_android(icon, TAURI_ICONS_DIR / "android")
    print("Generated Android icons")

    # iOS
    generate_ios(icon, TAURI_ICONS_DIR / "ios")
    print("Generated iOS icons")

    print("Done.")


if __name__ == "__main__":
    main()
