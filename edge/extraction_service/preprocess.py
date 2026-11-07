"""Pregătirea imaginii pentru OCR: contrast, claritate, mărime potrivită.

Totul e determinist și local (doar Pillow). Imaginea originală nu se modifică și nu se
salvează nicăieri; copia îmbunătățită trăiește doar în memorie, cât durează citirea.

Nu facem binarizare: Tesseract își alege singur pragul, iar o binarizare grosieră strică
fotografiile cu umbre. Îndreptarea textului înclinat (deskew) nu e inclusă încă.
"""

import io

from PIL import Image, ImageFilter, ImageOps

from errors import ExtractionError

# Textul mic dintr-o poză de telefon se citește prost sub ~1600 px pe latura lungă.
MIN_LONG_SIDE = 1600
# Peste atât nu are rost: crește doar timpul de citire.
MAX_LONG_SIDE = 3000
# Cât din pixelii extremi ignorăm la întinderea contrastului (umbre, pete de lumină).
AUTOCONTRAST_CUTOFF = 2
# Protecție împotriva „bombelor de decompresie” (imagini enorme dintr-un fișier mic).
MAX_PIXELS = 60_000_000


def enhance_for_ocr(data: bytes) -> bytes:
    """JPG/PNG -> PNG gri, cu contrast întins, claritate sporită și mărime potrivită."""
    try:
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        raise ExtractionError(422, "Imaginea este deteriorată și nu poate fi citită")

    image = ImageOps.exif_transpose(image)  # poza făcută cu telefonul în picioare
    if image.mode in ("RGBA", "LA", "P"):
        # Fundal alb sub transparență; altfel pixelii transparenți ies negri.
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, image.convert("RGBA"))
    gray = ImageOps.grayscale(image)

    long_side = max(gray.size)
    if long_side < MIN_LONG_SIDE:
        scale = min(MIN_LONG_SIDE / long_side, 3.0)
    elif long_side > MAX_LONG_SIDE:
        scale = MAX_LONG_SIDE / long_side
    else:
        scale = 1.0
    if scale != 1.0:
        gray = gray.resize((round(gray.width * scale), round(gray.height * scale)), Image.Resampling.LANCZOS)

    gray = ImageOps.autocontrast(gray, cutoff=AUTOCONTRAST_CUTOFF)
    gray = gray.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))

    output = io.BytesIO()
    gray.save(output, format="PNG")
    return output.getvalue()
