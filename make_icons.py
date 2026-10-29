from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方形底
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=(37, 99, 235, 255))

# 表盘
cx = cy = S // 2
r = 150
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=26)

# 指针
d.line([cx, cy, cx, cy - 92], fill=(255, 255, 255, 255), width=26)
d.line([cx, cy, cx + 74, cy + 40], fill=(255, 255, 255, 255), width=26)

# 圆心
d.ellipse([cx - 17, cy - 17, cx + 17, cy + 17], fill=(255, 255, 255, 255))

for size in (16, 32, 48, 128):
    icon = img.resize((size, size), Image.LANCZOS)
    icon.save(f"icons/icon{size}.png")
    print(f"icons/icon{size}.png")
