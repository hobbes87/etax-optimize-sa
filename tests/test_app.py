import app
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
import database
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import make_url
from unittest.mock import patch


def _use_temp_database(root: Path) -> tuple[Path, tuple[str, str | None]]:
    original = app.DATABASE_URL, os.environ.get("DATABASE_URL")
    database_path = root / "test.sqlite3"
    database_url = f"sqlite:///{database_path.as_posix()}"
    os.environ["DATABASE_URL"] = database_url
    app.DATABASE_URL = database_url
    app.configure_database(database_url)
    app.init_db()
    return database_path, original


def _restore_database(original: tuple[str, str | None]) -> None:
    app.DATABASE_URL, original_environment_url = original
    if original_environment_url is None:
        os.environ.pop("DATABASE_URL", None)
    else:
        os.environ["DATABASE_URL"] = original_environment_url
    app.configure_database(app.DATABASE_URL)


class AppLogicTests(unittest.TestCase):
    def test_db_path_secret_maps_to_project_relative_sqlite_url(self):
        expected = str(database.ROOT / "etax_vault.db")
        self.assertEqual(
            make_url(database.sqlite_url_for_path("etax_vault.db")).database,
            expected,
        )

    def test_postgresql_engine_and_jsonb_configuration(self):
        original = app.DATABASE_URL, os.environ.get("DATABASE_URL")
        try:
            database.configure_database(
                "postgresql://user:password@localhost/etax_test?schema=public"
            )
            self.assertEqual(database.engine.url.drivername, "postgresql+psycopg2")
            self.assertNotIn("schema", database.engine.url.query)
            json_type = app.TaxRecord.__table__.c.data_json.type.dialect_impl(
                postgresql.dialect()
            )
            self.assertIsInstance(json_type, JSONB)
        finally:
            _restore_database(original)

    def test_init_db_creates_orm_schema(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            database_path, original = _use_temp_database(root)
            try:
                app.init_db()
                self.assertTrue(database_path.exists())
                with app.session_scope() as session:
                    inspector = inspect(session.get_bind())
                    user_columns = {column["name"] for column in inspector.get_columns("users")}
                    record_columns = {
                        column["name"] for column in inspector.get_columns("tax_records")
                    }
                self.assertTrue({"id", "email", "phone", "password_hash"} <= user_columns)
                self.assertTrue(
                    {"user_id", "tax_year", "data_json", "is_locked"} <= record_columns
                )
            finally:
                _restore_database(original)

    def test_secret_helper_uses_environment_then_default(self):
        key = "ETAX_TEST_SECRET_HELPER"
        with patch.dict(os.environ, {key: "from-environment"}):
            self.assertEqual(app.get_secret(key, "fallback"), "from-environment")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(key, None)
            self.assertEqual(app.get_secret(key, "fallback"), "fallback")

    def test_secret_helper_prefers_streamlit_secret_to_environment(self):
        key = "ETAX_TEST_SECRET_PRIORITY"
        with patch.object(app.st, "secrets", {key: "from-streamlit"}):
            with patch.dict(os.environ, {key: "from-environment"}):
                self.assertEqual(app.get_secret(key, "fallback"), "from-streamlit")

    def test_currency_cleanup_supports_south_african_amounts(self):
        self.assertEqual(app._money("R 3 750.00"), app.Decimal("3750.00"))
        self.assertEqual(app._money("R 3,750.00"), app.Decimal("3750.00"))
        self.assertEqual(app._money("(R 125.50)"), app.Decimal("-125.50"))

    def test_pii_scrubber_masks_common_identifiers(self):
        text = "ID 8001015009087 phone +27 82 123 4567 account no 123456789012"
        scrubbed = app._scrub_pii(text)
        self.assertNotIn("8001015009087", scrubbed)
        self.assertNotIn("+27 82 123 4567", scrubbed)
        self.assertNotIn("123456789012", scrubbed)

    def test_2025_tax_uses_brackets_primary_rebate_and_paye(self):
        result = app._tax_calculation(
            {"tax_year": "2025", "age": 35, "remuneration": 300000, "paye_withheld": 50000},
            [],
        )
        self.assertEqual(result["gross_tax"], app.Decimal("59032.00"))
        self.assertEqual(result["estimated_tax"], app.Decimal("41797.00"))
        self.assertEqual(result["net_refund_or_payable"], app.Decimal("8203.00"))

    def test_2024_ra_deduction_medical_credits_and_donation_cap(self):
        result = app._tax_calculation(
            {
                "tax_year": "2024",
                "age": 66,
                "remuneration": 1000000,
                "retirement_contributions": 400000,
                "medical_scheme_member": True,
                "medical_dependants": 2,
                "donations_18a": 200000,
            },
            [],
        )
        self.assertEqual(result["deductions"]["Section 11F retirement contributions"], app.Decimal("275000.00"))
        self.assertEqual(result["deductions"]["Section 18A donations"], app.Decimal("72500.0000"))
        self.assertEqual(result["medical_scheme_credits"], app.Decimal("11688"))
        self.assertEqual(result["rebates"], app.Decimal("26679"))

    def test_bank_rows_map_split_debit_credit_and_fingerprint(self):
        rows = [
            {
                "Transaction Date": "2025-03-10",
                "Description": "Electricity municipal",
                "Debit Amount": "R 3 750.00",
                "Credit Amount": "0.00",
            }
        ]
        parsed = app._transaction_rows(rows, "a" * 64)
        self.assertEqual(parsed[0]["amount"], -3750.0)
        self.assertEqual(parsed[0]["code"], "4028")
        expected = hashlib.sha256(
            "|".join(
                [
                    "unknown",
                    "2025-03-10",
                    "-3750.00",
                    "electricity municipal",
                    "1",
                ]
            ).encode()
        ).hexdigest()
        self.assertEqual(parsed[0]["fingerprint"], expected)

    def test_orm_database_round_trips_records_and_json(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            database_path, original = _use_temp_database(root)
            try:
                user_id, _ = app._register(
                    "person@example.com", "+27821234567", "a sufficiently long password"
                )
                app._save_record(
                    user_id,
                    "2025",
                    {"profile": {"remuneration": 100000}, "documents": [], "transactions": []},
                )
                self.assertTrue(database_path.exists())
                loaded = app._record(user_id, "2025")
                self.assertEqual(loaded["data"]["profile"]["remuneration"], 100000)
            finally:
                _restore_database(original)

    def test_database_updates_do_not_modify_unrelated_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, original = _use_temp_database(root)
            legacy_temp = root / "test.sqlite3.tmp"
            legacy_temp.write_bytes(b"existing file must not be overwritten")
            try:
                user_id, _ = app._register(
                    "temp-path@example.com",
                    "+27821234567",
                    "a sufficiently long password",
                )
                self.assertEqual(
                    legacy_temp.read_bytes(), b"existing file must not be overwritten"
                )
                self.assertTrue(app._user_email(user_id) == "temp-path@example.com")
            finally:
                _restore_database(original)

    def test_otp_is_valid_for_one_use(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, original = _use_temp_database(root)
            try:
                user_id, code = app._register(
                    "otp@example.com", "+27821234567", "a sufficiently long password"
                )
                self.assertFalse(app._verify_otp(user_id, "000000"))
                self.assertTrue(app._verify_otp(user_id, code))
                self.assertFalse(app._verify_otp(user_id, code))
            finally:
                _restore_database(original)

    def test_password_reset_requires_otp_and_replaces_password(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, original = _use_temp_database(root)
            try:
                user_id, _ = app._register(
                    "reset@example.com",
                    "+27821234567",
                    "original secure password",
                )
                reset = app._begin_password_reset("RESET@example.com")
                self.assertIsNotNone(reset)
                reset_user_id, phone, code = reset
                self.assertEqual(reset_user_id, user_id)
                self.assertEqual(phone, "+27821234567")
                self.assertFalse(
                    app._finish_password_reset(user_id, "000000", "replacement password")
                )
                with self.assertRaisesRegex(ValueError, "at least 10 characters"):
                    app._finish_password_reset(user_id, code, "short")
                self.assertTrue(
                    app._finish_password_reset(
                        user_id, code, "replacement secure password"
                    )
                )
                self.assertFalse(
                    app._finish_password_reset(
                        user_id, code, "another replacement password"
                    )
                )
                with self.assertRaisesRegex(ValueError, "incorrect"):
                    app._authenticate("reset@example.com", "original secure password")
                self.assertEqual(
                    app._authenticate("reset@example.com", "replacement secure password")[0],
                    user_id,
                )
                self.assertIsNone(app._begin_password_reset("missing@example.com"))
            finally:
                _restore_database(original)

    def test_locked_return_is_read_only(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, original = _use_temp_database(root)
            try:
                user_id, _ = app._register(
                    "locked@example.com", "+27821234567", "a sufficiently long password"
                )
                app._save_record(user_id, "2025", {"profile": {}})
                app._lock_record(user_id, "2025")
                locked = app._record(user_id, "2025")
                self.assertTrue(locked["is_locked"])
                self.assertEqual(locked["state"], "CLOSED_AND_LOCKED")
                with self.assertRaisesRegex(ValueError, "permanently locked"):
                    app._save_record(user_id, "2025", {"profile": {"age": 40}}, "DRAFT")
            finally:
                _restore_database(original)

    def test_stale_streamlit_session_recovers_to_auth_screen(self):
        from streamlit.testing.v1 import AppTest

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, original = _use_temp_database(root)
            try:
                at = AppTest.from_file(str(Path(app.__file__)), default_timeout=30)
                at.session_state["user_id"] = "deleted-or-old-account-id"
                at.session_state["active_tax_year"] = "2025"
                at.session_state["read_only"] = True
                at.session_state["stage_radio"] = app.STAGES[4]
                at.run()
                self.assertFalse(at.exception, [str(error.value) for error in at.exception])
                self.assertIsNone(at.session_state["user_id"])
                self.assertNotIn("active_tax_year", at.session_state)
                self.assertTrue(
                    any("does not match an account" in warning.value for warning in at.warning)
                )
                self.assertEqual({tab.label for tab in at.tabs}, {"Sign in", "Create account"})
            finally:
                _restore_database(original)

    def test_final_efiling_done_advances_to_stage_six(self):
        from streamlit.testing.v1 import AppTest

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            _, original = _use_temp_database(root)
            try:
                user_id, _ = app._register(
                    "walkthrough@example.com",
                    "+27821234567",
                    "a sufficiently long password",
                )
                record_data = {
                    "profile": {"tax_year": "2025", "age": 35, "remuneration": 300000},
                    "transactions": [],
                    "documents": [],
                    "payment_status": "SIMULATED_PAID",
                    "calculation": app._tax_calculation(
                        {"tax_year": "2025", "age": 35, "remuneration": 300000}, []
                    ),
                }
                app._save_record(user_id, "2025", record_data, "EFILING_IN_PROGRESS")
                at = AppTest.from_file(str(Path(app.__file__)), default_timeout=45)
                at.session_state["user_id"] = user_id
                at.session_state["active_tax_year"] = "2025"
                at.session_state["stage_radio"] = app.STAGES[5]
                at.session_state["walkthrough_step"] = 7
                at.run()
                self.assertIn("Step 8 of 8", [item.value for item in at.info])
                done_button = next(button for button in at.button if button.label == "[✓] Done")
                done_button.click().run()
                self.assertEqual(at.session_state["stage_radio"], app.STAGES[6])
                self.assertTrue(any("ITA34 assessment audit" in item.value for item in at.title))
            finally:
                _restore_database(original)

    def test_ocr_receipt_total_maps_medical_invoice(self):
        rows = app._receipt_rows_from_text(
            "Medical clinic\nTotal due: R 1 250.00",
            "Medical certificate / receipts",
            "b" * 64,
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["code"], "4020")
        self.assertEqual(rows[0]["amount"], -1250.0)

    def test_capitec_csv_auto_maps_split_amount_columns(self):
        csv_bytes = (
            "Transaction Date,Description,Money Out,Money In\n"
            "2025-03-10,Electricity,R 3 750.00,0.00\n"
        ).encode()
        _, rows, bank = app._read_document("capitec-statement.csv", csv_bytes)
        parsed = app._transaction_rows(rows, "c" * 64)
        self.assertEqual(bank, "Capitec")
        self.assertEqual(parsed[0]["amount"], -3750.0)
        self.assertEqual(parsed[0]["code"], "4028")

    def test_tax_schedule_exports_as_a4_pdf(self):
        result = app._tax_calculation(
            {"tax_year": "2025", "age": 35, "remuneration": 100000}, []
        )
        contents = app._audit_pdf({}, result, [])
        self.assertTrue(contents.startswith(b"%PDF-"))
        self.assertGreater(len(contents), 1000)

    def test_foreign_interest_maps_to_foreign_source_code(self):
        code, _, _ = app._source_code("foreign interest income")
        self.assertEqual(code, "4102")

    def test_interest_exemption_only_applies_to_local_interest(self):
        result = app._tax_calculation(
            {"tax_year": "2025", "age": 40, "remuneration": 300000},
            [
                {"code": "4201", "amount": 30000},
                {"code": "4102", "amount": 5000},
            ],
        )
        self.assertEqual(result["interest_income"], app.Decimal("35000"))
        self.assertEqual(result["deductions"]["Section 10(1)(i) interest exemption"], app.Decimal("23800"))

    def test_nonresident_estimate_is_blocked_instead_of_using_resident_rules(self):
        with self.assertRaisesRegex(ValueError, "supports South African tax residents only"):
            app._tax_calculation({"tax_year": "2025", "residency": "Non-resident"}, [])

    def test_payload_checksum_is_stable_and_verifiable(self):
        payload = {"tax_year": "2025", "fields": {"#txtCode3601": "300000.00"}}
        envelope = app._checksum_envelope(payload)
        expected = hashlib.sha256(app._canonical_payload(payload)).hexdigest()
        self.assertEqual(envelope, {"payload": payload, "sha256": expected})
        self.assertEqual(json.loads(app._canonical_payload(payload))["tax_year"], "2025")

if __name__ == "__main__":
    unittest.main()
