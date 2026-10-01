from __future__ import annotations

import base64
import json

import pytest

from smg.crypto import (
    DataEncryptionConfigurationError,
    decrypt_preregistration_data,
    encrypt_preregistration_data,
    encryption_configured,
    is_encrypted,
    preregistration_needs_migration,
)
from smg.preregistration import rejected_retention_days
from smg.routers.employees import detected_mime


def key_value() -> str:
    return base64.urlsafe_b64encode(b"K" * 32).decode("ascii").rstrip("=")


def test_sensitive_preregistration_fields_round_trip_with_aes_gcm(monkeypatch):
    monkeypatch.setenv("DATA_ENCRYPTION_KEY", key_value())
    source = {
        "childName": "Criança",
        "guardianCpf": "12345678901",
        "allergyDetails": "alergia sensível",
        "medicationDetails": "medicação sensível",
        "healthConditionDetails": "condição sensível",
        "diagnosisDetails": "diagnóstico sensível",
        "authorizedPeople": [
            {"name": "Responsável 2", "document": "RG12345", "phone": "44999999999"}
        ],
    }
    protected = encrypt_preregistration_data(source)
    assert is_encrypted(protected["guardianCpf"])
    assert is_encrypted(protected["allergyDetails"])
    assert is_encrypted(protected["authorizedPeople"][0]["document"])
    serialized = json.dumps(protected, ensure_ascii=False)
    assert "12345678901" not in serialized
    assert "alergia sensível" not in serialized
    assert "RG12345" not in serialized
    assert decrypt_preregistration_data(protected) == source
    assert not preregistration_needs_migration(protected)


def test_legacy_sensitive_record_is_detected_for_migration(monkeypatch):
    monkeypatch.setenv("DATA_ENCRYPTION_KEY", key_value())
    assert preregistration_needs_migration({"guardianCpf": "123"})
    assert preregistration_needs_migration({"authorizedPeople": [{"document": "RG"}]})


def test_data_encryption_key_is_mandatory(monkeypatch):
    monkeypatch.delenv("DATA_ENCRYPTION_KEY", raising=False)
    assert not encryption_configured()
    with pytest.raises(DataEncryptionConfigurationError):
        encrypt_preregistration_data({"guardianCpf": "123"})


def test_rejected_retention_days_is_configurable_and_bounded(monkeypatch):
    monkeypatch.setenv("PREREG_REJECTED_RETENTION_DAYS", "45")
    assert rejected_retention_days() == 45
    monkeypatch.setenv("PREREG_REJECTED_RETENTION_DAYS", "99999")
    assert rejected_retention_days() == 3650


def test_employee_upload_magic_bytes_are_detected():
    assert detected_mime(b"%PDF-1.7\n") == "application/pdf"
    assert detected_mime(b"\xff\xd8\xff\xe0jpeg") == "image/jpeg"
    assert detected_mime(b"\x89PNG\r\n\x1a\nrest") == "image/png"
    assert detected_mime(b"RIFF\x00\x00\x00\x00WEBPrest") == "image/webp"
    assert detected_mime(b"<script>alert(1)</script>") == ""
