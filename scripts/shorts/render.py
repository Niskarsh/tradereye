"""
Renders one Short / Reel (1080x1920, 30 fps, H.264 + AAC) from a spec made by tradereye (lib/shorts/spec.ts).

    python scripts/shorts/render.py spec.json out.mp4 poster.jpg

Everything shown comes from the spec: real candles, real fills, the journal's own result. Nothing is made up here;
the script only decides pacing and drawing. Layout keeps text out of the bottom ~20% and the right edge, where
YouTube and Instagram draw their own captions and buttons.

Needs: Pillow, numpy, ffmpeg on PATH. Fonts: Inter (scripts/shorts/fonts, OFL).
"""
import json, math, os, subprocess, sys, wave
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1080, 1920, 30
K = W / 720  # layouts below are written for a 720x1280 canvas and scaled
FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
_fonts = {}


def F(weight, size):
    weight = {"Medium": "SemiBold", "ExtraBold": "Black"}.get(weight, weight)
    key = (weight, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(FONT_DIR, f"Inter-{weight}.otf"), int(size * K))
    return _fonts[key]


def u(x):
    return int(round(x * K))


BG = (15, 15, 14); PANEL = (24, 24, 22); GRID = (38, 38, 35)
TXT = (243, 239, 230); MUTED = (138, 134, 124)
GOLD = (212, 166, 58); EM = (31, 157, 110); RED = (181, 71, 63); DARKGOLD = (40, 34, 20)
IST = timezone(timedelta(hours=5, minutes=30))


def lerp(a, b, t): return a + (b - a) * t
def ease(t): t = max(0.0, min(1.0, t)); return t * t * (3 - 2 * t)
def mix(c1, c2, t): t = max(0.0, min(1.0, t)); return tuple(int(lerp(a, b, t)) for a, b in zip(c1, c2))
def T(d, xy, s, font, fill, anchor="mm"): d.text((u(xy[0]), u(xy[1])), s, font=font, fill=fill, anchor=anchor)
def dim(img, a): return Image.blend(img, Image.new("RGB", img.size, (0, 0, 0)), max(0.0, min(1.0, a)))
def hhmm(sec): return datetime.fromtimestamp(sec, IST).strftime("%H:%M")


def pill(d, cx, cy, w, h, label, col, font, txt=TXT):
    d.rounded_rectangle([u(cx - w / 2), u(cy - h / 2), u(cx + w / 2), u(cy + h / 2)], radius=u(h / 2), fill=col)
    T(d, (cx, cy), label, font, txt)


def dashed(d, x0, x1, y, col, w=2, dash=10, gap=7):
    x = x0
    while x < x1:
        d.line([(u(x), u(y)), (u(min(x + dash, x1)), u(y))], fill=col, width=max(1, u(w)))
        x += dash + gap


def fmt_result(value, unit, decimals=1):
    if unit == "R":
        return f"{value:+.{decimals}f}R".replace("-", "−")
    return f"{value:+.2f}%".replace("-", "−")


def minute_path(o, h, l, c):
    """The path traced inside one minute: a green minute dips to its low before its high, a red one the reverse
    (only O, H, L, C are known; the order of H and L inside the minute is the usual assumption)."""
    return (o, l, h, c) if c >= o else (o, h, l, c)


def path_at(o, h, l, c, f):
    """(price, high so far, low so far) at fraction f of the minute."""
    pts = minute_path(o, h, l, c)
    f = max(0.0, min(1.0, f)); seg = f * 3; j = min(2, int(seg)); k = seg - j
    price = lerp(pts[j], pts[j + 1], k)
    seen = pts[: j + 1] + (price,)
    return price, max(seen), min(seen)


class Chart:
    """One panel. `candles` are 1-minute [t, o, h, l, c]; they are drawn as `tf`-minute candles (5) that FORM LIVE:
    `upto` is a time in minutes (fractional), and the open candle's body and wicks follow the price as it moves
    through each minute, until its `tf` minutes are over and the next one starts."""

    OPEN = 9 * 3600 + 15 * 60

    def __init__(self, box, panel):
        self.box = box
        self.p = panel
        self.cs = panel["candles"]
        self.n = len(self.cs)
        self.tf = max(1, int(panel.get("tf", 5)))
        ist = lambda t: (t + 19800) % 86400
        first = (ist(self.cs[0][0]) - self.OPEN) // (self.tf * 60)
        self.slot = [int((ist(c[0]) - self.OPEN) // (self.tf * 60) - first) for c in self.cs]
        self.slots = self.slot[-1] + 1
        self.cols = self.slots + 1   # one empty column on the right: the exit marker and price tag never hang off the edge
        self.first = int(first)      # slot of the first candle, counted from 09:15

    def yrange(self, i0=0, i1=None, extra=()):
        cs = self.cs[i0:i1 if i1 is not None else self.n]
        lo = min(c[3] for c in cs); hi = max(c[2] for c in cs)
        for x in extra:
            if x: lo = min(lo, x); hi = max(hi, x)
        pad = (hi - lo) * 0.12 or hi * 0.002
        return lo - pad, hi + pad

    def state(self, upto):
        """The candles drawn at `upto`: finished ones whole, the forming one live; plus the current price."""
        upto = max(0.0, min(float(self.n), upto))
        k = int(upto); f = upto - k
        bars = {}
        for i in range(min(k, self.n)):
            t, o, h, l, c = self.cs[i]
            s = self.slot[i]
            if s in bars:
                b = bars[s]; b[1] = max(b[1], h); b[2] = min(b[2], l); b[3] = c
            else:
                bars[s] = [o, h, l, c]
        price = self.cs[k - 1][4] if k > 0 else self.cs[0][1]
        if k < self.n and f > 0:
            t, o, h, l, c = self.cs[k]
            price, hi, lo = path_at(o, h, l, c, f)
            s = self.slot[k]
            if s in bars:
                b = bars[s]; b[1] = max(b[1], hi); b[2] = min(b[2], lo); b[3] = price
            else:
                bars[s] = [o, hi, lo, price]
        return bars, price

    AXIS = 30  # the time axis strip at the bottom of every panel

    def slot_time(self, s):
        m = 9 * 60 + 15 + (self.first + s) * self.tf
        return m, f"{m // 60:02d}:{m % 60:02d}"

    def draw(self, d, upto, yr, labels=True, live=True):
        x0, y0, x1, yb = self.box
        d.rectangle([u(x0), u(y0), u(x1), u(yb)], fill=PANEL)
        y1 = yb - self.AXIS   # candles above the time axis
        lo, hi = yr
        py = lambda p: y1 - (p - lo) / (hi - lo) * (y1 - y0)
        # vertical grid + time labels: every 15 / 30 / 60 minutes depending on how much of the day is shown
        span = self.slots * self.tf
        step = 15 if span <= 90 else 30 if span <= 240 else 60
        d.line([(u(x0), u(y1)), (u(x1), u(y1))], fill=GRID, width=1)
        for sl in range(self.slots):
            m, label = self.slot_time(sl)
            if m % step: continue
            x = self.slot_x(sl)
            d.line([(u(x), u(y0)), (u(x), u(y1))], fill=GRID, width=1)
            if x0 + 24 < x < x1 - 24:
                T(d, (x, y1 + self.AXIS / 2), label, F("Medium", 15), MUTED)
        for g in range(1, 5):
            p = lo + (hi - lo) * g / 5; y = py(p)
            d.line([(u(x0), u(y)), (u(x1), u(y))], fill=GRID, width=1)
            if labels: T(d, (x1 - 6, y - 10), f"{p:.2f}", F("Medium", 15), MUTED, "rm")
        sw = (x1 - x0) / self.cols; bw = max(3.0, sw * 0.62)
        bars, price = self.state(upto)
        for s, (o, h, l, c) in bars.items():
            col = EM if c >= o else RED
            cx = x0 + sw * (s + 0.5)
            yh, yl = max(y0, py(h)), min(y1, py(l))
            if yh < yl: d.line([(u(cx), u(yh)), (u(cx), u(yl))], fill=col, width=max(1, u(max(1.5, bw / 7))))
            yt, yb = max(y0, py(max(o, c))), min(y1, py(min(o, c)))
            if yb - yt < 2: yb = yt + 2
            d.rectangle([u(cx - bw / 2), u(yt), u(cx + bw / 2), u(yb)], fill=col)
        if live and 0 < upto < self.n:
            y = py(price)
            if y0 <= y <= y1:
                dashed(d, x0, x1 - 64, y, MUTED, 1.5, 6, 6)
                d.rounded_rectangle([u(x1 - 62), u(y - 11), u(x1 - 2), u(y + 11)], radius=u(4), fill=(48, 46, 40))
                T(d, (x1 - 32, y), f"{price:.2f}", F("Bold", 14), TXT)
        return py, (lambda i: x0 + sw * (self.slot[max(0, min(self.n - 1, int(i)))] + 0.5))

    def price_at(self, upto):
        return self.state(upto)[1]

    def slot_x(self, s):
        x0, _, x1, _ = self.box
        return x0 + (x1 - x0) / self.cols * (s + 0.5)

    def half(self):
        """half a drawn candle's width (design units)"""
        return max(3.0, (self.box[2] - self.box[0]) / self.cols * 0.62) / 2

    def clock(self, upto):
        i = max(0, min(self.n - 1, int(upto)))
        return hhmm(self.cs[i][0])


def live_result(panel, price):
    """The running result at a price: R when his stop is known, otherwise the % move."""
    e, s = panel["entry"], panel.get("stop")
    move = (price - e) if panel["side"] == "LONG" else (e - price)
    if panel["result"]["unit"] == "R" and s:
        risk = abs(e - s)
        if risk > 0: return move / risk, "R"
    return move / e * 100, "%"


def draw_fills(d, panel, py, px, upto, half=0.0, show_in=True):
    """Fill markers beside the candle they happened in: entries on its left pointing in, exits on its right."""
    r = 8
    for f in panel["fills"]:
        if f["idx"] > upto: continue
        if f["kind"] == "in" and not show_in: continue
        cx, y = px(f["idx"]), py(f["price"])
        if f["kind"] == "in":
            x = cx - half - r - 2
            d.polygon([(u(x + r), u(y)), (u(x - r), u(y - r * 0.7)), (u(x - r), u(y + r * 0.7))], fill=GOLD)
        else:
            x = cx + half + r + 2
            d.polygon([(u(x - r), u(y)), (u(x + r), u(y - r * 0.7)), (u(x + r), u(y + r * 0.7))], fill=TXT)


def draw_marks(d, ch, py, marks, t, t0, step, bg=PANEL, label_size=19):
    """Marks appearing one by one from t0 (step apart): rings on 5-min highs / lows / closes (same kind joined by a
    line, e.g. falling highs) or a level line, each with a small gold label."""
    box = ch.box
    shown = [m for i, m in enumerate(marks) if t >= t0 + i * step]
    for kind in ("high", "low", "close"):
        pts = [(ch.slot_x(m["slot"]), py(m["price"])) for m in shown if m["kind"] == kind]
        for a, b in zip(pts, pts[1:]):
            d.line([(u(a[0]), u(a[1])), (u(b[0]), u(b[1]))], fill=GOLD, width=u(3))
    for i, m in enumerate(shown):
        k = ease((t - (t0 + i * step)) / 0.35)
        y = py(m["price"])
        if m["kind"] == "level":
            dashed(d, box[0], box[2], y, mix(bg, GOLD, k), 3, 12, 6)
            lx, ly, anchor = box[0] + 10, y - 18, "lm"
        else:
            x = ch.slot_x(m["slot"]); r = 15 + 10 * (1 - k)
            d.ellipse([u(x - r), u(y - r), u(x + r), u(y + r)], outline=mix(bg, GOLD, k), width=u(3.5))
            below = m["kind"] == "low"
            prev = shown[i - 1] if i > 0 else None
            if prev and prev["kind"] != "level" and abs(ch.slot_x(prev["slot"]) - x) < 150:
                below = not below  # a neighbour's label is right there: put this one on the other side
            lx, ly, anchor = x, (y + 36 if below else y - 36), "mm"
        ly = min(max(ly, box[1] + 16), box[3] - Chart.AXIS - 16)  # labels stay above the time axis
        if m.get("label"):
            f = F("Bold", label_size); w = f.getlength(m["label"]) / K + 18
            cx = lx + w / 2 if anchor == "lm" else min(max(lx, box[0] + w / 2 + 4), box[2] - w / 2 - 4)
            d.rounded_rectangle([u(cx - w / 2), u(ly - 15), u(cx + w / 2), u(ly + 15)], radius=u(8), fill=mix(bg, GOLD, k))
            T(d, (cx, ly), m["label"], f, mix(bg, BG, k))


def header_common(d):
    T(d, (W / K / 2, 172), "Own trade, own money. Not advice.", F("Medium", 17), MUTED)


# ---------------- audio ----------------
SR = 44100
def tone(f, dur, vol=0.3, decay=8.0):
    t = np.arange(int(SR * dur)) / SR
    return vol * np.sin(2 * np.pi * f * t) * np.exp(-decay * t)
def click(vol=0.05):
    t = np.arange(int(SR * 0.02)) / SR
    return vol * np.sin(2 * np.pi * 2200 * t) * np.exp(-250 * t)
def place(buf, snd, at):
    i = int(at * SR); j = min(len(buf), i + len(snd))
    if i < len(buf): buf[i:j] += snd[: j - i]
def write_wav(path, buf):
    data = (np.clip(buf, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(data.tobytes())


def encode(frame_fn, nframes, wav, out):
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                          "-r", str(FPS), "-i", "-", "-i", wav, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out],
                         stdin=subprocess.PIPE)
    for f in range(nframes):
        p.stdin.write(frame_fn(f).tobytes())
    p.stdin.close()
    if p.wait() != 0: raise SystemExit("ffmpeg failed")


# =============== Mystery chart: long, short or wait? ===============
MESSAGE_MIN_S = 5.0   # a message shown during the trade stays at least this long
DECIDE_S = 5          # countdown for "Long, short, or wait?"


def wrap_lines(text, font, max_w, max_lines):
    """Word-wraps to at most max_lines lines that fit max_w pixels (None when it doesn't fit)."""
    words = text.split(); lines = [""]
    for wd in words:
        trial = (lines[-1] + " " + wd).strip()
        if font.getlength(trial) <= max_w: lines[-1] = trial
        else:
            if not lines[-1]: return None
            lines.append(wd)
            if len(lines) > max_lines: return None
    return lines


def fit_tell(text):
    """The tell in at most 2 lines: the biggest font that fits, else trimmed with an ellipsis."""
    for size in (29, 27, 25, 23):
        lines = wrap_lines(text, F("Bold", size), u(580), 2)
        if lines: return lines, size
    words = text.split()
    while words:
        words.pop()
        lines = wrap_lines(" ".join(words) + "…", F("Bold", 23), u(580), 2)
        if lines: return lines, 23
    return [text[:40]], 23


def tell_height(tell):
    lines, size = fit_tell(tell)
    return 20 + 30 + 8 + (size + 10) * len(lines) + 20


def draw_tell(d, y, tell, k, label="THE TELL"):
    """THE TELL (a win) / WHAT I MISSED (a loss) box: same padding above and below, height fixed by its (max 2)
    lines. Returns the box bottom."""
    lines, size = fit_tell(tell)
    pad, label_h, line_h = 20, 30, size + 10
    h = pad + label_h + 8 + line_h * len(lines) + pad
    d.rounded_rectangle([u(50), u(y), u(670), u(y + h)], radius=u(18), fill=mix(BG, (36, 32, 22), k))
    T(d, (360, y + pad + label_h / 2), label, F("Black", 24), mix(BG, GOLD, k))
    for i, line in enumerate(lines):
        T(d, (360, y + pad + label_h + 8 + line_h * (i + 0.5)), line, F("Bold", size), mix(BG, TXT, k))
    return y + h


def subscribe(d, y, k, line):
    """The call to action: YouTube-style red SUBSCRIBE button with the channel name."""
    T(d, (360, y), line, F("Bold", 27), mix(BG, TXT, k))
    cy = y + 66
    d.rounded_rectangle([u(170), u(cy - 36), u(550), u(cy + 36)], radius=u(36), fill=mix(BG, (204, 0, 0), k))
    # play icon on a white rounded square, then the word
    d.rounded_rectangle([u(204), u(cy - 17), u(246), u(cy + 17)], radius=u(8), fill=mix(BG, (255, 255, 255), k))
    d.polygon([(u(219), u(cy - 9)), (u(219), u(cy + 9)), (u(235), u(cy))], fill=mix(BG, (204, 0, 0), k))
    T(d, (390, cy), "SUBSCRIBE", F("Black", 34), mix(BG, (255, 255, 255), k))
    T(d, (360, cy + 64), "@CandlesBeforeCubicles", F("Bold", 24), mix(BG, GOLD, k))


def render_mystery(spec, out, poster):
    c = spec["content"]; p = c["panel"]
    box = (20, 250, 700, 860)
    ch = Chart(box, p)
    e, x = p["entryIdx"], p["exitIdx"]
    end = ch.n
    full_yr = ch.yrange(0, None, (p["entry"], p.get("stop"), p["exit"]))
    trade_yr = full_yr  # stays zoomed out on the whole window: no candle is ever clipped, the day's context stays
    lead = max(1, e)
    t_ff = min(10.0, max(5.0, lead * 0.22)); t_q = t_ff + 1.2; t_rev = t_q + DECIDE_S + 1.0
    play_s = min(11.0, max(6.0, (end - e) * 0.13))
    v = (end - e) / play_s  # minutes of the trade per second of video

    # "Most people bail right here." (a win) / "The stop stays where it is." (a loss): from the first minute the trade is 0.3R (or 0.15%) under water. The message
    # stays MESSAGE_MIN_S, and the replay runs in slow motion meanwhile, so those seconds show the dip, not the recovery.
    def under_water(m):
        val, unit = live_result(p, ch.price_at(m))
        return (unit == "R" and val < -0.3) or (unit == "%" and val < -0.15)
    m1 = next((e + i / 10 for i in range(int((end - e) * 10)) if under_water(e + i / 10)), None)
    slow = 0.3
    t_bail = t_rev + (m1 - e) / v if m1 is not None else None
    t_play = t_rev + play_s + (MESSAGE_MIN_S * (1 - slow) if m1 is not None else 0)
    if m1 is not None and m1 + v * slow * MESSAGE_MIN_S >= end:  # the dip runs into the exit: no catch-up needed
        t_play = t_bail + (end - m1) / (v * slow)
    bail = (t_bail, min(t_play, t_bail + MESSAGE_MIN_S)) if m1 is not None else None
    # straight from the trade to "THE STOCK WAS" + drum roll, then the ticker pops in; tell and subscribe after it
    t_reveal = t_play + 1.5; t_end_card = t_reveal + 1.6
    # the recap: after the end card has been read, the tell box moves to the top, the result and ticker band clear,
    # and the chart comes back (ticker named) with what the tell talks about marked on it. Comment + Subscribe stay put.
    marks = c.get("marks") or []
    recap = bool(c.get("tell"))
    t_recap = t_end_card + 3.2; RECAP_MOVE = 0.9
    t_marks = t_recap + RECAP_MOVE + 0.3; MARK_STEP = 0.7
    total = (t_marks + MARK_STEP * len(marks) + 4.2) if recap else (t_end_card + 4.6)
    ans = p["side"]
    # a losing trade is shown just as fully, but nothing on screen may suggest his call was the right one
    lost = p["result"]["value"] < 0
    msg_dip = "The stop stays where it is." if lost else "Most people bail right here."
    box_label = "WHAT I MISSED" if lost else "THE TELL"
    cta = "Would you have taken it? Comment below" if lost else "New mystery chart every week"

    def upto_at(t):
        if t < t_ff: return e * (t / t_ff)
        if t < t_rev: return e
        if t >= t_play: return end
        if bail is None or t < bail[0]: return min(end, e + v * (t - t_rev))
        if t < bail[1]: return min(end, m1 + v * slow * (t - bail[0]))
        return min(end, m1 + v * slow * (bail[1] - bail[0]) + v * (t - bail[1]))

    def yr_at(t):
        if t < t_rev: return full_yr
        k = ease((t - t_rev) / 1.0)
        return (lerp(full_yr[0], trade_yr[0], k), lerp(full_yr[1], trade_yr[1], k))

    def frame_main(t, show_tell=True, show_cta=True):
        img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
        up = upto_at(t)
        T(d, (32, 70), c["symbol"] if t >= t_reveal else "MYSTERY STOCK", F("Black", 40), GOLD if t >= t_reveal else TXT, "lm")
        T(d, (32, 114), f"NSE  ·  {p['tf']}-min chart", F("Medium", 23), MUTED, "lm")
        T(d, (688, 70), ch.clock(up if t < t_play else end - 1), F("Bold", 44), GOLD, "rm")
        slowmo = bail is not None and bail[0] <= t < bail[1]
        speed = "FAST" if t < t_ff else ("PAUSED" if t < t_rev else ("SLOW-MO" if slowmo else "PLAY" if t < t_play else "DONE"))
        pill(d, 622, 118, 116, 36, speed, (48, 46, 40), F("Bold", 18))
        header_common(d)
        py, px = ch.draw(d, up, yr_at(t))

        if t < MESSAGE_MIN_S:  # hook, held for MESSAGE_MIN_S
            a = 1 - ease((t - (MESSAGE_MIN_S - 0.5)) / 0.5) if t > MESSAGE_MIN_S - 0.5 else 1
            d.rounded_rectangle([u(40), u(196), u(680), u(240)], radius=u(12), fill=mix(BG, DARKGOLD, a))
            T(d, (360, 218), "Would you take this trade?", F("Black", 30), mix(BG, GOLD, a))

        if t < t_ff:
            first = ch.cs[0][1]; now = ch.price_at(up) if up > 0 else first
            chg = (now - first) / first * 100
            T(d, (360, 930), f"{chg:+.2f}% since {hhmm(ch.cs[0][0])}".replace("-", "−"), F("Black", 46), EM if chg >= 0 else RED)

        if t_ff <= t < t_rev:  # the question, then a DECIDE_S countdown
            k = ease((t - t_ff) / 0.35)
            img = dim(img, 0.55 * k); d = ImageDraw.Draw(img)
            T(d, (360, 450), f"{hhmm(ch.cs[e][0])}. Your move?", F("Bold", 34), mix(BG, MUTED, k))
            T(d, (360, 520), "LONG, SHORT,", F("Black", 66), mix(BG, TXT, k))
            T(d, (360, 595), "OR WAIT?", F("Black", 66), mix(BG, TXT, k))
            if t_q <= t < t_q + DECIDE_S:
                ph = (t - t_q) % 1; n = DECIDE_S - int(t - t_q)
                T(d, (360, 730), str(max(1, n)), F("Black", int(150 - 40 * ease(ph))), mix(GOLD, BG, ease((ph - 0.6) / 0.4)))
                T(d, (360, 840), "Comment your answer", F("SemiBold", 28), TXT)
            if t >= t_q + DECIDE_S:
                T(d, (360, 760), "My call…", F("Black", 48), GOLD)
            for j, (lab, col) in enumerate([("LONG", EM), ("SHORT", RED), ("WAIT", GOLD)]):
                pill(d, 140 + j * 220, 960, 190, 76, lab, mix(BG, col, k), F("Black", 32))

        if t >= t_rev:
            ex = px(e) - 8
            dashed(d, ex, box[2], py(p["entry"]), GOLD, 3)
            T(d, (box[0] + 8, py(p["entry"]) - 16), f"ENTRY {p['entry']:.2f}", F("Bold", 19), GOLD, "lm")
            if p.get("stop"):
                dashed(d, ex, box[2], py(p["stop"]), RED, 3)
                T(d, (box[0] + 8, py(p["stop"]) + 16), f"STOP {p['stop']:.2f}", F("Bold", 19), RED, "lm")
            draw_fills(d, p, py, px, up, ch.half())
            if t < t_play:
                val, unit = live_result(p, ch.price_at(up))
                pulse = 1 - ease((t - t_rev) / 0.5)
                pill(d, 360, 935, 420, 88, f"MY CALL: {ans}", EM if ans == "LONG" else RED, F("Black", 40))
                d.rounded_rectangle([u(150 - 8 * pulse), u(891 - 8 * pulse), u(570 + 8 * pulse), u(979 + 8 * pulse)], radius=u(48), outline=GOLD, width=u(3))
                T(d, (360, 205), fmt_result(val, unit), F("Black", 54), EM if val >= 0 else RED)
                if bail and bail[0] <= t < bail[1]:
                    a = min(ease((t - bail[0]) / 0.3), 1 - ease((t - (bail[1] - 0.3)) / 0.3))
                    d.rounded_rectangle([u(90), u(255), u(630), u(305)], radius=u(12), fill=mix(BG, (60, 26, 24), a))
                    T(d, (360, 280), msg_dip, F("Bold", 25), mix(BG, TXT, a))
            else:
                xx = px(x)
                d.ellipse([u(xx - 9), u(py(p["exit"]) - 9), u(xx + 9), u(py(p["exit"]) + 9)], fill=GOLD)
                res = p["result"]; col = EM if res["value"] >= 0 else RED
                sub = f"in {p['holdMin']} minutes" + ("  ·  after charges" if res["unit"] == "R" else "")
                k = ease((t - t_play) / 0.4)
                img = dim(img, 0.9 * k); d = ImageDraw.Draw(img)
                T(d, (360, 410), "THE STOCK WAS", F("Black", 34 if t < t_reveal else 30), mix(BG, GOLD, k))
                if t < t_reveal:
                    dots = "." * (1 + int((t - t_play) / 0.4) % 3)
                    T(d, (360, 530), dots, F("Black", 90), mix(BG, GOLD, k))
                else:
                    # the pop: the ticker slams onto a full-width band and stays, the result above it
                    T(d, (360, 255), fmt_result(res["value"], res["unit"]), F("Black", 72), col)
                    T(d, (360, 315), sub, F("Bold", 26), TXT)
                    ks = ease((t - t_reveal) / 0.28)
                    flash = max(0.0, 1 - (t - t_reveal) / 0.45)
                    band_h = 150 * (0.4 + 0.6 * ks)
                    d.rectangle([0, u(530 - band_h / 2), W, u(530 + band_h / 2)], fill=mix(GOLD, (255, 250, 235), flash))
                    sym = c["symbol"]
                    size = 118
                    while size > 50 and F("Black", size).getlength(sym) > u(640): size -= 4
                    size = int(size * (1.0 + 0.25 * (1 - ks)))  # a short pop, never wider than the screen
                    T(d, (360, 532), sym, F("Black", size), BG)
                    if t > t_reveal + 0.35:
                        k3 = ease((t - t_reveal - 0.35) / 0.4)
                        T(d, (360, 650), f"NSE  ·  {c['dateLabel']}", F("Bold", 32), mix(BG, TXT, k3))
                    if show_tell and t > t_end_card and c.get("tell"):
                        draw_tell(d, TELL_Y, c["tell"], ease((t - t_end_card) / 0.4), box_label)
                    if show_cta and t > t_end_card + 0.8:
                        subscribe(d, CTA_Y, ease((t - t_end_card - 0.8) / 0.4), cta)
        return img

    # where the tell box and the call to action sit (the CTA never moves once shown)
    TELL_Y = 712
    tell_h = (tell_height(c["tell"]) if c.get("tell") else -26)
    CTA_Y = TELL_Y + tell_h + 26 + 18
    TELL_TOP = 146
    rbox = (20, TELL_TOP + tell_height(c["tell"]) + 26 if c.get("tell") else 300, 700, CTA_Y - 82)
    rch = Chart(rbox, p)
    r_yr = rch.yrange(0, None, (p["entry"], p.get("stop"), p["exit"], *[m["price"] for m in marks]))
    res = p["result"]

    def frame_recap_base(t):
        """The chart again, ticker named, the whole trade drawn, P&L under it, and the marks appearing one by one."""
        img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
        T(d, (32, 70), c["symbol"], F("Black", 40), GOLD, "lm")
        T(d, (32, 114), f"NSE  ·  {p['tf']}-min chart  ·  {c['dateLabel']}", F("Medium", 23), MUTED, "lm")
        py, px = rch.draw(d, end, r_yr, labels=True, live=False)
        ex = px(e) - 8
        dashed(d, ex, rbox[2], py(p["entry"]), GOLD, 2.5)
        if p.get("stop"): dashed(d, ex, rbox[2], py(p["stop"]), RED, 2.5)
        draw_fills(d, p, py, px, end, rch.half())
        col = EM if res["value"] >= 0 else RED
        T(d, (360, rbox[3] + 34), f"{fmt_result(res['value'], res['unit'])}  in {p['holdMin']} min" + ("  ·  after charges" if res["unit"] == "R" else ""), F("Black", 34), col)
        draw_marks(d, rch, py, marks, t, t_marks, MARK_STEP)
        return img

    def frame(f):
        t = f / FPS
        if not recap or t < t_recap:
            return frame_main(t)
        kx = ease((t - t_recap) / RECAP_MOVE)
        base = frame_recap_base(t)
        img = base if kx >= 1 else Image.blend(frame_main(t, show_tell=False, show_cta=False), base, kx)
        d = ImageDraw.Draw(img)
        draw_tell(d, lerp(TELL_Y, TELL_TOP, kx), c["tell"], 1.0, box_label)
        subscribe(d, CTA_Y, 1.0, cta)
        return img

    nf = int(total * FPS)
    buf = np.zeros(int(SR * total) + SR); last = -1
    for f in range(nf):
        tt = f / FPS; uu = int(upto_at(tt))
        if uu != last and tt < t_play and not (t_ff <= tt < t_rev): place(buf, click(0.035), tt)
        last = uu
    place(buf, tone(330, 0.5, 0.35, 5), t_ff)
    for i in range(DECIDE_S): place(buf, tone(880 if i < DECIDE_S - 1 else 1175, 0.18, 0.35, 12), t_q + i)
    place(buf, tone(660, 0.4, 0.3, 6), t_rev); place(buf, tone(990, 0.5, 0.25, 5), t_rev + 0.08)
    if bail: place(buf, tone(220, 0.35, 0.3, 6), bail[0])
    roll = t_play + 0.15
    n = 0
    while roll < t_reveal - 0.05:
        place(buf, tone(180 + n * 6, 0.06, 0.12 + n * 0.006, 30), roll)
        n += 1; roll += max(0.035, 0.13 - n * 0.006)
    place(buf, tone(70, 0.9, 0.7, 3.5), t_reveal); place(buf, tone(140, 0.6, 0.4, 5), t_reveal)
    win = p["result"]["value"] >= 0
    for kk, fr in enumerate([784, 1047, 1319] if win else [523, 392, 330]): place(buf, tone(fr, 0.7, 0.22, 4), t_reveal + 0.05 + kk * 0.06)
    if recap:
        place(buf, tone(240, 0.5, 0.18, 4), t_recap)
        for i in range(len(marks)): place(buf, tone(1320, 0.12, 0.22, 14), t_marks + i * MARK_STEP)
    finish(frame, nf, buf, out, poster, poster_t=t_q + 0.5)  # the question, never the answer


# =============== Me vs Algo ===============
def render_vs(spec, out, poster):
    c = spec["content"]; wk = c["week"]
    me, algo = c.get("me"), c.get("algo")
    boxes = {"me": (20, 285, 700, 615), "algo": (20, 700, 700, 1030)}
    # bottom panel would sit in the platforms' caption zone: keep it short and above y=1030 (80% of 1280 = 1024)
    boxes["algo"] = (20, 690, 700, 1010)
    charts = {k: Chart(boxes[k], v) for k, v in (("me", me), ("algo", algo)) if v}
    t0 = 2.0; t_end = t0 + 17.0  # the opening line clears after 2 s and the trades start (this template only)
    # the "why" beat: both trades done, each side's reason shown and the candles it refers to marked, held 5 s
    vmarks = {k: (c.get(k) or {}).get("marks") or [] for k in ("me", "algo")}
    why = any(vmarks.values()) or any((c.get(k) or {}).get("note") for k in ("me", "algo"))
    WHY_STEP = 0.6
    t_why = t_end + 0.5
    t_tot = (t_why + MESSAGE_MIN_S) if why else (t_end + 0.6)
    t_score = t_tot + 1.8  # verdict + season 3 s after THIS WEEK (was 4 s)
    total = t_score + 6.0

    def prog(t): return 0 if t < t0 else min(1.0, (t - t0) / (t_end - t0))

    if wk["winner"] == "algo": hook = ("My bot beat me this week.", "Real trades. Real money.")
    elif wk["winner"] == "me": hook = ("I beat my own bot this week.", "Real trades. Real money.")
    elif wk["winner"] == "tie": hook = ("Me vs my bot: dead even.", "Real trades. Real money.")
    else: hook = ("Me vs my bot.", "Real trades. Real money.")

    def panel(d, key, label, t):
        bx = boxes[key]; v = c.get(key)
        T(d, (bx[0], bx[1] - 30), label, F("Black", 32), TXT, "lm")
        if not v:
            d.rectangle([u(bx[0]), u(bx[1]), u(bx[2]), u(bx[3])], fill=PANEL)
            T(d, ((bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2), "No trades this week", F("Bold", 30), MUTED)
            return
        ch = charts[key]; e, x = v["entryIdx"], v["exitIdx"]
        up = ch.n * prog(t)
        yr = ch.yrange(0, None, (v["entry"], v.get("stop"), v["exit"]))
        yr = (yr[0] - (yr[1] - yr[0]) * 0.5, yr[1])  # room at the bottom for the reason (above the time axis), so it never covers a mark
        py, px = ch.draw(d, up, yr, labels=False)
        T(d, (bx[2], bx[1] - 30), ch.clock(up), F("Bold", 24), MUTED, "rm")
        if v.get("symbol"):  # only on trades over 3 months old (SEBI); shown from the start, no reveal
            T(d, (bx[0] + 216, bx[1] - 30), v["symbol"], F("Bold", 22), GOLD, "lm")
        if up > e:
            dashed(d, px(e) - 6, bx[2], py(v["entry"]), GOLD, 3)
            if v.get("stop"): dashed(d, px(e) - 6, bx[2], py(v["stop"]), RED, 3)
            pill(d, bx[0] + 150, bx[1] - 30, 110, 38, v["side"], EM if v["side"] == "LONG" else RED, F("Black", 20))
            draw_fills(d, v, py, px, up, ch.half())
            done = up >= x + 1
            if done:
                res = v["result"]; good = res["value"] >= 0
                cy = (bx[1] + bx[3]) / 2
                # honest wording: STOPPED only when the stop actually hit; a loss closed earlier is CUT
                word = "BOOKED " if good else ("STOPPED " if (v.get("exitType") or "").upper() == "STOP" else "CUT ")
                if t < t_why or not why:
                    d.rounded_rectangle([u(bx[0] + 160), u(cy - 40), u(bx[2] - 160), u(cy + 40)], radius=u(16), fill=EM if good else RED)
                    T(d, ((bx[0] + bx[2]) / 2, cy), word + fmt_result(res["value"], res["unit"]), F("Black", 32), TXT)
                T(d, (bx[2] - 96, bx[1] - 30), fmt_result(res["value"], res["unit"]), F("Black", 36), EM if good else RED, "rm")
            else:
                val, unit = live_result(v, ch.price_at(up))
                T(d, (bx[2] - 96, bx[1] - 30), fmt_result(val, unit), F("Black", 36), EM if val >= 0 else RED, "rm")
            if why and t >= t_why:
                # the why beat: the reason, big, and the candles it refers to marked
                order = ["me", "algo"].index(key)
                start = t_why + 0.3 + order * WHY_STEP * max(1, len(vmarks["me"]))
                draw_marks(d, ch, py, vmarks[key], t, start, WHY_STEP)
                if v.get("note"):
                    k = ease((t - t_why) / 0.35); f = F("Bold", 24); w = min(640, f.getlength(f"“{v['note']}”") / K + 28)
                    nb = bx[3] - Chart.AXIS  # above the time axis
                    d.rounded_rectangle([u(360 - w / 2), u(nb - 46), u(360 + w / 2), u(nb - 10)], radius=u(10), fill=mix(PANEL, (36, 32, 22), k))
                    T(d, (360, nb - 28), f"“{v['note']}”", f, mix(PANEL, TXT, k))
            elif v.get("note"): T(d, (bx[0] + 12, bx[3] - Chart.AXIS - 22), f"“{v['note']}”", F("SemiBold", 21), TXT, "lm")

    def frame(f):
        t = f / FPS
        img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
        d.rounded_rectangle([u(20), u(24), u(700), u(150)], radius=u(18), fill=(30, 28, 22))
        tf = (me or algo or {}).get("tf", 5)
        T(d, (360, 50), f"ME vs ALGO  ·  {c['weekLabel'].upper()}  ·  {tf}-MIN CHARTS", F("Bold", 20), GOLD)
        k = ease((t - t_score) / 0.5) if t >= t_score else 0
        s = c["after"] if k > 0.5 else c["before"]
        glow = math.sin(min(1, max(0, (t - t_score) / 1.0)) * math.pi)
        T(d, (175, 105), "ME", F("Black", 44), TXT); T(d, (545, 105), "ALGO", F("Black", 44), TXT)
        for key, xx in (("me", 318), ("algo", 402)):
            changed = c["after"][key] != c["before"][key]
            T(d, (xx, 105), str(s[key]), F("Black", int(56 + (30 * glow if changed else 0))), mix(TXT, GOLD, glow if changed else 0))
        T(d, (360, 105), "-", F("Black", 50), MUTED)
        header_common(d)
        panel(d, "me", "ME", t); panel(d, "algo", "ALGO", t)

        if t < t0:
            a = 1 - ease((t - t0 + 0.5) / 0.5) if t > t0 - 0.5 else 1
            img = dim(img, 0.55 * a); d = ImageDraw.Draw(img)
            T(d, (360, 540), hook[0], F("Black", 44), mix(BG, TXT, a))
            T(d, (360, 605), hook[1], F("Bold", 30), mix(BG, GOLD, a))
        if t >= t_tot:
            k2 = ease((t - t_tot) / 0.5)
            img = dim(img, 0.84 * k2); d = ImageDraw.Draw(img)
            T(d, (360, 300), "THIS WEEK", F("Black", 30), mix(BG, GOLD, k2))
            for row, (key, name) in enumerate((("me", "ME"), ("algo", "ALGO"))):
                side = wk[key]; y = 380 + row * 90
                T(d, (90, y), name, F("Black", 44), mix(BG, TXT, k2), "lm")
                T(d, (420, y), fmt_result(side["r"], "R"), F("Black", 50), mix(BG, EM if side["r"] >= 0 else RED, k2), "rm")
                T(d, (630, y), f"{side['n']} trade{'s' if side['n'] != 1 else ''}", F("Bold", 26), mix(BG, MUTED, k2), "rm")
            if t >= t_score + 1.2:
                k3 = ease((t - t_score - 1.2) / 0.5)
                verdict = {"me": "I take the week.", "algo": "The bot takes the week.", "tie": "Dead even.", "none": "No trades this week."}[wk["winner"]]
                if wk["winner"] in ("me", "algo") and wk[wk["winner"]]["n"] == 0:  # won by not trading while the other lost
                    verdict = "I sat out. Still won." if wk["winner"] == "me" else "The bot sat out. Still won."
                T(d, (360, 610), verdict, F("Black", 46), mix(BG, GOLD, k3))
                T(d, (360, 690), f"Season: ME {c['after']['me']} - {c['after']['algo']} ALGO", F("Black", 36), mix(BG, TXT, k3))
                subscribe(d, 770, k3, "Next round: Monday, 9:15")
        return img

    nf = int(total * FPS)
    buf = np.zeros(int(SR * total) + SR)
    nmax = max([ch.n for ch in charts.values()] or [1]); last = -1
    for f in range(nf):
        tt = f / FPS; uu = int(nmax * prog(tt))
        if uu != last and t0 <= tt < t_end: place(buf, click(0.04), tt)
        last = uu
    for key, ch in charts.items():
        v = c[key]
        at = lambda i: t0 + (i + 1) / ch.n * (t_end - t0)
        place(buf, tone(560, 0.3, 0.3, 8), at(v["entryIdx"]))
        if v["result"]["value"] >= 0:
            for kk, fr in enumerate([523, 659, 784]): place(buf, tone(fr, 0.5, 0.22, 5), at(v["exitIdx"]) + kk * 0.08)
        else:
            place(buf, tone(110, 0.7, 0.55, 4), at(v["exitIdx"]))
    for kk, fr in enumerate([784, 988, 1175, 1568]): place(buf, tone(fr, 0.6, 0.2, 4), t_score + kk * 0.08)
    if why:
        place(buf, tone(240, 0.5, 0.18, 4), t_why)
        n_me = max(1, len(vmarks["me"]))
        for i in range(len(vmarks["me"])): place(buf, tone(1320, 0.12, 0.22, 14), t_why + 0.3 + i * WHY_STEP)
        for i in range(len(vmarks["algo"])): place(buf, tone(1320, 0.12, 0.22, 14), t_why + 0.3 + (n_me + i) * WHY_STEP)
    finish(frame, nf, buf, out, poster, poster_t=1.2)  # the hook, not the result


def finish(frame, nf, buf, out, poster, poster_t):
    wav = out + ".wav"
    write_wav(wav, buf)
    encode(frame, nf, wav, out)
    os.remove(wav)
    frame(int(poster_t * FPS)).convert("RGB").resize((540, 960)).save(poster, quality=85)


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: render.py spec.json out.mp4 poster.jpg")
    spec = json.load(open(sys.argv[1]))
    if spec.get("v") != 2:
        raise SystemExit(f"unsupported spec version {spec.get('v')} (2 = 1-minute candles drawn as live candles of the spec's tf)")
    kind = spec["content"]["kind"]
    if kind == "mystery": render_mystery(spec, sys.argv[2], sys.argv[3])
    elif kind == "vs": render_vs(spec, sys.argv[2], sys.argv[3])
    else: raise SystemExit(f"unknown template {kind}")


if __name__ == "__main__":
    main()
