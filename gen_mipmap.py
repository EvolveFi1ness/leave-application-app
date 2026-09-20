from PIL import Image
import os
src = Image.open('public/icons/icon-512.png')
base = 'LeaveMS-android/app/src/main/res'
for d, px in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
    p = os.path.join(base, f'mipmap-{d}')
    os.makedirs(p, exist_ok=True)
    src.resize((px, px), Image.LANCZOS).save(os.path.join(p, 'ic_launcher.png'))
print('mipmaps done')
