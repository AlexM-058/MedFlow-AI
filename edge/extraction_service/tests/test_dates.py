"""Datele calendaristice se găsesc cu reguli fixe (regex), nu cu AI."""

from dates import find_dates
from schemas import DocumentDate


def test_date_with_label_before_it():
    assert find_dates("Data recoltării: 05.09.2025") == [
        DocumentDate(label="Data recoltării", value="05.09.2025")
    ]


def test_several_dates_in_order():
    text = "Data emiterii: 02.11.2025\nRp/ ...\nRevine la control pe 10.11.2025."
    assert find_dates(text) == [
        DocumentDate(label="Data emiterii", value="02.11.2025"),
        DocumentDate(label="Revine la control pe", value="10.11.2025"),
    ]


def test_other_separators_and_iso_format():
    assert [d.value for d in find_dates("a 14/03/2025 b 14-03-2025 c 2025-03-14")] == [
        "14/03/2025", "14-03-2025", "2025-03-14"
    ]


def test_month_written_in_romanian():
    assert find_dates("Data: 14 martie 2025") == [DocumentDate(label="Data", value="14 martie 2025")]


def test_date_without_label():
    assert find_dates("14.03.2025") == [DocumentDate(label=None, value="14.03.2025")]


def test_numbers_that_are_not_dates_are_ignored():
    text = "Hemoglobină 13,5 g/dL 12 - 16\nLeucocite 7.2\nVersiune 1.2.3\nCod 32.13.2025"
    assert find_dates(text) == []


def test_text_without_dates():
    assert find_dates("Ibuprofen, la nevoie") == []


def test_same_date_twice_is_kept_once():
    assert find_dates("Data: 14.03.2025\nData: 14.03.2025") == [
        DocumentDate(label="Data", value="14.03.2025")
    ]
