"""Pregătirea imaginii pentru OCR (preprocess.py): contrast, mărime, imagini deteriorate."""

import io

import pytest
from PIL import Image, ImageDraw, ImageStat

import preprocess
from errors import ExtractionError


def low_contrast_png() -> bytes:
    """O poză „spălată”: text gri pe fundal gri deschis, mică."""
    image = Image.new("L", (400, 120), 150)
    ImageDraw.Draw(image).text((10, 40), "Paracetamol 500 mg", fill=120)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_enhance_raises_contrast_and_size():
    original = low_contrast_png()
    enhanced = preprocess.enhance_for_ocr(original)
    before = Image.open(io.BytesIO(original))
    after = Image.open(io.BytesIO(enhanced))
    assert after.mode == "L"
    # O imagine mică e mărită, dar nu cu mai mult de 3x (peste, doar crește zgomotul).
    assert before.width < after.width <= before.width * 3
    assert ImageStat.Stat(after).stddev[0] > ImageStat.Stat(before).stddev[0]


def test_enhance_does_not_change_the_original_bytes():
    original = low_contrast_png()
    snapshot = bytes(original)
    preprocess.enhance_for_ocr(original)
    assert original == snapshot


def test_enhance_rejects_a_corrupt_image():
    with pytest.raises(ExtractionError) as error:
        preprocess.enhance_for_ocr(b"\x89PNG\r\n\x1a\nnot really a png")
    assert error.value.status_code == 422
