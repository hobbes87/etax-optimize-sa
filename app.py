from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_UP
from pathlib import Path
from typing import Any

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from streamlit.errors import StreamlitSecretNotFoundError
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from database import (
    DEFAULT_DATABASE_URL,
    TaxRecord,
    UserAccount,
    configure_database,
    init_db,
    session_scope,
    sqlite_url_for_path,
)


ROOT = Path(__file__).resolve().parent


def get_secret(key: str, default: str = "") -> str:
    """Retrieve a secret from Streamlit Secrets, the environment, or a local fallback."""
    try:
        value = st.secrets.get(key)
    except StreamlitSecretNotFoundError:
        value = None
    if value is not None and str(value):
        return str(value)
    return os.getenv(key) or default


PAYGATE_SECRET = get_secret(
    "PAYGATE_SECRET_KEY",
    get_secret("PAYGATE_HMAC_SECRET", "SecretPayGateKey123"),
)
APP_SECRET = get_secret("APP_SECRET_KEY", "default-dev-secret-key")
DATABASE_URL = get_secret("DATABASE_URL")
if not DATABASE_URL:
    DB_PATH = get_secret("DB_PATH")
    DATABASE_URL = sqlite_url_for_path(DB_PATH) if DB_PATH else DEFAULT_DATABASE_URL
configure_database(DATABASE_URL)
SUPPORTED_UPLOADS = ["pdf", "csv", "xlsx", "xls", "png", "jpg", "jpeg", "json", "txt", "docx"]
SARS_CODES = ["3601", "4006", "4028", "4020", "4201", "4102", "9999"]
STAGES = [
    "0 · Auth & Vault",
    "1 · Classification & Profile",
    "2 · Documents & OCR",
    "3 · Source-Code Ledger",
    "4 · Tax Engine & Preview",
    "5 · Guided eFiling",
    "6 · ITA34 Audit & Lock",
]

# The 2024 and 2025 year-of-assessment tables use these thresholds and rebates.
TAX_BRACKETS = [
    (237_100, Decimal("0.18"), Decimal("0"), 0),
    (370_500, Decimal("0.26"), Decimal("42678"), 237_100),
    (512_800, Decimal("0.31"), Decimal("77362"), 370_500),
    (673_000, Decimal("0.36"), Decimal("121475"), 512_800),
    (857_900, Decimal("0.39"), Decimal("179147"), 673_000),
    (1_817_000, Decimal("0.41"), Decimal("251258"), 857_900),
    (None, Decimal("0.45"), Decimal("644489"), 1_817_000),
]
REDEMPTIONS = {"primary": 17_235, "secondary": 9_444, "tertiary": 3_145}
TAX_STATES = {
    "DRAFT",
    "CALCULATED_PREVIEW",
    "PAID_UNLOCKED",
    "EFILING_IN_PROGRESS",
    "ASSESSMENT_VERIFICATION",
    "AMENDMENT_PENDING",
    "CLOSED_AND_LOCKED",
}


def _password_hash(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), 310_000
    ).hex()


def _new_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _start_otp(user_id: str) -> str:
    code = _new_otp()
    with session_scope() as session:
        user = session.get(UserAccount, user_id)
        if user is not None:
            user.otp_hash = hashlib.sha256(code.encode("ascii")).hexdigest()
            user.otp_expires_at = datetime.now() + timedelta(minutes=5)
    return code


def _verify_otp(user_id: str, code: str) -> bool:
    if not re.fullmatch(r"\d{6}", code):
        return False
    with session_scope() as session:
        user = session.get(UserAccount, user_id)
        if user is None or user.otp_hash is None or user.otp_expires_at is None:
            return False
        if user.otp_expires_at < datetime.now():
            return False
        expected = user.otp_hash
        actual = hashlib.sha256(code.encode("ascii")).hexdigest()
        if not hmac.compare_digest(expected, actual):
            return False
        user.is_verified = True
        user.otp_hash = None
        user.otp_expires_at = None
    return True


def _begin_password_reset(email: str) -> tuple[str, str, str] | None:
    with session_scope() as session:
        user = session.scalar(
            select(UserAccount).where(UserAccount.email == email.strip().lower())
        )
        user_details = (user.id, user.phone) if user is not None else None
    if user_details is None:
        return None
    user_id, phone = user_details
    code = _start_otp(user_id)
    return user_id, phone, code


def _finish_password_reset(user_id: str, code: str, new_password: str) -> bool:
    if len(new_password) < 10:
        raise ValueError("Use a password with at least 10 characters.")
    if not re.fullmatch(r"\d{6}", code):
        return False

    salt = secrets.token_bytes(16).hex()
    password_hash = _password_hash(new_password, salt)
    with session_scope() as session:
        user = session.get(UserAccount, user_id)
        if user is None or user.otp_hash is None or user.otp_expires_at is None:
            return False
        if user.otp_expires_at < datetime.now():
            return False
        actual = hashlib.sha256(code.encode("ascii")).hexdigest()
        if not hmac.compare_digest(user.otp_hash, actual):
            return False
        user.password_salt = salt
        user.password_hash = password_hash
        user.otp_hash = None
        user.otp_expires_at = None
    return True


def _register(email: str, phone: str, password: str) -> tuple[str, str]:
    email = email.strip().lower()
    phone = phone.strip().replace(" ", "")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("Enter a valid email address.")
    if not re.fullmatch(r"\+27\d{9}", phone):
        raise ValueError("Use a South African mobile number in +27XXXXXXXXX format.")
    if len(password) < 10:
        raise ValueError("Use a password with at least 10 characters.")
    user_id = str(uuid.uuid4())
    salt = secrets.token_bytes(16).hex()
    try:
        with session_scope() as session:
            session.add(
                UserAccount(
                    id=user_id,
                    email=email,
                    phone=phone,
                    password_salt=salt,
                    password_hash=_password_hash(password, salt),
                    created_at=datetime.now(),
                )
            )
    except IntegrityError as exc:
        raise ValueError("An account with that email already exists.") from exc
    return user_id, _start_otp(user_id)


def _authenticate(email: str, password: str) -> tuple[str, str]:
    with session_scope() as session:
        user = session.scalar(
            select(UserAccount).where(UserAccount.email == email.strip().lower())
        )
        details = (
            (user.id, user.password_salt, user.password_hash, user.phone)
            if user is not None
            else None
        )
    if details is None or not hmac.compare_digest(
        details[2], _password_hash(password, details[1])
    ):
        raise ValueError("Email or password is incorrect.")
    return details[0], details[3]


def _user_email(user_id: str) -> str | None:
    with session_scope() as session:
        return session.scalar(
            select(UserAccount.email).where(UserAccount.id == user_id)
        )


def _load_records(user_id: str) -> list[dict[str, Any]]:
    with session_scope() as session:
        records = session.scalars(
            select(TaxRecord)
            .where(TaxRecord.user_id == user_id)
            .order_by(TaxRecord.tax_year.desc())
        ).all()
        return [
            {
                "id": record.id,
                "tax_year": record.tax_year,
                "state": record.state,
                "is_locked": record.is_locked,
                "created_at": record.created_at.isoformat(),
                "updated_at": record.updated_at.isoformat(),
            }
            for record in records
        ]


def _record(user_id: str, tax_year: str) -> dict[str, Any] | None:
    with session_scope() as session:
        record = session.scalar(
            select(TaxRecord).where(
                TaxRecord.user_id == user_id, TaxRecord.tax_year == tax_year
            )
        )
        if record is None:
            return None
        return {
            "id": record.id,
            "user_id": record.user_id,
            "tax_year": record.tax_year,
            "state": record.state,
            "is_locked": record.is_locked,
            "created_at": record.created_at.isoformat(),
            "updated_at": record.updated_at.isoformat(),
            "data": record.data_json or {},
        }


def _save_record(
    user_id: str, tax_year: str, data: dict[str, Any], state: str | None = None
) -> None:
    if state is not None and state not in TAX_STATES:
        raise ValueError(f"Unknown tax-record state: {state}")
    payload = json.loads(json.dumps(data, ensure_ascii=False, default=str))
    with session_scope() as session:
        record = session.scalar(
            select(TaxRecord).where(
                TaxRecord.user_id == user_id, TaxRecord.tax_year == tax_year
            )
        )
        if record and record.is_locked:
            raise ValueError("This tax year is permanently locked and cannot be changed.")
        if record:
            if state == "DRAFT" and record.state not in {"DRAFT", "CALCULATED_PREVIEW"}:
                data.pop("checkout", None)
                data.pop("payment_status", None)
                payload.pop("checkout", None)
                payload.pop("payment_status", None)
            record.data_json = payload
            record.state = state or record.state
            record.updated_at = datetime.now()
        else:
            session.add(
                TaxRecord(
                    id=str(uuid.uuid4()),
                    user_id=user_id,
                    tax_year=tax_year,
                    state=state or "DRAFT",
                    data_json=payload,
                    created_at=datetime.now(),
                    updated_at=datetime.now(),
                )
            )


def _lock_record(user_id: str, tax_year: str) -> None:
    with session_scope() as session:
        record = session.scalar(
            select(TaxRecord).where(
                TaxRecord.user_id == user_id,
                TaxRecord.tax_year == tax_year,
                TaxRecord.is_locked.is_(False),
            )
        )
        if record is None:
            raise ValueError("No active, unlocked tax record exists for this year.")
        record.is_locked = True
        record.state = "CLOSED_AND_LOCKED"
        record.updated_at = datetime.now()


def _money(value: Any) -> Decimal:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return Decimal("0.00")
    text = str(value).strip().replace("\u00a0", " ")
    if not text or text.lower() in {"nan", "none", "null", "-"}:
        return Decimal("0.00")
    is_negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[^0-9,.\-]", "", text)
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        parts = cleaned.split(",")
        cleaned = "".join(parts[:-1]) + ("." + parts[-1] if len(parts[-1]) in (1, 2) else parts[-1])
    try:
        amount = Decimal(cleaned)
    except InvalidOperation:
        return Decimal("0.00")
    if is_negative:
        amount = -abs(amount)
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _source_code(description: str, supplied: Any = None) -> tuple[str, str, float]:
    if supplied is not None and re.fullmatch(r"\d{4}", str(supplied).strip()):
        code = str(supplied).strip()
        return code, f"Source code {code}", 0.99
    text = description.lower()
    mappings = [
        (r"\b(foreign interest|offshore interest)\b", "4102", "Foreign interest / other income", 0.83),
        (r"\b(salary|salaries|payroll|remuneration|paye|irP5)\b", "3601", "Employment income", 0.92),
        (r"\b(doctor|medical|pharmacy|hospital|clinic|dentist|optometrist)\b", "4020", "Medical expense", 0.91),
        (r"\b(electricity|water|rates|municipal|utility|internet|rent|home office)\b", "4028", "Home-office / utility expense", 0.86),
        (r"\b(interest|dividend|investment|savings)\b", "4201", "Interest and investment income", 0.86),
        (r"\b(business|client|sales|consulting|trade income)\b", "4006", "Other trade item", 0.82),
        (r"\b(donation|section 18a|charity)\b", "4006", "Donation / other trade item", 0.78),
    ]
    for pattern, code, label, confidence in mappings:
        if re.search(pattern, text, flags=re.IGNORECASE):
            return code, label, confidence
    return "9999", "Unclassified — confirm tax treatment", 0.35


def _scrub_pii(text: str) -> str:
    scrubbed = text
    scrubbed = re.sub(r"\b\d{13}\b", "[SA_ID_REDACTED]", scrubbed)
    scrubbed = re.sub(
        r"(?<!\w)(?:\+27|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\w)",
        "[PHONE_REDACTED]",
        scrubbed,
    )
    scrubbed = re.sub(
        r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[EMAIL_REDACTED]", scrubbed, flags=re.I
    )
    scrubbed = re.sub(
        r"\b(?:account|acct|bank)\s*(?:no\.?|number|#)?\s*[:\-]?\s*\d{7,18}\b",
        "[BANK_ACCOUNT_REDACTED]",
        scrubbed,
        flags=re.I,
    )
    scrubbed = re.sub(
        r"\b\d{1,5}\s+[A-Za-z][A-Za-z .'-]{2,40}\s+"
        r"(?:Road|Street|Avenue|Drive|Lane|Close|Crescent|Rd|St)\b",
        "[ADDRESS_REDACTED]",
        scrubbed,
        flags=re.I,
    )
    scrubbed = re.sub(r"\b\d{10,16}\b", "[BANK_ACCOUNT_REDACTED]", scrubbed)
    scrubbed = re.sub(
        r"(?im)^(\s*(?:account holder|customer name|taxpayer name|name)\s*:\s*).+$",
        r"\1[NAME_REDACTED]",
        scrubbed,
    )
    return scrubbed


def _extract_ocr_image(data: bytes) -> str:
    from PIL import Image
    import pytesseract

    with Image.open(io.BytesIO(data)) as image:
        return pytesseract.image_to_string(image)


def _read_document(filename: str, data: bytes) -> tuple[str, list[dict[str, Any]], str]:
    suffix = Path(filename).suffix.lower()
    text = ""
    tabular: list[dict[str, Any]] = []
    bank = "Unknown"
    if suffix == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
        if not text:
            import pymupdf
            import pytesseract
            from PIL import Image

            pdf = pymupdf.open(stream=data, filetype="pdf")
            page_text = []
            for page in pdf:
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
                image = Image.open(io.BytesIO(pixmap.tobytes("png")))
                page_text.append(pytesseract.image_to_string(image))
            text = "\n".join(page_text).strip()
    elif suffix in {".png", ".jpg", ".jpeg"}:
        text = _extract_ocr_image(data)
    elif suffix == ".csv":
        frame = pd.read_csv(io.BytesIO(data), dtype=str, keep_default_na=False)
        tabular = frame.to_dict(orient="records")
        text = frame.to_string(index=False)
        bank = _detect_bank(frame.columns, filename)
    elif suffix in {".xls", ".xlsx"}:
        frame = pd.read_excel(io.BytesIO(data), dtype=str).fillna("")
        tabular = frame.to_dict(orient="records")
        text = frame.to_string(index=False)
        bank = _detect_bank(frame.columns, filename)
    elif suffix == ".json":
        document = json.loads(data.decode("utf-8-sig"))
        if isinstance(document, list):
            tabular = [entry for entry in document if isinstance(entry, dict)]
        elif isinstance(document, dict):
            rows = document.get("transactions", document.get("statement", []))
            tabular = [entry for entry in rows if isinstance(entry, dict)] if isinstance(rows, list) else []
        text = json.dumps(document, ensure_ascii=False, indent=2)
    elif suffix == ".txt":
        text = data.decode("utf-8-sig", errors="replace")
    elif suffix == ".docx":
        from docx import Document

        document = Document(io.BytesIO(data))
        paragraphs = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
        tables = [
            [[cell.text for cell in row.cells] for row in table.rows]
            for table in document.tables
        ]
        text = "\n".join(paragraphs + [str(table) for table in tables])
    else:
        raise ValueError(f"Unsupported document format: {suffix or '(no extension)'}")
    return text, tabular, bank


def _detect_bank(columns: Any, filename: str = "") -> str:
    names = " ".join(str(column).lower() for column in columns)
    names += " " + filename.lower()
    for bank, hints in {
        "Capitec": ("capitec", "money in", "money out"),
        "FNB": ("fnb", "running balance", "cheque account"),
        "Standard Bank": ("standard bank", "debit amount", "credit amount"),
        "Absa": ("absa",),
        "Nedbank": ("nedbank", "branch code"),
    }.items():
        if any(hint in names for hint in hints):
            return bank
    return "Auto-mapped statement"


def _column_value(row: dict[str, Any], candidates: list[str]) -> Any:
    normalized = {re.sub(r"[^a-z0-9]", "", str(key).lower()): value for key, value in row.items()}
    for candidate in candidates:
        key = re.sub(r"[^a-z0-9]", "", candidate.lower())
        if key in normalized:
            return normalized[key]
    return None


def _transaction_rows(rows: list[dict[str, Any]], file_hash: str) -> list[dict[str, Any]]:
    staged: list[dict[str, Any]] = []
    daily_counts: dict[tuple[str, str, str], int] = {}
    for row in rows:
        description = str(
            _column_value(
                row,
                [
                    "description",
                    "details",
                    "narrative",
                    "merchant",
                    "merchant details",
                    "transaction details",
                    "payee",
                    "beneficiary",
                    "transaction",
                    "type",
                ],
            )
            or "Document transaction"
        ).strip()
        date_value = _column_value(
            row, ["date", "transaction date", "posting date", "value date", "process date"]
        )
        try:
            iso_date = datetime.strptime(str(date_value).strip()[:10], "%Y-%m-%d")
            date_text = iso_date.strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            try:
                transaction_date = pd.to_datetime(date_value, dayfirst=True, errors="coerce")
                date_text = transaction_date.strftime("%Y-%m-%d") if not pd.isna(transaction_date) else "undated"
            except (TypeError, ValueError):
                date_text = "undated"

        amount_value = _column_value(row, ["amount", "transaction amount", "value"])
        debit_value = _column_value(
            row,
            ["debit", "debits", "debit amount", "withdrawal", "withdrawals", "money out", "money paid"],
        )
        credit_value = _column_value(
            row,
            ["credit", "credits", "credit amount", "deposit", "deposits", "money in", "money received"],
        )
        amount = _money(amount_value) if amount_value not in (None, "") else Decimal("0.00")
        debit, credit = _money(debit_value), _money(credit_value)
        if debit_value not in (None, "") or credit_value not in (None, ""):
            amount = abs(credit) - abs(debit)
        supplied_code = _column_value(row, ["source code", "sars code", "code"])
        code, category, confidence = _source_code(description, supplied_code)
        if amount == 0:
            amount = _amount_near_text(str(row))
        amount_key = f"{amount:.2f}"
        normalized_description = re.sub(r"\W+", " ", description.lower()).strip()
        daily_key = (date_text, amount_key, normalized_description)
        daily_counts[daily_key] = daily_counts.get(daily_key, 0) + 1
        account = str(_column_value(row, ["account number", "account", "account no"]) or "")
        account_digits = re.sub(r"\D", "", account)
        account_last4 = account_digits[-4:] if account_digits else "unknown"
        fingerprint_input = "|".join(
            [account_last4, date_text, amount_key, normalized_description, str(daily_counts[daily_key])]
        )
        fingerprint = hashlib.sha256(fingerprint_input.encode("utf-8")).hexdigest()
        staged.append(
            {
                "date": date_text,
                "description": description,
                "amount": float(amount),
                "code": code,
                "category": category,
                "confidence": confidence,
                "fingerprint": fingerprint,
                "file_sha256": file_hash,
            }
        )
    return staged


def _amount_near_text(text: str) -> Decimal:
    match = re.search(r"(?:R\s*)?(-?\d[\d, ]*(?:\.\d{1,2})?)", text)
    return _money(match.group(0)) if match else Decimal("0.00")


def _code_rows_from_text(text: str, file_hash: str) -> list[dict[str, Any]]:
    rows = []
    for line in text.splitlines():
        match = re.search(r"\b(3601|4006|4028|4020|4201|4102)\b.*?(?:R\s*)?(-?[\d, ]+(?:\.\d{1,2})?)\s*$", line, re.I)
        if match:
            code, amount = match.groups()
            rows.append(
                {
                    "description": line.strip(),
                    "amount": _money(amount),
                    "code": code,
                }
            )
    return _transaction_rows(rows, file_hash)


def _receipt_rows_from_text(
    text: str, category: str, file_hash: str
) -> list[dict[str, Any]]:
    amount = _extract_label_amount(
        text, r"(?:grand\s+)?(?:invoice\s+)?total(?:\s+(?:due|payable|amount))?"
    )
    if amount is None or amount <= 0:
        return []
    code, label, confidence = _source_code(f"{category} {text[:500]}")
    if code == "9999":
        return []
    value = amount if code in {"3601", "4006", "4201", "4102"} else -amount
    row = {
        "date": "undated",
        "description": label + " — OCR total",
        "amount": str(value),
        "source code": code,
    }
    return _transaction_rows([row], file_hash)


def _tax_calculation(profile: dict[str, Any], transactions: list[dict[str, Any]]) -> dict[str, Any]:
    year = str(profile.get("tax_year", "2025"))
    if year not in {"2024", "2025"}:
        raise ValueError("Only 2024 and 2025 year-of-assessment tables are configured.")
    if profile.get("residency", "Resident") != "Resident":
        raise ValueError(
            "This estimate currently supports South African tax residents only. "
            "Non-resident income needs separate source-of-income and treaty treatment."
        )

    def amount(key: str) -> Decimal:
        return max(Decimal("0"), _money(profile.get(key, 0)))

    income_3601 = sum(
        (_money(tx.get("amount")) for tx in transactions if tx.get("code") == "3601" and _money(tx.get("amount")) > 0),
        Decimal("0"),
    )
    local_interest = sum(
        (_money(tx.get("amount")) for tx in transactions if tx.get("code") == "4201" and _money(tx.get("amount")) > 0),
        Decimal("0"),
    )
    foreign_interest = sum(
        (_money(tx.get("amount")) for tx in transactions if tx.get("code") == "4102" and _money(tx.get("amount")) > 0),
        Decimal("0"),
    )
    interest = local_interest + foreign_interest
    trade_income = sum(
        (_money(tx.get("amount")) for tx in transactions if tx.get("code") == "4006" and _money(tx.get("amount")) > 0),
        Decimal("0"),
    )
    remuneration_input = amount("remuneration")
    remuneration = remuneration_input if remuneration_input else income_3601
    home_costs = sum(
        (abs(_money(tx.get("amount"))) for tx in transactions if tx.get("code") == "4028" and _money(tx.get("amount")) < 0),
        Decimal("0"),
    )
    home_office_percent = min(Decimal("100"), amount("home_office_percent"))
    home_office = (home_costs * home_office_percent / Decimal("100")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    travel = (amount("business_km") * Decimal("4.84")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    ra_requested = amount("retirement_contributions")
    ra_cap = min(remuneration * Decimal("0.275"), Decimal("350000"))
    ra_deduction = min(ra_requested, ra_cap)
    age = int(amount("age"))
    interest_cap = Decimal("34500") if age >= 65 else Decimal("23800")
    interest_exemption = min(local_interest, interest_cap)
    pre_donation = max(
        Decimal("0"),
        remuneration + interest + trade_income
        - ra_deduction - interest_exemption - home_office - travel,
    )
    donation_requested = amount("donations_18a")
    donation_deduction = min(donation_requested, pre_donation * Decimal("0.10"))
    taxable_income = max(Decimal("0"), pre_donation - donation_deduction)
    taxable_income = taxable_income.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    taxable_for_brackets = taxable_income.to_integral_value(rounding=ROUND_DOWN)
    taxable_int = int(taxable_for_brackets)
    gross_tax = Decimal("0")
    for ceiling, rate, base_tax, lower in TAX_BRACKETS:
        if ceiling is None or taxable_int <= ceiling:
            gross_tax = base_tax + (taxable_for_brackets - Decimal(lower)) * rate
            break
    gross_tax = gross_tax.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    rebates = Decimal(REDEMPTIONS["primary"])
    if age >= 65:
        rebates += Decimal(REDEMPTIONS["secondary"])
    if age >= 75:
        rebates += Decimal(REDEMPTIONS["tertiary"])
    dependants = int(amount("medical_dependants"))
    has_medical_scheme = bool(profile.get("medical_scheme_member", False))
    members = 1 + dependants if has_medical_scheme else 0
    mtc_monthly = Decimal("364") if members >= 1 else Decimal("0")
    if members >= 2:
        mtc_monthly += Decimal("364")
    if members >= 3:
        mtc_monthly += Decimal(members - 2) * Decimal("246")
    mtc = mtc_monthly * Decimal("12")
    income_tax = max(Decimal("0"), gross_tax - rebates - mtc)
    paye = amount("paye_withheld")
    refund_payable = paye - income_tax

    deductions = {
        "Section 11F retirement contributions": ra_deduction,
        "Section 10(1)(i) interest exemption": interest_exemption,
        "Section 23(b) home office": home_office,
        "Business travel (R4.84/km)": travel,
        "Section 18A donations": donation_deduction,
    }
    return {
        "tax_year": year,
        "remuneration": remuneration,
        "interest_income": interest,
        "local_interest": local_interest,
        "foreign_interest": foreign_interest,
        "trade_income": trade_income,
        "gross_income": remuneration + interest + trade_income,
        "deductions": deductions,
        "total_deductions": sum(deductions.values(), Decimal("0")),
        "taxable_income": taxable_income,
        "gross_tax": gross_tax,
        "rebates": rebates,
        "medical_scheme_credits": mtc,
        "estimated_tax": income_tax,
        "paye_withheld": paye,
        "net_refund_or_payable": refund_payable,
        "medical_dependants": dependants,
        "home_office_costs": home_costs,
        "home_office_percent": home_office_percent,
        "business_km": amount("business_km"),
        "retirement_requested": ra_requested,
        "retirement_cap": ra_cap,
        "donations_requested": donation_requested,
        "donations_cap": pre_donation * Decimal("0.10"),
    }


def _fmt(value: Any) -> str:
    return f"R {float(value):,.2f}"


def _extract_label_amount(text: str, label_pattern: str) -> Decimal | None:
    pattern = re.compile(
        rf"{label_pattern}.{{0,100}}?(?:R\s*)?(-?\d[\d, ]*(?:\.\d{{1,2}})?)",
        flags=re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(text)
    return _money(match.group(1)) if match else None


def _audit_pdf(
    profile: dict[str, Any], calculation: dict[str, Any], transactions: list[dict[str, Any]]
) -> bytes:
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"eTaxOptimize SA {calculation['tax_year']} tax schedule",
    )
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="ReportTitle", parent=styles["Title"], alignment=TA_CENTER, textColor=colors.HexColor("#002F5F")))
    story = [
        Paragraph("eTaxOptimize SA — Tax Schedule", styles["ReportTitle"]),
        Paragraph(
            f"Tax year {calculation['tax_year']} · Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            styles["Normal"],
        ),
        Spacer(1, 10),
    ]
    rows = [["Schedule", "Amount"]] + [
        ["Gross income", _fmt(calculation["gross_income"])],
        ["Total deductions", _fmt(calculation["total_deductions"])],
        ["Taxable income", _fmt(calculation["taxable_income"])],
        ["Gross tax before credits", _fmt(calculation["gross_tax"])],
        ["Rebates", _fmt(calculation["rebates"])],
        ["Medical scheme credits", _fmt(calculation["medical_scheme_credits"])],
        ["Estimated tax", _fmt(calculation["estimated_tax"])],
        ["PAYE withheld", _fmt(calculation["paye_withheld"])],
        ["Estimated refund / (payable)", _fmt(calculation["net_refund_or_payable"])],
    ]
    table = Table(rows, colWidths=[105 * mm, 55 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#002F5F")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C8D0D9")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F4F6F9")]),
                ("ALIGN", (1, 1), (1, -1), "RIGHT"),
                ("PADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 12))
    story.append(Paragraph("Deduction detail", styles["Heading2"]))
    detail_rows = [["Deduction", "Amount"]] + [
        [name, _fmt(value)] for name, value in calculation["deductions"].items()
    ]
    detail_table = Table(detail_rows, colWidths=[105 * mm, 55 * mm], repeatRows=1)
    detail_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#007A87")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C8D0D9")),
                ("ALIGN", (1, 1), (1, -1), "RIGHT"),
                ("PADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(detail_table)
    story.append(Spacer(1, 12))
    story.append(Paragraph(f"Ledger rows included: {len(transactions)}", styles["Normal"]))
    story.append(
        Paragraph(
            "Planning estimate only; verify the current SARS rules and source documents before filing.",
            styles["Italic"],
        )
    )
    document.build(story)
    return buffer.getvalue()


def _signature(payload: bytes) -> str:
    key = PAYGATE_SECRET.encode("utf-8")
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def _canonical_payload(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _checksum_envelope(payload: dict[str, Any]) -> dict[str, Any]:
    digest = hashlib.sha256(_canonical_payload(payload)).hexdigest()
    return {"payload": payload, "sha256": digest}


def _copy_button(text: str, key: str) -> None:
    escaped = json.dumps(text)
    st.html(
        f"""<button id="copy-{key}" style="padding:8px 12px;border:0;border-radius:6px;
        background:#00A86B;color:#06130d;font-weight:700;cursor:pointer">Copy instruction</button>
        <script>
        const button=document.getElementById("copy-{key}");
        button.addEventListener("click",async()=>{{
          const value={escaped};
          try{{await navigator.clipboard.writeText(value);button.textContent="Copied";}}
          catch{{const input=document.createElement("textarea");input.value=value;document.body.appendChild(input);
            input.select();document.execCommand("copy");input.remove();button.textContent="Copied";}}
          setTimeout(()=>button.textContent="Copy instruction",1200);
        }});
        </script>""",
        unsafe_allow_javascript=True,
    )


def _advance_walkthrough(last_step: int) -> None:
    current_step = int(st.session_state.get("walkthrough_step", 0))
    if current_step >= last_step:
        st.session_state.walkthrough_step = 0
        st.session_state.stage_radio = STAGES[6]
    else:
        st.session_state.walkthrough_step = current_step + 1


def _stage_auth() -> None:
    st.title("0 · Authentication & multi-year vault")
    st.caption("Local demo 2FA: the OTP is shown here; no SMS provider is connected.")

    pending = st.session_state.get("pending_user_id")
    if pending:
        st.info(f"Development SMS code for {st.session_state.get('pending_phone', 'your phone')}: **{st.session_state.get('demo_otp', '')}**")
        with st.form("otp_form"):
            code = st.text_input("6-digit verification code", max_chars=6)
            verify = st.form_submit_button("Verify phone and open vault")
        if verify:
            if _verify_otp(pending, code):
                st.session_state.user_id = pending
                st.session_state.pop("pending_user_id", None)
                st.session_state.pop("demo_otp", None)
                st.success("Phone verified.")
                st.rerun()
            else:
                st.error("Code is invalid or expired. Codes expire after five minutes.")
        if st.button("Send a new simulated code"):
            new_code = _start_otp(pending)
            st.session_state.demo_otp = new_code
            st.rerun()
        return

    reset_user_id = st.session_state.get("password_reset_user_id")
    if reset_user_id:
        st.subheader("Reset your password")
        st.caption(
            f"Enter the six-digit code sent to {st.session_state.get('password_reset_phone', 'your verified phone')}. "
            "Codes expire after five minutes."
        )
        st.info(
            f"Development SMS code: **{st.session_state.get('password_reset_demo_code', '')}**"
        )
        with st.form("password_reset_form"):
            reset_code = st.text_input("6-digit verification code", max_chars=6)
            new_password = st.text_input("New password (10+ characters)", type="password")
            confirm_password = st.text_input("Confirm new password", type="password")
            reset_submitted = st.form_submit_button("Verify code and reset password")
        if reset_submitted:
            if new_password != confirm_password:
                st.error("Passwords do not match.")
            else:
                try:
                    if _finish_password_reset(reset_user_id, reset_code, new_password):
                        st.session_state.pop("password_reset_user_id", None)
                        st.session_state.pop("password_reset_phone", None)
                        st.session_state.pop("password_reset_demo_code", None)
                        st.success("Password reset. Sign in with your new password.")
                        st.rerun()
                    st.error("The code is invalid or expired. Request a new reset code.")
                except ValueError as exc:
                    st.error(str(exc))
        if st.button("Cancel password reset"):
            st.session_state.pop("password_reset_user_id", None)
            st.session_state.pop("password_reset_phone", None)
            st.session_state.pop("password_reset_demo_code", None)
            st.rerun()
        if st.button("Send a new simulated reset code"):
            reset = _begin_password_reset(st.session_state.get("password_reset_email", ""))
            if reset is not None:
                st.session_state.password_reset_user_id = reset[0]
                st.session_state.password_reset_phone = reset[1]
                st.session_state.password_reset_demo_code = reset[2]
                st.rerun()
            st.error("Could not issue a reset code. Restart password recovery from sign-in.")
        return

    login_tab, register_tab = st.tabs(["Sign in", "Create account"])
    with login_tab:
        with st.form("login_form"):
            email = st.text_input("Email")
            password = st.text_input("Password", type="password")
            submitted = st.form_submit_button("Continue with 2FA")
        if submitted:
            try:
                user_id, phone = _authenticate(email, password)
                otp = _start_otp(user_id)
                st.session_state.pending_user_id = user_id
                st.session_state.demo_otp = otp
                st.session_state.pending_phone = phone
                st.rerun()
            except ValueError as exc:
                st.error(str(exc))
        with st.expander("Forgot password?"):
            with st.form("forgot_password_form"):
                recovery_email = st.text_input("Account email address", key="recovery_email")
                request_reset = st.form_submit_button("Send password reset code")
            if request_reset:
                reset = _begin_password_reset(recovery_email)
                st.info(
                    "If an account exists for that email, a reset code has been issued to its verified phone."
                )
                if reset is not None:
                    st.session_state.password_reset_user_id = reset[0]
                    st.session_state.password_reset_phone = reset[1]
                    st.session_state.password_reset_email = recovery_email.strip().lower()
                    st.session_state.password_reset_demo_code = reset[2]
                    st.rerun()
    with register_tab:
        with st.form("register_form"):
            new_email = st.text_input("Email address", key="register_email")
            phone = st.text_input("South African mobile (+27XXXXXXXXX)")
            new_password = st.text_input("Password (10+ characters)", type="password", key="register_password")
            confirm = st.text_input("Confirm password", type="password")
            create = st.form_submit_button("Create account and send simulated OTP")
        if create:
            if new_password != confirm:
                st.error("Passwords do not match.")
            else:
                try:
                    user_id, otp = _register(new_email, phone, new_password)
                    st.session_state.pending_user_id = user_id
                    st.session_state.pending_phone = phone
                    st.session_state.demo_otp = otp
                    st.rerun()
                except ValueError as exc:
                    st.error(str(exc))


def _stage_vault(user_id: str) -> None:
    st.title("0 · Multi-year tax vault")
    st.caption(f"Signed in as {_user_email(user_id)}. No SARS eFiling credentials are requested or stored.")
    records = _load_records(user_id)
    with st.form("select_year_form"):
        year = st.selectbox("Assessment year", ["2025", "2024"])
        start = st.form_submit_button("Start or resume draft")
    if start:
        st.session_state.active_tax_year = year
        existing = _record(user_id, year)
        if existing and existing["is_locked"]:
            st.warning("That year is closed and locked. Open it read-only from the archive below.")
        else:
            st.session_state.read_only = False
            if not existing:
                _save_record(user_id, year, {"profile": {"tax_year": year}, "documents": [], "transactions": []}, "DRAFT")
            st.success(f"{year} tax year is ready.")
            st.rerun()

    st.subheader("Your returns")
    if not records:
        st.info("No tax-year records yet.")
    else:
        for item in records:
            status = "CLOSED & LOCKED — read-only" if item["is_locked"] else item["state"]
            left, right = st.columns([3, 1])
            left.write(f"**{item['tax_year']}** · {status} · updated {item['updated_at'][:10]}")
            if right.button("Open", key=f"open-{item['id']}"):
                st.session_state.active_tax_year = item["tax_year"]
                st.session_state.read_only = bool(item["is_locked"])
                st.rerun()
        export_records = []
        for item in records:
            full_record = _record(user_id, item["tax_year"])
            if full_record:
                export_records.append(
                    {
                        "tax_year": full_record["tax_year"],
                        "state": full_record["state"],
                        "is_locked": bool(full_record["is_locked"]),
                        "data": full_record["data"],
                    }
                )
        st.download_button(
            "Export full vault (JSON)",
            data=json.dumps(
                {
                    "account": _user_email(user_id),
                    "exported_at": datetime.now().isoformat(),
                    "tax_years": export_records,
                },
                ensure_ascii=False,
                indent=2,
                default=str,
            ),
            file_name="etaxoptimize-vault-export.json",
            mime="application/json",
        )


def _stage_profile(user_id: str, tax_year: str, data: dict[str, Any]) -> None:
    st.title("1 · Taxpayer classification & profile")
    profile = data.get("profile", {})
    with st.form("profile_form"):
        year = st.selectbox(
            "Tax year of assessment",
            ["2024", "2025"],
            index=0 if str(profile.get("tax_year", tax_year)) == "2024" else 1,
        )
        col1, col2 = st.columns(2)
        with col1:
            age = st.number_input("Age at end of tax year", min_value=18, max_value=120, value=int(profile.get("age", 35)))
            residency = st.selectbox("South African tax residency", ["Resident", "Non-resident"], index=0 if profile.get("residency", "Resident") == "Resident" else 1)
            marital = st.selectbox("Marital regime", ["Not applicable", "In community of property", "Out of community of property"], index=["Not applicable", "In community of property", "Out of community of property"].index(profile.get("marital_regime", "Not applicable")))
            taxpayer_type = st.selectbox("Taxpayer classification", ["Salaried Employee", "Provisional Taxpayer", "Sole Proprietor"], index=["Salaried Employee", "Provisional Taxpayer", "Sole Proprietor"].index(profile.get("taxpayer_type", "Salaried Employee")))
        with col2:
            remuneration = st.number_input("Annual remuneration (R)", min_value=0.0, value=float(profile.get("remuneration", 0)), step=1000.0)
            paye = st.number_input("PAYE withheld (R, from IRP5)", min_value=0.0, value=float(profile.get("paye_withheld", 0)), step=500.0)
            ra = st.number_input("Annual retirement-annuity contributions (R)", min_value=0.0, value=float(profile.get("retirement_contributions", 0)), step=500.0)
            medical_member = st.checkbox("Covered by a medical scheme", value=profile.get("medical_scheme_member", False))
            dependants = st.number_input("Medical-scheme dependants (excluding main member)", min_value=0, max_value=20, value=int(profile.get("medical_dependants", 0)))
            office_percent = st.number_input("Home-office floor area (%)", min_value=0.0, max_value=100.0, value=float(profile.get("home_office_percent", 0)), step=1.0)
            travel_km = st.number_input("Business travel logbook kilometres", min_value=0.0, value=float(profile.get("business_km", 0)), step=100.0)
            donations = st.number_input("Section 18A donations (R)", min_value=0.0, value=float(profile.get("donations_18a", 0)), step=100.0)
        st.markdown("**Scope and permissions**")
        col_a, col_b = st.columns(2)
        with col_a:
            scope_ra = st.checkbox("Retirement annuity contributions", value=profile.get("scope_ra", True))
            scope_home = st.checkbox("Section 23(b) home office", value=profile.get("scope_home", False))
            scope_travel = st.checkbox("Business travel logbook", value=profile.get("scope_travel", False))
        with col_b:
            scope_medical = st.checkbox("Medical aid / health information (special personal information)", value=profile.get("scope_medical", False))
            scope_interest = st.checkbox("Local / foreign interest and TFSA records", value=profile.get("scope_interest", False))
            scope_donations = st.checkbox("Section 18A donations", value=profile.get("scope_donations", False))
        financial_consent = st.checkbox("I consent to local processing of my financial documents for this tax calculation.", value=profile.get("financial_consent", False))
        special_consent = st.checkbox(
            "I explicitly consent to processing medical/health information if I upload it.",
            value=profile.get("special_consent", False),
            disabled=not scope_medical,
        )
        st.caption("Documents and calculations are stored in the configured database. This app does not call an LLM; no documents are used for AI training.")
        no_training_ack = st.checkbox(
            "I understand no external AI or AI-training service is used by this application.",
            value=profile.get("no_training_ack", False),
        )
        save = st.form_submit_button("Save profile and continue")
    if save:
        if not financial_consent:
            st.error("Financial-processing consent is required to continue.")
            return
        if scope_medical and not special_consent:
            st.error("Medical/health processing requires explicit special-information consent.")
            return
        updated = {
            "tax_year": year,
            "age": age,
            "residency": residency,
            "marital_regime": marital,
            "taxpayer_type": taxpayer_type,
            "remuneration": remuneration,
            "paye_withheld": paye,
            "retirement_contributions": ra if scope_ra else 0,
            "medical_dependants": dependants if scope_medical else 0,
            "medical_scheme_member": medical_member if scope_medical else False,
            "home_office_percent": office_percent if scope_home else 0,
            "business_km": travel_km if scope_travel else 0,
            "donations_18a": donations if scope_donations else 0,
            "scope_ra": scope_ra,
            "scope_home": scope_home,
            "scope_travel": scope_travel,
            "scope_medical": scope_medical,
            "scope_interest": scope_interest,
            "scope_donations": scope_donations,
            "financial_consent": financial_consent,
            "special_consent": special_consent,
            "no_training_ack": no_training_ack,
            "consent_at": datetime.now().isoformat(timespec="seconds"),
        }
        data["profile"] = updated
        _save_record(user_id, year, data, "DRAFT")
        st.session_state.active_tax_year = year
        st.success("Profile saved to the database.")


def _stage_documents(user_id: str, tax_year: str, data: dict[str, Any], read_only: bool) -> None:
    st.title("2 · Multi-format document ingestion & OCR")
    if read_only:
        st.info("This return is locked. Documents are available read-only.")
    st.caption("Files are SHA-256 fingerprinted for the audit trail. PII is redacted before extracted text is saved. Keep source records for the statutory retention period; this app does not replace your original evidence. No external OCR or AI service is called.")
    category = st.selectbox(
        "Document category",
        ["Bank Statement", "IRP5 / Payslip", "Prior ITR12", "Medical certificate / receipts", "RA certificate IT3f", "IT3b/c investment certificate", "Trade / home-office / travel invoice", "Other"],
    )
    uploads = st.file_uploader(
        "Select one or more files",
        type=SUPPORTED_UPLOADS,
        accept_multiple_files=True,
        disabled=read_only,
    )
    if uploads and st.button("Process selected documents", disabled=read_only):
        documents = data.setdefault("documents", [])
        transactions = data.setdefault("transactions", [])
        known_hashes = {item["sha256"] for item in documents}
        known_fingerprints = {item["fingerprint"] for item in transactions}
        added_docs = 0
        added_rows = 0
        errors: list[str] = []
        for upload in uploads:
            raw = upload.getvalue()
            file_hash = hashlib.sha256(raw).hexdigest()
            if file_hash in known_hashes:
                st.info(f"Skipped duplicate file: {upload.name}")
                continue
            try:
                extracted, rows, bank = _read_document(upload.name, raw)
                scrubbed = _scrub_pii(extracted)
                if rows:
                    parsed_rows = _transaction_rows(rows, file_hash)
                else:
                    parsed_rows = _code_rows_from_text(scrubbed, file_hash)
                    if not parsed_rows:
                        parsed_rows = _receipt_rows_from_text(scrubbed, category, file_hash)
                for transaction in parsed_rows:
                    if transaction["fingerprint"] not in known_fingerprints:
                        transaction["file_name"] = upload.name
                        transaction["bank_template"] = bank
                        transactions.append(transaction)
                        known_fingerprints.add(transaction["fingerprint"])
                        added_rows += 1
                documents.append(
                    {
                        "file_name": upload.name,
                        "category": category,
                        "sha256": file_hash,
                        "bank_template": bank,
                        "text": scrubbed[:100_000],
                        "ocr_used": Path(upload.name).suffix.lower() in {".png", ".jpg", ".jpeg"}
                        or (Path(upload.name).suffix.lower() == ".pdf" and not extracted),
                        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
                    }
                )
                known_hashes.add(file_hash)
                added_docs += 1
            except (ValueError, OSError, ImportError, RuntimeError, csv.Error) as exc:
                errors.append(f"{upload.name}: {exc}")
        if added_docs:
            data["documents"] = documents
            data["transactions"] = transactions
            _save_record(user_id, tax_year, data, "DRAFT")
            st.success(f"Processed {added_docs} document(s) and added {added_rows} transaction row(s).")
        for error in errors:
            st.error(error)

    st.subheader("March–February statement coverage")
    documents = data.get("documents", [])
    covered = set()
    for document in documents:
        for tx in data.get("transactions", []):
            if tx.get("file_sha256") == document.get("sha256") and tx.get("date", "undated") != "undated":
                try:
                    covered.add(int(tx["date"][5:7]))
                except (ValueError, TypeError):
                    pass
    months = ["Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb"]
    display_months = list(zip(months, list(range(3, 13)) + [1, 2]))
    st.columns(6)
    for index in range(0, 12, 6):
        cols = st.columns(6)
        for col, (label, month_num) in zip(cols, display_months[index : index + 6]):
            col.markdown(f"{'🟢' if month_num in covered else '⚪'} **{label}**")
    st.caption(f"{len(covered)} of 12 statement months detected from parsed transaction dates.")
    if documents:
        st.dataframe(
            pd.DataFrame(
                [
                    {
                        "File": item["file_name"],
                        "Category": item["category"],
                        "Bank template": item["bank_template"],
                        "SHA-256": item["sha256"][:16] + "…",
                        "OCR": "Yes" if item["ocr_used"] else "No",
                    }
                    for item in documents
                ]
            ),
            width="stretch",
            hide_index=True,
        )


def _stage_ledger(user_id: str, tax_year: str, data: dict[str, Any], read_only: bool) -> None:
    st.title("3 · SARS source-code ledger & clarification queue")
    transactions = data.get("transactions", [])
    if not transactions:
        st.info("Upload CSV/Excel statements or source-code documents in Stage 2.")
        return
    editable = [dict(tx) for tx in transactions]
    low_confidence = [tx for tx in editable if float(tx.get("confidence", 0)) < 0.8]
    if low_confidence:
        st.warning(f"{len(low_confidence)} transaction(s) have confidence below 80%; confirm their tax treatment.")
        for index, tx in enumerate(low_confidence):
            cols = st.columns([4, 2, 2])
            cols[0].write(f"{tx.get('date')} · {tx.get('description')} · {_fmt(tx.get('amount', 0))}")
            choices = SARS_CODES
            try:
                selected_index = choices.index(tx.get("code", "9999"))
            except ValueError:
                selected_index = choices.index("9999")
            chosen = cols[1].selectbox(
                "Verified code",
                choices,
                index=selected_index,
                key=f"clarify-{tax_year}-{tx['fingerprint']}",
                disabled=read_only,
            )
            if not read_only and cols[2].button("Confirm", key=f"confirm-{tx['fingerprint']}"):
                for original in transactions:
                    if original["fingerprint"] == tx["fingerprint"]:
                        original["code"] = chosen
                        original["category"] = "User confirmed"
                        original["confidence"] = 1.0
                _save_record(user_id, tax_year, data, "DRAFT")
                st.rerun()
    ledger = pd.DataFrame(
        [
            {
                "Date": tx.get("date"),
                "Description": tx.get("description"),
                "Amount (R)": tx.get("amount"),
                "SARS code": tx.get("code"),
                "Category": tx.get("category"),
                "Confidence": f"{float(tx.get('confidence', 0)):.0%}",
                "File": tx.get("file_name", ""),
            }
            for tx in transactions
        ]
    )
    st.dataframe(ledger, width="stretch", hide_index=True)
    st.caption("Duplicate transactions with matching SHA-256 fingerprints are skipped during ingestion.")
    if not read_only and st.button("Save ledger to vault"):
        _save_record(user_id, tax_year, data, "DRAFT")
        st.success("Ledger saved.")


def _stage_calculation(
    user_id: str,
    tax_year: str,
    data: dict[str, Any],
    transactions: list[dict[str, Any]],
    read_only: bool,
) -> dict[str, Any] | None:
    st.title("4 · Tax engine, analytics & checkout")
    if not data.get("profile", {}).get("financial_consent"):
        st.warning("Complete Stage 1 and record processing consent before calculating.")
        return None
    try:
        result = _tax_calculation(data["profile"], transactions)
    except ValueError as exc:
        st.error(str(exc))
        return None
    data["calculation"] = {key: str(value) if isinstance(value, Decimal) else value for key, value in result.items()}
    if not read_only:
        current_state = "PAID_UNLOCKED" if data.get("payment_status") == "SIMULATED_PAID" else "CALCULATED_PREVIEW"
        _save_record(user_id, tax_year, data, current_state)

    st.caption("Estimate based on the configured 2024/2025 rates and amounts. Confirm current SARS law and source documents before filing.")
    cols = st.columns(4)
    cols[0].metric("Gross income", _fmt(result["gross_income"]))
    cols[1].metric("Total deductions", _fmt(result["total_deductions"]))
    cols[2].metric("Rebates + medical credits", _fmt(result["rebates"] + result["medical_scheme_credits"]))
    label = "Estimated refund" if result["net_refund_or_payable"] >= 0 else "Estimated payable"
    cols[3].metric(label, _fmt(abs(result["net_refund_or_payable"])))

    code_totals: dict[str, Decimal] = {}
    for transaction in transactions:
        transaction_amount = _money(transaction.get("amount"))
        code = str(transaction.get("code", "9999"))
        if transaction_amount < 0:
            code_totals[code] = code_totals.get(code, Decimal("0")) + abs(transaction_amount)
    deduction_values = [
        {"SARS code": code, "Amount": float(value)}
        for code, value in sorted(code_totals.items())
        if value > 0
    ]
    donut_col, waterfall_col = st.columns(2)
    with donut_col:
        if deduction_values:
            st.plotly_chart(
                px.pie(pd.DataFrame(deduction_values), names="SARS code", values="Amount", hole=0.52, title="Statement deductions by SARS code"),
                width="stretch",
            )
        else:
            st.info("Upload statement debits to view deductions by SARS code.")
    with waterfall_col:
        fig = go.Figure(
            go.Waterfall(
                name="Assessment",
                orientation="v",
                measure=["absolute", "relative", "relative", "total"],
                x=["Gross tax", "Rebates", "Medical credits", "Estimated tax"],
                y=[
                    float(result["gross_tax"]),
                    -float(result["rebates"]),
                    -float(result["medical_scheme_credits"]),
                    float(result["estimated_tax"]),
                ],
                connector={"line": {"color": "#94a3b8"}},
            )
        )
        fig.update_layout(title="Assessment waterfall: gross tax to estimated tax", showlegend=False)
        st.plotly_chart(fig, width="stretch")

    with st.expander("Calculation detail and statutory caps"):
        detail = [
            ("Taxable income", result["taxable_income"]),
            ("Gross tax before rebates", result["gross_tax"]),
            ("Rebates", result["rebates"]),
            ("Medical scheme tax credits", result["medical_scheme_credits"]),
            ("PAYE withheld", result["paye_withheld"]),
            ("RA requested / allowed cap", f"{_fmt(result['retirement_requested'])} / {_fmt(result['retirement_cap'])}"),
            ("Section 18A requested / 10% cap", f"{_fmt(result['donations_requested'])} / {_fmt(result['donations_cap'])}"),
            ("Home office derived from code 4028", f"{_fmt(result['home_office_costs'])} × {result['home_office_percent']}%"),
            ("Business travel rate", "R4.84/km"),
        ]
        st.table(
            pd.DataFrame(
                [(label, str(value)) for label, value in detail],
                columns=["Item", "Amount / rule"],
            )
        )

    pdf_bytes = _audit_pdf(data["profile"], result, transactions)
    st.download_button(
        "Download A4 tax schedule (PDF)",
        data=pdf_bytes,
        file_name=f"etaxoptimize-{result['tax_year']}-schedule.pdf",
        mime="application/pdf",
    )

    if not read_only:
        st.subheader("Single-submission checkout simulation")
        st.caption("This demo creates an HMAC-SHA256 signature only; it does not charge a payment method or confirm a real PayGate transaction.")
        declaration = st.checkbox("I declare that I have reviewed these figures and they are complete to the best of my knowledge.")
        if declaration and st.button("Create simulated PayGate checkout"):
            checkout = {
                "tax_year": result["tax_year"],
                "amount_cents": 49900,
                "reference": str(uuid.uuid4()),
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }
            checkout["hmac_sha256"] = _signature(_canonical_payload(checkout))
            data["checkout"] = checkout
            _save_record(user_id, tax_year, data, "CALCULATED_PREVIEW")
            st.session_state.checkout_confirmation = False
            st.success("Simulated checkout created. No real payment was taken.")
            st.json(checkout)
        if data.get("checkout"):
            paid = st.checkbox("For local testing only: mark this demo checkout as confirmed.")
            if paid and st.button("Unlock guided filing (simulation)"):
                checkout = data["checkout"]
                signed = {key: value for key, value in checkout.items() if key != "hmac_sha256"}
                valid = hmac.compare_digest(
                    checkout["hmac_sha256"], _signature(_canonical_payload(signed))
                )
                if valid:
                    data["payment_status"] = "SIMULATED_PAID"
                    _save_record(user_id, tax_year, data, "PAID_UNLOCKED")
                    st.success("Demo record unlocked. This is not a real payment receipt.")
                else:
                    st.error("Checkout signature verification failed.")
    return result


def _stage_efiling(user_id: str, tax_year: str, data: dict[str, Any], read_only: bool) -> None:
    st.title("5 · Guided eFiling execution & extension companion")
    if not read_only and data.get("payment_status") != "SIMULATED_PAID":
        st.warning("Complete Stage 4 checkout simulation to unlock the companion.")
        return
    calculation = data.get("calculation")
    if not calculation:
        st.info("Calculate a preview in Stage 4 first.")
        return
    st.caption("SARS credentials are never requested. Sign in directly to SARS eFiling in your own browser session.")
    steps = [
        "Open the official SARS eFiling website and sign in yourself.",
        "Open the correct ITR12 or IRP6 for tax year " + tax_year + ".",
        "Confirm your taxpayer profile, residency and marital regime.",
        f"Enter employment income under source code 3601: {_fmt(calculation['remuneration'])}.",
        f"Review other income under source code 4006: {_fmt(calculation['trade_income'])}.",
        f"Review home-office amounts under source code 4028: {_fmt(calculation['deductions']['Section 23(b) home office'])}.",
        f"Review interest under source code 4102/4201: {_fmt(calculation['interest_income'])}.",
        "Save and calculate on SARS eFiling. Compare the calculation summary in Stage 6 before submitting.",
    ]
    st.subheader("Single-instruction walkthrough")
    if not read_only and st.button("Start eFiling walkthrough"):
        _save_record(user_id, tax_year, data, "EFILING_IN_PROGRESS")
        st.success("The guided filing stage has started.")
    if "walkthrough_step" not in st.session_state:
        st.session_state.walkthrough_step = 0
    step = st.session_state.walkthrough_step
    st.info(f"Step {step + 1} of {len(steps)}")
    st.markdown(f"### {steps[step]}")
    _copy_button(steps[step], f"walkthrough-{step}")
    back_col, done_col = st.columns(2)
    if back_col.button("← Back", disabled=step == 0):
        st.session_state.walkthrough_step = max(0, step - 1)
        st.rerun()
    done_col.button(
        "[✓] Done",
        on_click=_advance_walkthrough,
        args=(len(steps) - 1,),
    )

    payload = {
        "tax_year": tax_year,
        "fields": {
            "#txtCode3601": str(calculation["remuneration"]),
            "#txtCode4006": str(calculation["trade_income"]),
            "#txtCode4028": str(calculation["deductions"]["Section 23(b) home office"]),
            "#txtCode4102": str(calculation["foreign_interest"]),
        },
    }
    envelope = _checksum_envelope(payload)
    st.subheader("Extension companion payload")
    st.caption("Review and paste into the extension popup on an official SARS eFiling tab. Values are user-triggered; check each field before saving.")
    st.download_button(
        "Download SHA-256 signed JSON payload",
        data=json.dumps(envelope, indent=2),
        file_name=f"etax-{tax_year}-efiling-payload.json",
        mime="application/json",
    )
    st.json(envelope)


def _stage_assessment(
    user_id: str, tax_year: str, data: dict[str, Any], read_only: bool
) -> None:
    st.title("6 · ITA34 assessment audit & vault lock")
    calculation = data.get("calculation")
    if not calculation:
        st.info("Complete a tax preview in Stage 4 before reconciling an assessment.")
        return
    if data.get("payment_status") != "SIMULATED_PAID" and not read_only:
        st.warning("Stage 6 is available after the checkout simulation in Stage 4.")
        return
    uploaded = st.file_uploader(
        "Upload ITA34 Notice of Assessment (PDF, image or text)",
        type=["pdf", "png", "jpg", "jpeg", "txt"],
        key=f"ita34-{tax_year}",
        disabled=read_only,
    )
    if uploaded and st.button("Extract and reconcile ITA34", disabled=read_only):
        try:
            raw = uploaded.getvalue()
            text, _, _ = _read_document(uploaded.name, raw)
            clean_text = _scrub_pii(text)
            parsed = {
                "assessed_income": _extract_label_amount(clean_text, r"(?:taxable|assessed)\s+income"),
                "paye_allowed": _extract_label_amount(clean_text, r"(?:PAYE|employees'?\s+tax)\s+(?:allowed|credit|deducted)"),
                "medical_credits": _extract_label_amount(clean_text, r"medical\s+(?:scheme\s+)?(?:tax\s+)?credits?"),
                "deductions": _extract_label_amount(clean_text, r"deductions?"),
            }
            data["ita34"] = {
                "file_sha256": hashlib.sha256(raw).hexdigest(),
                "parsed": {key: str(value) if value is not None else None for key, value in parsed.items()},
            }
            _save_record(user_id, tax_year, data, "ASSESSMENT_VERIFICATION")
            st.session_state.ita34_text = clean_text
        except (ValueError, OSError, ImportError, RuntimeError) as exc:
            st.error(f"Could not parse the ITA34: {exc}")

    parsed_stored = data.get("ita34", {}).get("parsed")
    if parsed_stored:
        expected = {
            "assessed_income": _money(calculation["taxable_income"]),
            "paye_allowed": _money(calculation["paye_withheld"]),
            "medical_credits": _money(calculation["medical_scheme_credits"]),
            "deductions": _money(calculation["total_deductions"]),
        }
        rows = []
        for key, label in [
            ("assessed_income", "Taxable / assessed income"),
            ("paye_allowed", "PAYE allowed"),
            ("medical_credits", "Medical credits"),
            ("deductions", "Total deductions"),
        ]:
            actual = _money(parsed_stored[key]) if parsed_stored.get(key) else None
            estimate = expected[key]
            variance = actual - estimate if actual is not None else None
            rows.append(
                {
                    "Line": label,
                    "Estimate": float(estimate),
                    "ITA34": float(actual) if actual is not None else None,
                    "Variance (ITA34 - estimate)": float(variance) if variance is not None else None,
                    "Status": "Not extracted" if actual is None else ("Match" if abs(variance) < Decimal("1.00") else "Review / variance"),
                }
            )
        st.subheader("Reconciliation matrix")
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
        missing = [row["Line"] for row in rows if row["Status"] == "Not extracted"]
        if missing:
            st.warning("Check the ITA34 manually; these labels were not reliably extracted: " + ", ".join(missing))

    st.subheader("Dispute / Notice of Objection preparation")
    st.caption("Creates a draft schedule only; it is not legal advice or a filed objection.")
    if not read_only:
        if st.button("Create signed dispute fee-gate draft"):
            dispute = {
                "tax_year": tax_year,
                "kind": "DRAFT_NOTICE_OF_OBJECTION",
                "reference": str(uuid.uuid4()),
                "fee_cents": 19900,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "variances": (data.get("ita34") or {}).get("parsed", {}),
            }
            dispute["hmac_sha256"] = _signature(_canonical_payload(dispute))
            data["dispute_draft"] = dispute
            _save_record(user_id, tax_year, data, "AMENDMENT_PENDING")
            st.success("Draft fee-gate schedule created; no fee has been charged.")
            st.json(dispute)

    if not read_only:
        st.subheader("Permanent year closure")
        st.warning("Closing permanently locks this tax-year record. Export the schedule and audit documents first.")
        confirmation = st.checkbox(f"I understand that {tax_year} will become read-only.")
        if confirmation and st.button("Permanently lock this tax year"):
            _lock_record(user_id, tax_year)
            st.session_state.read_only = True
            st.success("Tax year locked in the database.")
            st.rerun()
    else:
        st.success("This tax year is permanently locked and read-only.")


def main() -> None:
    st.set_page_config(
        page_title="eTaxOptimize SA — SARS Tax Engine",
        page_icon="🏛️",
        layout="wide",
        initial_sidebar_state="expanded",
    )
    st.title("🏛️ eTaxOptimize SA")
    st.caption("SARS tax engine & optimizer · Local document processing · 2024/2025 estimates")
    if "user_id" not in st.session_state:
        st.session_state.user_id = None
    try:
        init_db()
    except SQLAlchemyError as exc:
        st.error(f"Database is unavailable: {exc}")
        st.info("Check that DATABASE_URL is set and that the database server is reachable.")
        st.stop()

    if not st.session_state.user_id:
        _stage_auth()
        return

    user_id = st.session_state.user_id
    email = _user_email(user_id)
    if email is None:
        st.session_state.user_id = None
        st.session_state.pop("active_tax_year", None)
        st.session_state.pop("read_only", None)
        st.session_state.pop("stage_radio", None)
        st.warning(
            "This sign-in session does not match an account in the current vault. "
            "Sign in again or create an account to continue."
        )
        _stage_auth()
        return

    with st.sidebar:
        st.markdown("### eTaxOptimize SA")
        st.write(email)
        if st.button("Sign out"):
            st.session_state.user_id = None
            st.session_state.active_tax_year = None
            st.rerun()
        stage_name = st.radio("Workflow", STAGES, index=0, key="stage_radio")

    stage_index = STAGES.index(stage_name)
    if stage_index == 0:
        _stage_vault(user_id)
        return

    tax_year = st.session_state.get("active_tax_year")
    if not tax_year:
        st.warning("Start or open a tax-year draft in the Vault Hub before using the workflow.")
        if st.button("Go to vault"):
            st.session_state.stage_radio = STAGES[0]
            st.rerun()
        return
    record = _record(user_id, tax_year)
    if record is None:
        st.warning("No draft exists for that year. Start it in the Vault Hub.")
        return
    data = record["data"]
    read_only = bool(record["is_locked"]) or bool(st.session_state.get("read_only", False))
    if read_only:
        st.info(f"{tax_year} is open in read-only archive mode.")

    if stage_index == 1:
        _stage_profile(user_id, tax_year, data)
    elif stage_index == 2:
        _stage_documents(user_id, tax_year, data, read_only)
    elif stage_index == 3:
        _stage_ledger(user_id, tax_year, data, read_only)
    elif stage_index == 4:
        _stage_calculation(user_id, tax_year, data, data.get("transactions", []), read_only)
    elif stage_index == 5:
        _stage_efiling(user_id, tax_year, data, read_only)
    elif stage_index == 6:
        _stage_assessment(user_id, tax_year, data, read_only)

    st.divider()
    st.caption("Tax-year tables and user-provided statutory values are estimates. Verify current SARS law and consult a registered tax practitioner where needed.")


if __name__ == "__main__":
    main()
