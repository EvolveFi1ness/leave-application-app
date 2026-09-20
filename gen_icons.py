from PIL import Image, ImageDraw

def make(size, pad=0):
    s = size
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = int(s * pad)
    d.rounded_rectangle([m, m, s - m, s - m], radius=int(s * 0.22), fill=(30, 42, 90, 255))
    # calendar sheet
    x0, y0 = int(s * 0.28), int(s * 0.30)
    x1, y1 = int(s * 0.72), int(s * 0.74)
    d.rounded_rectangle([x0, y0, x1, y1], radius=int(s * 0.05), fill=(255, 255, 255, 255))
    d.rounded_rectangle([x0, y0, x1, int(s * 0.42)], radius=int(s * 0.05), fill=(79, 70, 229, 255))
    d.rectangle([x0, int(s * 0.40), x1, int(s * 0.43)], fill=(79, 70, 229, 255))
    # check mark
    w = max(2, int(s * 0.035))
    d.line([(x0 + (x1 - x0) * 0.28, y0 + (y1 - y0) * 0.62),
            (x0 + (x1 - x0) * 0.45, y0 + (y1 - y0) * 0.76),
            (x0 + (x1 - x0) * 0.74, y0 + (y1 - y0) * 0.44)],
           fill=(21, 128, 61, 255), width=w, joint='curve')
    return img

make(192).save('public/icons/icon-192.png')
make(512).save('public/icons/icon-512.png')
make(512, pad=0.1).save('public/icons/icon-maskable.png')
# apple touch (no alpha)
bg = Image.new('RGB', (180, 180), (30, 42, 90))
bg.paste(make(180), (0, 0), make(180))
bg.save('public/icons/apple-touch.png')
print('icons done')
