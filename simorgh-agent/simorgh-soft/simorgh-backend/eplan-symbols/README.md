# EPLAN symbols — the symbol pack

Whatever SVG is in this folder is drawn on the single line **instead of** the
app's own symbol. Adding one is a copy and a refresh: no rebuild, no restart.

* on the server: `simorgh-agent/simorgh-soft/simorgh-backend/eplan-symbols/`
* in the container: `/app/eplan-symbols` (read-only, `EPLAN_SYMBOL_DIR`,
  mounted in `simorgh-agent/compose/soft-app.yml`)

```bash
cp MY-SYMBOL.svg ~/simorgh-chatbot-ekc-deploy/simorgh-agent/simorgh-soft/simorgh-backend/eplan-symbols/
# then reload the Eplanix tab in the browser (Ctrl+Shift+R)
```

Check what the app can see:

```bash
curl -s http://127.0.0.1/simorgh-design-suite/api/eplan-symbols/pack | jq
# {"symbols":[{"name":"vcb","width":152,"height":267,"pinX":135,"title":"…"}]}
```

The Eplanix tab says the same thing on screen: **Eplanix → Symbols** marks
every symbol that came from the pack with a green border and *from the pack*,
and the single-line header counts them.

---

## The two ways a file is used

### 1. By the name of the EPLAN symbol — one part

Name the file after the symbol EPLAN's function template names for that part —
`SG3.svg`, `K1.svg`, `T1.svg`. Every part whose template names that symbol is
drawn with it. Which symbol a part uses is what
`POST /api/eplan-symbols/lookup` reports, and `GET /api/eplan-symbols/schema`
says which table and column of the parts database the names are read from.

Use this when one particular part must be drawn a particular way.

### 2. By the name of a symbol in the library — every part of that kind

Name the file after one of the app's own symbols — `vcb.svg`,
`current-transformer.svg`, `protection-relay.svg` — and it replaces that symbol
**everywhere**: on every sheet, in the printed set and in the library view. No
part number, no EPLAN look-up, nothing else to set up.

Use this to put the office's own drawing of a device into the app. The full
list of names is at the bottom of this file.

---

## What a symbol file has to look like

| | |
|---|---|
| format | `.svg` (a vector export is best; an SVG carrying a bitmap works too) |
| background | **transparent** — a white rectangle in the file paints over the branch line |
| ink | black or near-black, so it reads on a white sheet |
| trimmed | cropped to the drawing itself, with no empty canvas around it |
| `viewBox` | required — it is what the app scales by |
| size | keep it under ~200 KB; the sheet carries one copy per device drawn |

Optional attributes on the `<svg>` element, all of them read by the app:

| attribute | what it does | default |
|---|---|---|
| `data-pin-x` | where the conductor runs **across** the symbol, in viewBox units — the app puts this point on the branch line | the middle of the box |
| `data-cells` | how many cells (40 units each) the symbol takes down the line | rounded from height ÷ width, 1–4 |
| `data-title` | the tooltip on the drawing | the symbol's name |

`data-pin-x` is the one that matters: a breaker drawn with its racking gear to
the left has its conductor far to the right of the picture's middle, and
without it the whole symbol is drawn off the line.

A minimal file:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 152 267"
     data-pin-x="135" data-cells="2" data-title="VACUUM CIRCUIT BREAKER (V.C.B)">
  <!-- the drawing, in the 0 0 152 267 box -->
</svg>
```

---

## Exporting from EPLAN

1. Open the symbol in the symbol editor, or place it on an empty page.
2. *Page → Export → Image file*, or *File → Export → DXF/SVG*.
3. Save it under the symbol's own name (`SG3.svg`) or under the library name
   you want to replace (`vcb.svg`).
4. Open the file once and check three things: no white background rectangle,
   a `viewBox` on the `<svg>` element, and no empty margin around the drawing.

## Turning a picture into a symbol file

A drawing tool that exports "SVG" often writes a **bitmap wrapped in an SVG** —
one `<image href="data:image/png;base64,…">` on a big empty canvas, usually
with a white background. That renders badly: tiny, off the line, and painting
a white box over the branch. It still works once it is cleaned up:

```python
# pip install pillow
from PIL import Image, ImageFile
import base64, io, re
ImageFile.LOAD_TRUNCATED_IMAGES = True

src = re.search(r'base64,([^"]+)"', open('exported.svg').read()).group(1)
im = Image.open(io.BytesIO(base64.b64decode(src))).convert('RGBA')

# 1 — find the ink and crop to it
px = im.load()
ink = [(x, y) for y in range(im.height) for x in range(im.width)
       if px[x, y][3] > 40 and sum(px[x, y][:3]) / 3 < 200]
x0 = min(x for x, _ in ink) - 2; x1 = max(x for x, _ in ink) + 2
y0 = min(y for _, y in ink) - 2; y1 = max(y for _, y in ink) + 2
crop = im.crop((x0, y0, x1, y1))

# 2 — paper transparent, ink black (the anti-aliasing survives)
out = Image.new('RGBA', crop.size, (0, 0, 0, 0))
cp, op = crop.load(), out.load()
for y in range(out.height):
    for x in range(out.width):
        r, g, b, a = cp[x, y]
        alpha = 0 if a == 0 else max(0, min(255, int(255 - (r + g + b) / 3)))
        if alpha:
            op[x, y] = (0, 0, 0, alpha)

# 3 — wrap it with a viewBox and the conductor's place
buf = io.BytesIO(); out.save(buf, format='PNG', optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
pin = 157 - x0          # the x of the conductor, measured in the original
open('vcb.svg', 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {out.width} {out.height}" '
    f'data-pin-x="{pin}" data-title="VACUUM CIRCUIT BREAKER (V.C.B)">'
    f'<image x="0" y="0" width="{out.width}" height="{out.height}" '
    f'href="data:image/png;base64,{b64}"/></svg>')
```

Find the conductor's x by looking for the column with the most ink:

```python
col = [sum(1 for y in range(im.height)
           if px[x, y][3] > 40 and sum(px[x, y][:3]) / 3 < 200) for x in range(im.width)]
print(col.index(max(col)))      # → the conductor, in the original image
```

`vcb.svg` in this folder was made exactly this way — read it as a worked
example. A bitmap is always a little soft on screen; a vector export from
EPLAN is sharper, and nothing else about the file changes.

---

## When it does not look right

| what you see | why | what to do |
|---|---|---|
| the symbol is tiny in a corner | the file is one small picture on a big empty canvas | crop the canvas to the drawing (`viewBox` = the drawing's box) |
| a white box over the branch line | the file has a white background | make the background transparent |
| the symbol sits beside the line, not on it | its conductor is not in the middle of the picture | add `data-pin-x` |
| it is squashed or stretched | `width`/`height` disagree with the drawing's proportions | let the `viewBox` set the proportions and drop `width`/`height` |
| too short or too tall for the sheet | the app guessed the cells from the proportions | set `data-cells` (1–4) |
| nothing changed | the browser cached the old sheet | Ctrl+Shift+R; check the file is listed by `/api/eplan-symbols/pack` |
| the file is not listed at all | wrong folder, or not `.svg` | it must be `eplan-symbols/*.svg`; the name is the part before `.svg` |

The name is matched without case (`VCB.svg` and `vcb.svg` are the same symbol),
and only letters, digits, `_`, `.` and `-` are allowed in it.

---

## The library names

One of these as a file name replaces that symbol everywhere.

**Switching**

| file name | symbol | فارسی |
|---|---|---|
| `vcb.svg` | Vacuum circuit breaker (V.C.B) | کلید وکیوم |
| `vcb-racking.svg` | V.C.B with spring charge and racking | کلید وکیوم با شارژ فنر |
| `vacuum-contactor-fuse.svg` | Vacuum contactor with HRC fuse (V.C) | کنتاکتور وکیوم با فیوز |
| `circuit-breaker.svg` | Circuit breaker | کلید اتوماتیک |
| `withdrawable-cb.svg` | Withdrawable circuit breaker | کلید کشویی |
| `disconnector.svg` | Disconnector / isolator | سکسیونر |
| `switch-disconnector.svg` | Switch disconnector (load break) | کلید قابل قطع زیر بار |
| `contactor.svg` | Contactor | کنتاکتور |
| `motor-starter.svg` | Motor starter (CB + contactor) | راه‌انداز موتور |
| `earthing-switch.svg` | Earth switch | کلید ارت |
| `mcb.svg` | Miniature circuit breaker | کلید مینیاتوری |
| `ats.svg` | Automatic transfer switch | کلید تعویض خودکار |

**Protection**

| file name | symbol | فارسی |
|---|---|---|
| `hrc-fuse.svg` | HRC fuse | فیوز HRC |
| `fuse.svg` | Fuse | فیوز |
| `switch-fuse.svg` | Switch fuse | کلید فیوزدار |
| `thermal-overload.svg` | Thermal overload relay (bimetal) | بی‌متال (رله حرارتی) |
| `protection-relay.svg` | Protection relay | رله حفاظتی |
| `earth-fault-relay.svg` | Earth fault relay | رله ارت فالت |
| `surge-arrester.svg` | Surge arrester | برقگیر |
| `surge-limiter.svg` | Surge limiter | محدودکنندهٔ اضافه ولتاژ |
| `ptc.svg` | PTC thermistor | PTC |

**Measuring**

| file name | symbol | فارسی |
|---|---|---|
| `current-transformer.svg` | Current transformer | ترانس جریان (CT) |
| `core-balance-ct.svg` | Core balance CT | CT کر بالانس |
| `voltage-transformer.svg` | Voltage transformer (PT/VT) | ترانس ولتاژ (PT) |
| `transformer.svg` | Two winding transformer | ترانسفورماتور دو سیم‌پیچ |
| `ammeter.svg` | Ammeter | آمپرمتر |
| `voltmeter.svg` | Voltmeter | ولت‌متر |
| `multimeter.svg` | Multimeter | مولتی‌متر |
| `watt-meter.svg` | Watt meter | وات‌متر |
| `var-meter.svg` | VAR meter | وارمتر |
| `power-factor-meter.svg` | Power factor meter | کسینوس‌فی‌متر |
| `frequency-meter.svg` | Frequency meter | فرکانس‌متر |
| `hour-meter.svg` | Hour meter | ساعت‌شمار |
| `kwh-meter.svg` | Kilo watt-hour meter | کنتور کیلووات‌ساعت |
| `kvarh-meter.svg` | Kilo var-hour meter | کنتور کیلووار‌ساعت |
| `transducer.svg` | Transducer | ترانسدیوسر |
| `selector-switch.svg` | Selector switch | سلکتور سوییچ |
| `voltage-selector.svg` | Voltage selector switch | سلکتور ولتاژ |
| `ampere-selector.svg` | Ampere selector switch | سلکتور آمپر |
| `capacitive-divider.svg` | Capacitive voltage divider | مقسم ولتاژ خازنی |

**Loads**

| file name | symbol | فارسی |
|---|---|---|
| `motor.svg` | Motor | موتور |
| `generator.svg` | Generator | ژنراتور |
| `heater.svg` | Heating element | المنت حرارتی |
| `lamp.svg` | Lamp / indicator light | چراغ سیگنال |
| `socket.svg` | Socket outlet | پریز |
| `capacitor.svg` | Capacitor | خازن |
| `capacitor-delta.svg` | Capacitor, delta connection | خازن مثلث |
| `drive.svg` | Frequency converter | درایو (اینورتر) |
| `soft-starter.svg` | Soft starter | سافت استارتر |
| `magnet.svg` | Magnet | مگنت |
| `alarm-annunciator.svg` | Alarm annunciator | آنانسیاتور آلارم |
| `lcs.svg` | Local control station (LCS) | ایستگاه کنترل محلی |

**Connections**

| file name | symbol | فارسی |
|---|---|---|
| `terminal.svg` | Terminal | ترمینال |
| `test-block.svg` | Test box | ترمینال تست |
| `key-interlock.svg` | Key interlock | اینترلاک کلیدی |
| `mechanical-interlock.svg` | Mechanical interlock | اینترلاک مکانیکی |
| `bus-duct.svg` | Bus duct / bus bridge | باس‌داکت |
| `link.svg` | Hard wire connection | اتصال سیمی |
| `outgoing.svg` | Outgoing feeder | خروجی |
| `incoming.svg` | Incoming supply | ورودی |
| `accessory.svg` | Accessory (belongs to the device above) | متعلقات |
