#!/usr/bin/env python3
"""Render the silent, four-second RampPulse airport startup film."""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "frontend" / "assets" / "oto-splash.webm"
W, H, FPS, FRAMES = 1920, 1080, 60, 240


def point(t: float) -> tuple[float, float, float]:
    p0, p1, p2, p3 = (370, 665), (680, 335), (1190, 350), (1530, 500)
    u = 1 - t
    x = u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0]
    y = u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]
    dx = 3*u*u*(p1[0]-p0[0]) + 6*u*t*(p2[0]-p1[0]) + 3*t*t*(p3[0]-p2[0])
    dy = 3*u*u*(p1[1]-p0[1]) + 6*u*t*(p2[1]-p1[1]) + 3*t*t*(p3[1]-p2[1])
    return x, y, math.degrees(math.atan2(dy, dx)) + 90


def frame_svg(index: int) -> str:
    seconds = index / FPS
    progress = index / (FRAMES - 1)
    x, y, heading = point(progress)
    plane_alpha = min(1, progress * 5, (1 - progress) * 5)
    radar_angle = math.radians((seconds * 48) % 360)
    cx, cy, radius, half_wedge = 1170, 430, 405, 0.13
    a0, a1 = radar_angle-half_wedge, radar_angle+half_wedge
    q0 = (cx+radius*math.cos(a0), cy+radius*math.sin(a0))
    q1 = (cx+radius*math.cos(a1), cy+radius*math.sin(a1))
    sweep = f"M {cx} {cy} L {q0[0]:.2f} {q0[1]:.2f} A {radius} {radius} 0 0 1 {q1[0]:.2f} {q1[1]:.2f} Z"
    lights = "".join(
        f'<rect x="{470+i*53}" y="916" width="7" height="7" rx="1" fill="#f4b942" opacity="{.3+.65*(.5+.5*math.sin(seconds*3.2-i*.28)):.3f}"/>'
        for i in range(19)
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
  <linearGradient id="sky" x2=".92" y2="1"><stop stop-color="#080e18"/><stop offset=".55" stop-color="#0b1420"/><stop offset="1" stop-color="#07101a"/></linearGradient>
  <radialGradient id="radarGlow"><stop stop-color="#073b4a" stop-opacity=".34"/><stop offset=".6" stop-color="#092b38" stop-opacity=".17"/><stop offset="1" stop-color="#06111b" stop-opacity="0"/></radialGradient>
  <linearGradient id="sweepFill" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#06b6d4" stop-opacity=".01"/><stop offset="1" stop-color="#06b6d4" stop-opacity=".21"/></linearGradient>
  <linearGradient id="route" x1="0" x2="1"><stop stop-color="#f59e0b" stop-opacity=".36"/><stop offset=".56" stop-color="#06b6d4" stop-opacity=".9"/><stop offset="1" stop-color="#f3f7fb" stop-opacity=".4"/></linearGradient>
  <filter id="soft" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5"/></filter>
  <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse"><path d="M64 0H0V64" fill="none" stroke="#9bb5ce" stroke-opacity=".055" stroke-width="1"/></pattern>
  <pattern id="minor" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#9bb5ce" stroke-opacity=".018" stroke-width="1"/></pattern>
</defs>
<rect width="100%" height="100%" fill="url(#sky)"/><rect width="100%" height="100%" fill="url(#minor)"/><rect width="100%" height="100%" fill="url(#grid)"/>
<path d="M0 780H1920" stroke="#9bb5ce" stroke-opacity=".08"/><path d="M0 785H1920" stroke="#9bb5ce" stroke-opacity=".025"/>
<circle cx="{cx}" cy="{cy}" r="470" fill="url(#radarGlow)"/>
<g fill="none" stroke="#69a6bd" stroke-opacity=".13">
 <circle cx="{cx}" cy="{cy}" r="104"/><circle cx="{cx}" cy="{cy}" r="205"/><circle cx="{cx}" cy="{cy}" r="306"/><circle cx="{cx}" cy="{cy}" r="405"/>
 <path d="M765 {cy}H1575M{cx} 25V835" stroke-dasharray="2 10"/>
 <path d="M883 143 1457 717M1457 143 883 717" stroke-opacity=".06"/>
</g>
<path d="{sweep}" fill="url(#sweepFill)"/>
<path d="M {cx} {cy} L {cx+radius*math.cos(radar_angle):.2f} {cy+radius*math.sin(radar_angle):.2f}" stroke="#06b6d4" stroke-opacity=".38" stroke-width="1.5"/>
<circle cx="{cx}" cy="{cy}" r="3" fill="#69deec"/>
<!-- taxiway geometry -->
<g fill="none" stroke-linecap="round" stroke-linejoin="round">
 <path d="M215 550 370 507 518 558 687 523 855 583 1010 552 1194 600 1404 553 1670 608" stroke="#182b3a" stroke-width="31"/>
 <path d="M215 550 370 507 518 558 687 523 855 583 1010 552 1194 600 1404 553 1670 608" stroke="#577183" stroke-opacity=".32" stroke-width="1.4" stroke-dasharray="5 13"/>
 <path d="M446 360 558 420 652 379 754 439 851 404" stroke="#142635" stroke-width="21"/>
 <path d="M1044 295 1150 354 1255 324 1370 380 1479 342" stroke="#142635" stroke-width="21"/>
</g>
<!-- quiet aircraft stand outlines -->
<g fill="#0c1a27" stroke="#2c4659" stroke-opacity=".56" stroke-width="1.2">
 <path d="m245 582 45-10 18 46-45 10z"/><path d="m321 561 47-12 19 48-47 11z"/><path d="m405 574 44-11 18 46-44 11z"/><path d="m481 556 45-11 19 47-45 11z"/>
 <path d="m1314 572 49-12 18 48-49 12z"/><path d="m1400 551 48-12 19 49-48 11z"/><path d="m1489 572 44-11 18 45-44 11z"/><path d="m1568 553 49-12 18 48-49 12z"/>
</g>
<!-- flight path and endpoints -->
<path d="M370 665 C680 335 1190 350 1530 500" fill="none" stroke="#102b39" stroke-width="8" stroke-linecap="round" opacity=".75"/>
<path d="M370 665 C680 335 1190 350 1530 500" fill="none" stroke="url(#route)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="2 14"/>
<circle cx="370" cy="665" r="12" fill="#0a1722" stroke="#f59e0b" stroke-width="2"/><circle cx="370" cy="665" r="3" fill="#f59e0b"/>
<circle cx="1530" cy="500" r="13" fill="#08141e" stroke="#06b6d4" stroke-width="2"/><circle cx="1530" cy="500" r="4" fill="#9beaf2"/>
<text x="330" y="710" fill="#b8c3d0" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="2">ВЫЛЕТ  /  SVO</text>
<text x="1510" y="550" fill="#b8c3d0" font-family="DejaVu Sans, sans-serif" font-size="15" letter-spacing="2">ПЕРРОН  /  UUEE</text>
<!-- aircraft, positioned along the curved approach -->
<g transform="translate({x:.2f} {y:.2f}) rotate({heading:.2f})" opacity="{plane_alpha:.3f}">
 <path d="M0-52 7-14 48 13 48 20 8 8 5 37 19 49 19 55 0 47-19 55-19 49-5 37-8 8-48 20-48 13-7-14Z" fill="#dafbff" opacity=".22" filter="url(#soft)"/>
 <path d="M0-52 7-14 48 13 48 20 8 8 5 37 19 49 19 55 0 47-19 55-19 49-5 37-8 8-48 20-48 13-7-14Z" fill="#eefaff" stroke="#70d5e8" stroke-width="1.4"/>
</g>
<!-- runway threshold lights -->
<path d="M310 921H1610M410 952H1510" stroke="#375163" stroke-width="1" opacity=".7"/>
<path d="M350 937H1570" stroke="#587286" stroke-width="1" stroke-dasharray="22 20" opacity=".46"/>
{lights}
<!-- quiet telemetry, typography is baked into the film -->
<g font-family="DejaVu Sans Mono, monospace">
 <text x="112" y="112" fill="#edf5fb" font-size="29" letter-spacing="7">RampPulse</text>
 <text x="220" y="110" fill="#90a5b9" font-size="12" letter-spacing="3">AIRPORT OPERATIONS</text>
 <text x="113" y="142" fill="#698198" font-size="10" letter-spacing="2">SVO  /  UUEE  ·  LIVE APRON CONTROL</text>
 <text x="1640" y="112" fill="#7e94a9" font-size="11" letter-spacing="2">СВЯЗЬ</text><text x="1723" y="112" fill="#c1e7ed" font-size="11" letter-spacing="2">УСТАНОВЛЕНА</text>
 <text x="1640" y="140" fill="#536a80" font-size="10" letter-spacing="1">55°58′N  037°24′E</text>
 <text x="113" y="860" fill="#f4b942" font-size="11" letter-spacing="3">КОНТУР ДВИЖЕНИЯ</text>
 <text x="113" y="891" fill="#8193a7" font-size="10" letter-spacing="2">СЛЕДОВАНИЕ ПО МАРШРУТУ  /  ЗОНА ПЕРРОНА</text>
 <text x="1637" y="891" fill="#8193a7" font-size="10" letter-spacing="2">КУРС  {heading%360:03.0f}°</text>
</g>
<rect x="1" y="1" width="1918" height="1078" fill="none" stroke="#9ac4db" stroke-opacity=".12" stroke-width="2"/>
</svg>'''


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="oto-splash-") as temp:
        folder = Path(temp)
        for index in range(FRAMES):
            svg = folder / "frame.svg"
            png = folder / f"frame_{index:04d}.png"
            svg.write_text(frame_svg(index), encoding="utf-8")
            subprocess.run(["rsvg-convert", "-w", str(W), "-h", str(H), "-o", str(png), str(svg)], check=True)
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-framerate", str(FPS), "-i", str(folder / "frame_%04d.png"),
            "-an", "-c:v", "libvpx", "-deadline", "good", "-cpu-used", "2",
            "-crf", "28", "-b:v", "0", "-pix_fmt", "yuv420p", "-r", str(FPS), str(OUT),
        ], check=True)
    print(OUT)


if __name__ == "__main__":
    main()
