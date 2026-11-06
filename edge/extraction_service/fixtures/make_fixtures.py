"""Generează, din fiecare document fictiv .txt, fișierele pe care le-ar putea încărca un pacient:

  <nume>.pdf       PDF „digital” (textul e salvat ca text)
  <nume>_scan.pdf  PDF „scanat” (pagina e doar o imagine, fără text)
  <nume>.png       poză PNG
  <nume>.jpg       poză JPG

Rulare (din folderul extraction_service):
  .venv\\Scripts\\python fixtures\\make_fixtures.py
"""

import pathlib

import pymupdf

HERE = pathlib.Path(__file__).parent
OUTPUT = HERE / "generated"

# Un font monospațiat care are literele românești (ă, â, î, ș, ț).
# Fonturile încorporate în PDF (Helvetica, Courier) NU au „ș” și „ț”.
FONT_CANDIDATES = [
    pathlib.Path("C:/Windows/Fonts/cour.ttf"),
    pathlib.Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    pathlib.Path("/System/Library/Fonts/Supplemental/Courier New.ttf"),
]


def find_font() -> pathlib.Path:
    for path in FONT_CANDIDATES:
        if path.exists():
            return path
    raise SystemExit("Nu am găsit un font cu diacritice românești. Adaugă unul în FONT_CANDIDATES.")


def make_text_pdf(text: str, font: pathlib.Path) -> pymupdf.Document:
    lines = text.splitlines()
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=60 + 17 * len(lines))
    page.insert_text((30, 40), text, fontsize=11, fontname="docfont", fontfile=str(font))
    # Păstrăm în PDF doar literele folosite din font, nu tot fontul (830 KB -> câțiva KB).
    doc.subset_fonts()
    return doc


def make_scanned_pdf(png: bytes, width: float, height: float) -> pymupdf.Document:
    doc = pymupdf.open()
    page = doc.new_page(width=width, height=height)
    page.insert_image(page.rect, stream=png)
    return doc


def main() -> None:
    font = find_font()
    OUTPUT.mkdir(exist_ok=True)
    for txt_file in sorted(HERE.glob("*.txt")):
        name = txt_file.stem
        pdf = make_text_pdf(txt_file.read_text(encoding="utf-8"), font)
        page = pdf[0]
        picture = page.get_pixmap(dpi=130)
        png = picture.tobytes("png")

        (OUTPUT / f"{name}.pdf").write_bytes(pdf.tobytes(garbage=3, deflate=True))
        (OUTPUT / f"{name}.png").write_bytes(png)
        (OUTPUT / f"{name}.jpg").write_bytes(picture.tobytes("jpg", jpg_quality=80))
        scanned = make_scanned_pdf(png, page.rect.width, page.rect.height)
        (OUTPUT / f"{name}_scan.pdf").write_bytes(scanned.tobytes(garbage=3, deflate=True))
        print(f"{name}: pdf, scan.pdf, png, jpg")


if __name__ == "__main__":
    main()
