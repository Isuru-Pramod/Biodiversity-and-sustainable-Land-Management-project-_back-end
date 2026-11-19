"""Build metadata for the original 45-field test table without copying its data."""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path


DEFAULT_CSV = Path(r"D:\data_Input web\Sample cleaned.csv")
BACKEND_DIR = Path(__file__).resolve().parents[1]
CATALOG_PATH = BACKEND_DIR / "data" / "testFieldCatalog.json"
SENSITIVE_PATTERN = re.compile(r"(?:^|_)nic(?:_|$)|telephone|contact|phone", re.I)
REQUIRED_COLUMNS = {
    "Enumerator_name",
    "Date",
    "latitude",
    "longitude",
    "district",
}


def classify(header: str, values: list[str], key: str) -> dict:
    nonblank = [value.strip() for value in values if value and value.strip()]
    unique = list(dict.fromkeys(nonblank))
    sensitive = bool(SENSITIVE_PATTERN.search(header))

    if key == "C001":
        field_type, options, numeric = "number", [], False
    elif header.lower() == "date":
        field_type, options, numeric = "date", [], False
    elif header.lower() in {"latitude", "longitude"}:
        field_type, options, numeric = "number", [], True
    elif nonblank and all(re.fullmatch(r"[-+]?\d+(?:\.\d+)?", value) for value in nonblank):
        field_type, options, numeric = "number", [], True
    elif len(unique) <= 25 and not sensitive and unique:
        field_type = "select"
        options = sorted(unique, key=str.casefold)
        numeric = False
    elif "other" in header.lower() and "selected" in header.lower():
        field_type, options, numeric = "textarea", [], False
    else:
        field_type, options, numeric = "text", [], False

    return {
        "type": field_type,
        "options": options,
        "numeric": numeric,
        "sensitive": sensitive,
        "photo": False,
        "populatedCount": len(nonblank),
        "uniqueCount": len(unique),
    }


def main() -> None:
    rows = None
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            with DEFAULT_CSV.open(encoding=encoding, newline="") as source:
                rows = list(csv.reader(source))
            break
        except UnicodeDecodeError:
            continue
    if not rows or not rows[0]:
        raise ValueError(f"Could not read a CSV header from {DEFAULT_CSV}.")

    headers = rows[0]
    source_rows = rows[1:]
    if len(headers) != 45:
        raise ValueError(f"Expected the original 45-field CSV, found {len(headers)} columns.")

    section_ranges = [
        (1, 15, "respondent-profile", "Respondent and location"),
        (16, 25, "household-farm", "Household and farm"),
        (26, 32, "crops-livelihoods", "Crops and livelihoods"),
        (33, 44, "land-soil", "Land and soil condition"),
        (45, 45, "water-irrigation", "Water and irrigation"),
    ]

    fields = []
    for index, header in enumerate(headers):
        key = f"C{index + 1:03d}"
        section = next(item for item in section_ranges if item[0] <= index + 1 <= item[1])
        values = [row[index] if index < len(row) else "" for row in source_rows]
        details = classify(header, values, key)
        fields.append({
            "key": key,
            "sqlName": header,
            "label": header,
            "displayLabel": "Record ID" if key == "C001" else header.replace("_", " "),
            "ordinal": index + 1,
            "sectionId": section[2],
            "sectionTitle": section[3],
            "questionCode": None,
            "questionTitle": None,
            "type": details["type"],
            "options": details["options"],
            "required": header in REQUIRED_COLUMNS,
            "input": key != "C001",
            "system": key == "C001",
            "sensitive": details["sensitive"],
            "photo": details["photo"],
            "numeric": details["numeric"],
            "populatedCount": details["populatedCount"],
            "uniqueCount": details["uniqueCount"],
        })

    sections = [
        {"id": item[2], "title": item[3]}
        for item in section_ranges
    ]
    catalog = {
        "profile": "test",
        "sourceWorkbook": DEFAULT_CSV.name,
        "sourceSheet": "CSV",
        "sourceRecordCount": len(source_rows),
        "sourceFieldCount": len(fields),
        "sourceSchemaVersion": "sample_cleaned_v1",
        "recordIdColumn": headers[0],
        "recordIdField": "C001",
        "createdAtColumn": None,
        "beneficiaryIdField": "C006",
        "mapFields": {
            "enumerator": "C002",
            "date": "C003",
            "latitude": "C004",
            "longitude": "C005",
            "beneficiaryId": "C006",
            "district": "C007",
            "farmerName": None,
            "nic": "C012",
            "contact": "C013",
            "gender": "C015",
        },
        "sections": sections,
        "fields": fields,
    }

    CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Prepared 45-field test schema metadata from {len(source_rows)} CSV rows.")
    print(f"Field catalog: {CATALOG_PATH}")


if __name__ == "__main__":
    main()
