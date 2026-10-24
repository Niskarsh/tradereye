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


class Chart:
    """One candle panel. Candles are [t, o, h, l, c]; `upto` may be fractional (the last candle forms gradually)."""

    def __init__(self, box, panel):
        self.box = box
        self.p = panel
        self.cs = panel["candles"]
        self.n = len(self.cs)

    def yrange(self, i0=0, i1=None, extra=()):
        cs = self.cs[i0:i1 if i1 is not None else self.n]
        lo = min(c[3] for c in cs); hi = max(c[2] for c in cs)
        for x in extra:
            if x: lo = min(lo, x); hi = max(hi, x)
        pad = (hi - lo) * 0.08 or hi * 0.002
        return lo - pad, hi + pad

    def draw(self, d, upto, yr, labels=True):
        x0, y0, x1, y1 = self.box
        d.rectangle([u(x0), u(y0), u(x1), u(y1)], fill=PANEL)
        lo, hi = yr
        py = lambda p: y1 - (p - lo) / (hi - lo) * (y1 - y0)
        for g in range(1, 5):
            p = lo + (hi - lo) * g / 5; y = py(p)
            d.line([(u(x0), u(y)), (u(x1), u(y))], fill=GRID, width=1)
            if labels: T(d, (x1 - 6, y - 10), f"{p:.2f}", F("Medium", 15), MUTED, "rm")
        sw = (x1 - x0) / self.n; bw = max(2.0, sw * 0.62)
        full = int(upto); frac = upto - full
        for i in range(min(self.n, full + 1)):
            t, o, h, l, c = self.cs[i]
            if i == full:
                if frac <= 0: break
                c = o + (c - o) * frac
                h = max(o, c, lerp(max(o, c), h, frac)); l = min(o, c, lerp(min(o, c), l, frac))
            col = EM if c >= o else RED
            cx = x0 + sw * (i + 0.5)
            yt, yb = py(max(o, c)), py(min(o, c))
            yh, yl = max(y0, py(h)), min(y1, py(l))
            if yh < yl: d.line([(u(cx), u(yh)), (u(cx), u(yl))], fill=col, width=max(1, u(bw / 4)))
            yt, yb = max(y0, yt), min(y1, yb)
            if yb - yt < 2: yb = yt + 2
            d.rectangle([u(cx - bw / 2), u(yt), u(cx + bw / 2), u(yb)], fill=col)
        return py, (lambda i: x0 + sw * (i + 0.5))

    def price_at(self, upto):
        full = min(int(upto), self.n - 1); frac = upto - int(upto)
        t, o, h, l, c = self.cs[full]
        if frac <= 0 and full > 0: return self.cs[full - 1][4]
        return o + (c - o) * frac

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


def draw_fills(d, panel, py, px, upto, show_in=True):
    for f in panel["fills"]:
        if f["idx"] > upto: continue
        if f["kind"] == "in" and not show_in: continue
        x, y = px(f["idx"]), py(f["price"])
        col = GOLD if f["kind"] == "in" else TXT
        r = 8
        d.polygon([(u(x - r), u(y)), (u(x + r), u(y - r * 0.7)), (u(x + r), u(y + r * 0.7))], fill=col) if f["kind"] == "out" else \
            d.polygon([(u(x + r), u(y)), (u(x - r), u(y - r * 0.7)), (u(x - r), u(y + r * 0.7))], fill=col)


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
def render_mystery(spec, out, poster):
    c = spec["content"]; p = c["panel"]
    box = (20, 250, 700, 860)
    ch = Chart(box, p)
    e, x = p["entryIdx"], p["exitIdx"]
    end = ch.n
    full_yr = ch.yrange(0, None, (p["entry"], p.get("stop"), p["exit"]))
    trade_yr = ch.yrange(max(0, e - 3), None, (p["entry"], p.get("stop"), p["exit"]))
    lead = max(1, e)
    t_ff = min(10.0, max(4.0, lead * 0.22)); t_q = t_ff + 1.2; t_rev = t_q + 3.0 + 1.2
    t_play = t_rev + min(10.0, max(5.0, (end - e) * 0.12)); total = t_play + 5.5
    ans = p["side"]

    def upto_at(t):
        if t < t_ff: return e * (t / t_ff)
        if t < t_rev: return e
        if t < t_play: return e + (end - e) * ((t - t_rev) / (t_play - t_rev))
        return end

    def yr_at(t):
        if t < t_rev: return full_yr
        k = ease((t - t_rev) / 1.0)
        return (lerp(full_yr[0], trade_yr[0], k), lerp(full_yr[1], trade_yr[1], k))

    def frame(f):
        t = f / FPS
        img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
        up = upto_at(t)
        T(d, (32, 70), "MYSTERY STOCK", F("Black", 40), TXT, "lm")
        T(d, (32, 114), f"NSE  ·  {p['tf']}-min chart", F("Medium", 23), MUTED, "lm")
        T(d, (688, 70), ch.clock(up if t < t_play else end - 1), F("Bold", 44), GOLD, "rm")
        speed = "FAST" if t < t_ff else ("PAUSED" if t < t_rev else ("PLAY" if t < t_play else "DONE"))
        pill(d, 622, 118, 116, 36, speed, (48, 46, 40), F("Bold", 18))
        header_common(d)
        py, px = ch.draw(d, up, yr_at(t))

        if t < 2.6:  # hook
            a = 1 - ease((t - 2.1) / 0.5) if t > 2.1 else 1
            d.rounded_rectangle([u(40), u(196), u(680), u(240)], radius=u(12), fill=mix(BG, DARKGOLD, a))
            T(d, (360, 218), "Would you take this trade?", F("Black", 30), mix(BG, GOLD, a))

        if t < t_ff:
            first = ch.cs[0][1]; now = ch.price_at(up) if up > 0 else first
            chg = (now - first) / first * 100
            T(d, (360, 930), f"{chg:+.2f}% since {hhmm(ch.cs[0][0])}".replace("-", "−"), F("Black", 46), EM if chg >= 0 else RED)

        if t_ff <= t < t_rev:  # the question
            k = ease((t - t_ff) / 0.35)
            img = dim(img, 0.55 * k); d = ImageDraw.Draw(img)
            T(d, (360, 450), f"{hhmm(ch.cs[e][0])}. Your move?", F("Bold", 34), mix(BG, MUTED, k))
            T(d, (360, 520), "LONG, SHORT,", F("Black", 66), mix(BG, TXT, k))
            T(d, (360, 595), "OR WAIT?", F("Black", 66), mix(BG, TXT, k))
            if t >= t_q and t < t_q + 3:
                ph = (t - t_q) % 1; n = 3 - int(t - t_q)
                T(d, (360, 730), str(max(1, n)), F("Black", int(150 - 40 * ease(ph))), mix(GOLD, BG, ease((ph - 0.6) / 0.4)))
                T(d, (360, 840), "Comment your answer", F("SemiBold", 28), TXT)
            if t >= t_q + 3:
                T(d, (360, 760), "Answer…", F("Black", 48), GOLD)
            for j, (lab, col) in enumerate([("LONG", EM), ("SHORT", RED), ("WAIT", GOLD)]):
                pill(d, 140 + j * 220, 960, 190, 76, lab, mix(BG, col, k), F("Black", 32))

        if t >= t_rev:
            ex = px(e) - 8
            dashed(d, ex, box[2], py(p["entry"]), GOLD, 3)
            T(d, (box[0] + 8, py(p["entry"]) - 16), f"ENTRY {p['entry']:.2f}", F("Bold", 19), GOLD, "lm")
            if p.get("stop"):
                dashed(d, ex, box[2], py(p["stop"]), RED, 3)
                T(d, (box[0] + 8, py(p["stop"]) + 16), f"STOP {p['stop']:.2f}", F("Bold", 19), RED, "lm")
            draw_fills(d, p, py, px, up)
            val, unit = live_result(p, ch.price_at(up) if t < t_play else p["exit"])
            if t < t_play:
                pulse = 1 - ease((t - t_rev) / 0.5)
                pill(d, 360, 935, 300, 88, ans, EM if ans == "LONG" else RED, F("Black", 44))
                d.rounded_rectangle([u(210 - 8 * pulse), u(891 - 8 * pulse), u(510 + 8 * pulse), u(979 + 8 * pulse)], radius=u(48), outline=GOLD, width=u(3))
                T(d, (360, 205), fmt_result(val, unit), F("Black", 54), EM if val >= 0 else RED)
                if (unit == "R" and val < -0.3) or (unit == "%" and val < -0.15):
                    d.rounded_rectangle([u(90), u(255), u(630), u(305)], radius=u(12), fill=(60, 26, 24))
                    T(d, (360, 280), "Most people bail right here.", F("Bold", 25), TXT)
            else:
                xx = px(x)
                d.ellipse([u(xx - 9), u(py(p["exit"]) - 9), u(xx + 9), u(py(p["exit"]) + 9)], fill=GOLD)
                k = ease((t - t_play) / 0.5)
                img = dim(img, 0.82 * k); d = ImageDraw.Draw(img)
                res = p["result"]
                col = EM if res["value"] >= 0 else RED
                T(d, (360, 360), fmt_result(res["value"], res["unit"]), F("Black", 140), mix(BG, col, k))
                sub = f"in {p['holdMin']} minutes" + ("  ·  after charges" if res["unit"] == "R" else "")
                T(d, (360, 455), sub, F("Bold", 32), mix(BG, TXT, k))
                T(d, (360, 525), f"It was {c['symbol']}  ·  {c['dateLabel']}", F("Black", 34), mix(BG, GOLD, k))
                y = 600
                if c.get("tell"):
                    d.rounded_rectangle([u(50), u(y - 10), u(670), u(y + 120)], radius=u(18), fill=mix(BG, (36, 32, 22), k))
                    T(d, (360, y + 22), "THE TELL", F("Black", 24), mix(BG, GOLD, k))
                    words = c["tell"].split(); lines = [""]
                    for wd in words:
                        if len(lines[-1]) + len(wd) + 1 > 34: lines.append(wd)
                        else: lines[-1] = (lines[-1] + " " + wd).strip()
                    for li, line in enumerate(lines[:2]):
                        T(d, (360, y + 62 + li * 38), line, F("Bold", 29), mix(BG, TXT, k))
                    y += 150
                if t > t_play + 1.2:
                    k2 = ease((t - t_play - 1.2) / 0.4)
                    T(d, (360, y + 60), "New mystery chart every week.", F("Black", 32), mix(BG, TXT, k2))
                    pill(d, 360, y + 150, 360, 80, "FOLLOW", mix(BG, RED, k2), F("Black", 36))
        return img

    nf = int(total * FPS)
    buf = np.zeros(int(SR * total) + SR); last = -1
    for f in range(nf):
        tt = f / FPS; uu = int(upto_at(tt))
        if uu != last and tt < t_play and not (t_ff <= tt < t_rev): place(buf, click(), tt)
        last = uu
    place(buf, tone(330, 0.5, 0.35, 5), t_ff)
    for i in range(3): place(buf, tone(880, 0.18, 0.35, 12), t_q + i)
    place(buf, tone(660, 0.4, 0.3, 6), t_rev); place(buf, tone(990, 0.5, 0.25, 5), t_rev + 0.08)
    win = p["result"]["value"] >= 0
    for kk, fr in enumerate([523, 659, 784, 1047] if win else [392, 330, 262]): place(buf, tone(fr, 0.6, 0.25, 4), t_play + kk * 0.09)
    finish(frame, nf, buf, out, poster, poster_t=t_q + 0.5)  # the question, never the answer


# =============== Me vs Algo ===============
def render_vs(spec, out, poster):
    c = spec["content"]; wk = c["week"]
    me, algo = c.get("me"), c.get("algo")
    boxes = {"me": (20, 285, 700, 615), "algo": (20, 700, 700, 1030)}
    # bottom panel would sit in the platforms' caption zone: keep it short and above y=1030 (80% of 1280 = 1024)
    boxes["algo"] = (20, 690, 700, 1010)
    charts = {k: Chart(boxes[k], v) for k, v in (("me", me), ("algo", algo)) if v}
    t0, t_end = 2.6, 19.0
    t_tot, t_score = t_end + 0.6, t_end + 3.4
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
        py, px = ch.draw(d, up, yr, labels=False)
        T(d, (bx[2], bx[1] - 30), ch.clock(up), F("Bold", 24), MUTED, "rm")
        if up > e:
            dashed(d, px(e) - 6, bx[2], py(v["entry"]), GOLD, 3)
            if v.get("stop"): dashed(d, px(e) - 6, bx[2], py(v["stop"]), RED, 3)
            pill(d, bx[0] + 150, bx[1] - 30, 110, 38, v["side"], EM if v["side"] == "LONG" else RED, F("Black", 20))
            draw_fills(d, v, py, px, up)
            done = up >= x + 1
            if done:
                res = v["result"]; good = res["value"] >= 0
                cy = (bx[1] + bx[3]) / 2
                d.rounded_rectangle([u(bx[0] + 160), u(cy - 40), u(bx[2] - 160), u(cy + 40)], radius=u(16), fill=EM if good else RED)
                T(d, ((bx[0] + bx[2]) / 2, cy), ("BOOKED " if good else "STOPPED ") + fmt_result(res["value"], res["unit"]), F("Black", 32), TXT)
                T(d, (bx[2] - 210, bx[1] - 30), fmt_result(res["value"], res["unit"]), F("Black", 36), EM if good else RED, "rm")
            else:
                val, unit = live_result(v, ch.price_at(up))
                T(d, (bx[2] - 210, bx[1] - 30), fmt_result(val, unit), F("Black", 36), EM if val >= 0 else RED, "rm")
            if v.get("note"): T(d, (bx[0] + 12, bx[3] - 22), f"“{v['note']}”", F("SemiBold", 21), TXT, "lm")

    def frame(f):
        t = f / FPS
        img = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(img)
        d.rounded_rectangle([u(20), u(24), u(700), u(150)], radius=u(18), fill=(30, 28, 22))
        T(d, (360, 50), f"ME vs ALGO  ·  {c['weekLabel'].upper()}", F("Bold", 22), GOLD)
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
                T(d, (360, 610), verdict, F("Black", 46), mix(BG, GOLD, k3))
                T(d, (360, 690), f"Season: ME {c['after']['me']} - {c['after']['algo']} ALGO", F("Black", 36), mix(BG, TXT, k3))
                T(d, (360, 760), "Next round: Monday, 9:15", F("Bold", 30), mix(BG, TXT, k3))
                pill(d, 360, 870, 420, 84, "FOLLOW THE SEASON", mix(BG, RED, k3), F("Black", 32))
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
    if spec.get("v") != 1:
        raise SystemExit(f"unsupported spec version {spec.get('v')}")
    kind = spec["content"]["kind"]
    if kind == "mystery": render_mystery(spec, sys.argv[2], sys.argv[3])
    elif kind == "vs": render_vs(spec, sys.argv[2], sys.argv[3])
    else: raise SystemExit(f"unknown template {kind}")


if __name__ == "__main__":
    main()
