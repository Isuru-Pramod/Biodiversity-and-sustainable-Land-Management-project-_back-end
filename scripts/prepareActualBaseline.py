"""Prepare the supplied baseline workbook for the one-time SQL Server import.

This script deliberately keeps private respondent values in a git-ignored
NDJSON file. The field catalog contains labels and schema metadata only.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import unicodedata
from pathlib import Path

from openpyxl import load_workbook


DEFAULT_WORKBOOK = Path(r"D:\data_Input web\Productivity improvement_Tea Small holder_base_line.xlsx")
BACKEND_DIR = Path(__file__).resolve().parents[1]
CATALOG_PATH = BACKEND_DIR / "data" / "baselineFieldCatalog.json"
ROWS_PATH = BACKEND_DIR / "private-data" / "actual-baseline.ndjson"

STATIC_LABEL_PATTERNS = (
    re.compile(r"^enumerator guidance:", re.I),
    re.compile(r"^end of baseline questionnaire", re.I),
    re.compile(r"^do not capture the after photograph", re.I),
    re.compile(r"^for evaluation of field status, field map is required", re.I),
)
SENSITIVE_PATTERN = re.compile(
    r"\bnic\b|\btelephone\b|\bcontact\s*(?:no\.?|number)\b|\bphone\b|"
    r"\bsmall holder\b|\bbeneficiary photograph\b|\bid[-\s]?card\b",
    re.I,
)
MEASURE_WORDS = ("area", "extent", "age", "number", "no.", "income", "frequency", "ph level", "percent", "%", "quantity", "distance", "count", "years", "plants")
TRUE_VALUES = {"1", "true", "yes", "y", "checked", "selected", "x"}
FALSE_VALUES = {"0", "false", "no", "n", "unchecked", "not selected", ""}


def text_value(value):
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.date().isoformat() if value.time() == dt.time() else value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return format(value, ".15g")
    return str(value)


def parse_question(label):
    match = re.match(r"^\s*(\d+[a-z]?)\.\s*(.*)$", label, re.I)
    if not match:
        return None
    return match.group(1).lower(), match.group(2).strip()


def sql_column_name(label, ordinal):
    normalized = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "_", normalized).strip("_") or "Field"
    return ("C" + f"{ordinal:03d}" + "_" + slug)[:128]


def classify_field(label, values):
    lower = label.lower()
    populated = [value for value in values if value is not None and str(value).strip() != ""]
    unique = list(dict.fromkeys(str(value) for value in populated))
    sensitive = bool(SENSITIVE_PATTERN.search(lower))
    identifier = (
        lower in {"_id", "_index"}
        or bool(re.search(r"\brecord\s*id\b|\bbeneficiary\s*id\b|\bregistration/reference\s*no\b", lower))
    )
    is_photo = any(term in lower for term in ("photograph", "photo", "image", "evidence"))
    is_url = "_url" in lower or lower.endswith(" url")
    is_numeric_values = bool(populated) and all(
        re.fullmatch(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", str(value).strip())
        for value in populated
    )
    normalized_unique = {value.strip().lower() for value in unique}
    is_binary = bool(unique) and normalized_unique <= (TRUE_VALUES | FALSE_VALUES) and bool(normalized_unique & TRUE_VALUES)
    is_date = "date" in lower or any(isinstance(value, (dt.date, dt.datetime)) for value in populated)
    measurement = any(term in lower for term in MEASURE_WORDS)

    if identifier:
        field_type = "text"
    elif is_date:
        field_type = "date"
    elif ":/" in label and (is_binary or not populated):
        field_type = "checkbox"
    elif is_numeric_values and measurement and not sensitive:
        field_type = "number"
    elif is_binary:
        field_type = "select"
    elif unique and len(unique) <= 25 and not sensitive and not is_photo and "specify" not in lower and "other (" not in lower:
        field_type = "select"
    elif not populated and ("select from list" in lower or "select one" in lower):
        field_type = "select"
    elif is_numeric_values and not sensitive:
        field_type = "number"
    elif not populated and measurement and not sensitive:
        field_type = "number"
    elif not populated and "select from list" in lower:
        field_type = "text"
    elif not populated and re.search(r"\b(?:does|do|is|are|has|have|consent|done)\b", lower):
        field_type = "select"
    elif is_url:
        field_type = "url"
    elif "specify" in lower or len(label) > 95:
        field_type = "textarea"
    else:
        field_type = "text"

    options = []
    if field_type == "select" and unique and len(unique) <= 25 and not sensitive:
        options = sorted(unique, key=lambda item: item.casefold())
    elif field_type == "select" and not unique:
        options = ["Yes", "No"]

    return {
        "type": field_type,
        "options": options,
        "numeric": field_type == "number",
        "sensitive": sensitive or is_photo or is_url,
        "photo": is_photo,
        "populatedCount": len(populated),
        "uniqueCount": len(unique),
    }


def make_section(label, current):
    question = parse_question(label)
    if question:
        code = question[0]
        question_number = int(re.match(r"\d+", code).group(0))
        first = ((question_number - 1) // 20) * 20 + 1
        last = first + 19
        return {"id": f"questions-{first}-{last}", "title": f"Baseline questions {first}–{last}"}
    lower = label.lower()
    if label in {"_id", "_index"}:
        return {"id": "source-metadata", "title": "Source metadata"}
    if lower.startswith("does the respondent consent"):
        return current
    if any(pattern.search(label) for pattern in STATIC_LABEL_PATTERNS):
        return {"id": "guidance", "title": "Questionnaire guidance"}
    if any(term in lower for term in ("photograph", "photo", "image", "evidence")):
        return {"id": "photo-evidence", "title": "Photo and evidence references"}
    if "_url" in lower or lower.endswith(" url"):
        return {"id": "photo-evidence", "title": "Photo and evidence references"}
    return current


def main():
    parser = argparse.ArgumentParser(description="Prepare baseline workbook data and field catalog.")
    parser.add_argument("workbook", nargs="?", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--catalog", type=Path, default=CATALOG_PATH)
    parser.add_argument("--rows", type=Path, default=ROWS_PATH)
    args = parser.parse_args()

    workbook = load_workbook(args.workbook, read_only=True, data_only=True)
    if "Master_Clean" not in workbook.sheetnames:
        raise ValueError("Expected the Master_Clean worksheet in the supplied workbook.")
    sheet = workbook["Master_Clean"]
    iterator = sheet.iter_rows(values_only=True)
    headers = [text_value(value) or f"Unnamed field {index + 1}" for index, value in enumerate(next(iterator))]
    source_rows = list(iterator)
    header_counts = collections.Counter(headers)
    duplicate_occurrences = collections.Counter()
    fields = []
    sections = []
    seen_sections = set()
    current_section = {"id": "survey", "title": "Survey information"}
    current_question_code = None
    current_question_title = None
    source_to_key = []

    for index, header in enumerate(headers):
        parsed_question = parse_question(header)
        selected_section = make_section(header, current_section)
        if parsed_question:
            current_question_code, current_question_title = parsed_question
            current_question_title = re.split(r"[:/]\s*", current_question_title, maxsplit=1)[0].strip()
            current_section = selected_section
        elif selected_section["id"] not in {"source-metadata", "guidance", "photo-evidence"}:
            selected_section = current_section
        if selected_section["id"] not in seen_sections:
            sections.append(selected_section)
            seen_sections.add(selected_section["id"])

        key = f"C{index + 1:03d}"
        field_values = [row[index] for row in source_rows]
        details = classify_field(header, field_values)
        normalized_header = header.strip().lower()
        system = normalized_header in {"_id", "_index"}
        static = any(pattern.search(header) for pattern in STATIC_LABEL_PATTERNS)
        is_input = (
            not system
            and not static
            and not normalized_header.startswith("gef 7 ld bd project:")
            and normalized_header != "beneficiary / record id"
        )
        required = normalized_header in {
            "enumerator name",
            "date",
            "_gps coordinate_latitude",
            "_gps coordinate_longitude",
            "1. district:",
        }
        required = required or normalized_header.startswith("8. tea small holder")
        display_label = header
        if header_counts[header] > 1:
            duplicate_occurrences[header] += 1
            question_hint = f"Q{current_question_code.upper()}" if current_question_code else selected_section["title"]
            display_label = f"{header} — {question_hint} ({duplicate_occurrences[header]})"

        fields.append({
            "key": key,
            "sqlName": sql_column_name(header, index + 1),
            "label": header,
            "displayLabel": display_label,
            "ordinal": index + 1,
            "sectionId": selected_section["id"],
            "sectionTitle": selected_section["title"],
            "questionCode": (
                parsed_question[0]
                if parsed_question
                else None if selected_section["id"] in {"source-metadata", "guidance", "photo-evidence"}
                else current_question_code
            ),
            "questionTitle": (
                current_question_title
                if selected_section["id"] not in {"source-metadata", "guidance", "photo-evidence"}
                else None
            ),
            "type": details["type"],
            "options": details["options"],
            "required": required,
            "input": is_input,
            "system": system,
            "sensitive": details["sensitive"],
            "photo": details["photo"],
            "numeric": details["numeric"],
            "populatedCount": details["populatedCount"],
            "uniqueCount": details["uniqueCount"],
        })
        source_to_key.append(key)

    id_field = next((field["key"] for field in fields if field["label"] == "Beneficiary / Record ID"), None)
    catalog = {
        "sourceWorkbook": args.workbook.name,
        "sourceSheet": sheet.title,
        "sourceRecordCount": len(source_rows),
        "sourceFieldCount": len(fields),
        "sourceSchemaVersion": "master_clean_v1",
        "profile": "actual",
        "recordIdColumn": "RecordId",
        "recordIdField": None,
        "createdAtColumn": "CreatedAt",
        "beneficiaryIdField": id_field,
        "mapFields": {
            "enumerator": "C002",
            "date": "C003",
            "latitude": "C004",
            "longitude": "C005",
            "beneficiaryId": "C006",
            "district": "C009",
            "farmerName": "C016",
            "nic": "C018",
            "contact": "C019",
            "gender": "C021",
        },
        "sections": sections,
        "fields": fields,
    }

    args.catalog.parent.mkdir(parents=True, exist_ok=True)
    args.rows.parent.mkdir(parents=True, exist_ok=True)
    args.catalog.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    with args.rows.open("w", encoding="utf-8", newline="\n") as output:
        for row_index, row in enumerate(source_rows, start=2):
            values = {key: text_value(row[index]) for index, key in enumerate(source_to_key)}
            output.write(json.dumps({"sourceRow": row_index, "values": values}, ensure_ascii=False) + "\n")

    print(f"Prepared {len(source_rows)} records, {len(fields)} fields, {len(sections)} sections.")
    print(f"Field catalog: {args.catalog}")
    print(f"Private import payload: {args.rows}")


if __name__ == "__main__":
    main()
