"""Render 10 SYNTHETIC till-slip images with PIL (invented merchants/amounts). Writes PNGs, receipts-truth.json,
and ../../apps/mobile/src/lab/data/receipts.json (base64 PNGs, NO truth) for the phone."""
import base64, io, json, random, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

random.seed(7)
HERE = os.path.dirname(__file__)
APP = os.path.join(HERE, "../../../apps/mobile/src/lab/data")
OUT = os.path.join(HERE, "receipts")
os.makedirs(OUT, exist_ok=True)
MONO = next(p for p in ["/usr/share/fonts/liberation-mono-fonts/LiberationMono-Regular.ttf", "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf", "/usr/share/fonts/google-noto/NotoSansMono-Regular.ttf"] if os.path.exists(p))
BOLD = MONO.replace("Regular", "Bold")
if not os.path.exists(BOLD): BOLD = MONO

MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
SPEC = [  # merchant, items, date style, currency style
 ("SAMPLE SUPERMARKET WESTLANDS", [("BREAD 400G", 65), ("MILK 1L", 130), ("SUGAR 2KG", 320), ("EGGS TRAY", 480)], "slash", "KES"),
 ("MAMA MBOGA SAMPLE STALL", [("TOMATOES", 80), ("ONIONS", 60), ("KALE", 40)], "dash", "none"),
 ("SAMPLE HARDWARE AND PAINTS", [("PAINT 4L", 2400), ("BRUSH", 350), ("NAILS 1KG", 450)], "mon", "Ksh"),
 ("SAMPLE PHARMACY CHEMIST", [("PARACETAMOL", 120), ("ORS SACHET", 90), ("VITAMIN C", 550), ("BANDAGE", 200)], "slash", "KES"),
 ("SAMPLE PETROL STATION KAREN", [("UNLEADED 12.5L", 2375)], "dot", "KES"),
 ("SAMPLE FASHION BOUTIQUE", [("DRESS", 1899), ("BELT", 650)], "mon", "KES"),
 ("SAMPLE BUTCHERY", [("BEEF 2KG", 1300), ("SAUSAGES", 450)], "slash", "none"),
 ("SAMPLE ELECTRONICS MART", [("PHONE CASE", 800), ("USB CABLE", 450), ("EARPHONES", 1500)], "dash", "Ksh"),
 ("SAMPLE KFC-STYLE CHICKEN HUT", [("2PC MEAL", 780), ("SODA", 120)], "slash", "KES"),
 ("SAMPLE STATIONERS LTD", [("EXERCISE BOOKS 10", 600), ("PENS BOX", 350), ("CALCULATOR", 1250)], "dot", "KES"),
]
def fmt(n, style):
    s = f"{n:,.2f}"
    return {"KES": f"KES {s}", "Ksh": f"Ksh {s}", "none": s}[style]
truth, app = [], []
for i, (merch, items, ds, cs) in enumerate(SPEC):
    d, m, y = random.randint(1, 28), random.randint(1, 12), 2026
    hh, mm = random.randint(7, 20), random.randint(0, 59)
    date = {"slash": f"{d:02d}/{m:02d}/{y}", "dash": f"{d:02d}-{m:02d}-{y}", "mon": f"{d:02d} {MON[m-1]} {y}", "dot": f"{d:02d}.{m:02d}.{y%100:02d}"}[ds]
    sub = sum(p for _, p in items); vat = round(sub * 0.16 / 1.16, 2) if i % 2 == 0 else 0
    total = sub
    lines = [("c", merch, True), ("c", "P.O. BOX 00000 NAIROBI", False), ("c", "TEL: 0700 000 %03d" % (100 + i), False), ("c", f"PIN: P0{51000000 + i * 137}X", False), ("c", "-" * 32, False),
             ("l", f"DATE: {date} {hh:02d}:{mm:02d}", False), ("l", f"RCPT NO: {1000 + i * 17}", False), ("c", "-" * 32, False)]
    for n, p in items: lines.append(("lr", (n, f"{p:,.2f}"), False))
    lines.append(("c", "-" * 32, False))
    lines.append(("lr", ("SUBTOTAL", f"{sub:,.2f}"), False))
    if vat: lines.append(("lr", ("VAT 16% incl", f"{vat:,.2f}"), False))
    lines.append(("lr", ("TOTAL", fmt(total, cs)), True))
    lines += [("lr", ("PAID M-PESA", fmt(total, cs)), False), ("c", f"TILL NO: {123400 + i}", False), ("c", "THANK YOU, COME AGAIN", False)]
    W, size = 560, 24
    f, fb = ImageFont.truetype(MONO, size), ImageFont.truetype(BOLD, size)
    H = 40 + len(lines) * (size + 10) + 40
    im = Image.new("L", (W, H), 245)
    dr = ImageDraw.Draw(im)
    y0 = 30
    for kind, val, bold in lines:
        ft = fb if bold else f
        if kind == "c": dr.text(((W - dr.textlength(val, font=ft)) / 2, y0), val, font=ft, fill=25)
        elif kind == "l": dr.text((30, y0), val, font=ft, fill=25)
        else:
            dr.text((30, y0), val[0], font=ft, fill=25); dr.text((W - 30 - dr.textlength(val[1], font=ft), y0), val[1], font=ft, fill=25)
        y0 += size + 10
    # phone-photo-ish: slight rotation, blur, noise, shadow gradient
    im = im.rotate(random.uniform(-1.2, 1.2), expand=True, fillcolor=235, resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.6))
    px = im.load()
    for yy in range(im.height):
        for xx in range(im.width):
            v = px[xx, yy] + random.randint(-2, 2) - int(14 * xx / im.width)
            px[xx, yy] = max(0, min(255, v))
    p = os.path.join(OUT, f"rcpt{i+1:02d}.png"); im.save(p, optimize=True)
    iso = f"{y}-{m:02d}-{d:02d}"
    truth.append({"id": f"rcpt{i+1:02d}", "merchant": merch, "date": iso, "total": float(total)})
    buf = io.BytesIO(); im.save(buf, "PNG", optimize=True)
    app.append({"id": f"rcpt{i+1:02d}", "png": base64.b64encode(buf.getvalue()).decode()})
json.dump(truth, open(os.path.join(HERE, "receipts-truth.json"), "w"), indent=1)
json.dump(app, open(os.path.join(APP, "receipts.json"), "w"))
print("receipts", len(app), sum(len(a["png"]) for a in app) // 1024, "KB b64")
