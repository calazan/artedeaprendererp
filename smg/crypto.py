from __future__ import annotations

import base64
import json
import os
import secrets
from copy import deepcopy
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class DataEncryptionConfigurationError(RuntimeError):
    pass


SENSITIVE_PREREG_FIELDS = (
    "guardianCpf",
    "allergyDetails",
    "foodRestrictionDetails",
    "medicationDetails",
    "healthConditionDetails",
    "diagnosisStatus",
    "diagnosisDetails",
    "healthPlan",
    "preferredHospital",
    "unauthorizedPersonDetails",
)


def _decode_key() -> bytes:
    raw = str(os.getenv("DATA_ENCRYPTION_KEY", "")).strip()
    if not raw:
        raise DataEncryptionConfigurationError("DATA_ENCRYPTION_KEY não configurada.")
    try:
        padded = raw + "=" * (-len(raw) % 4)
        key = base64.urlsafe_b64decode(padded.encode("ascii"))
    except Exception as exc:
        raise DataEncryptionConfigurationError(
            "DATA_ENCRYPTION_KEY deve ser uma chave base64-url de 32 bytes."
        ) from exc
    if len(key) != 32:
        raise DataEncryptionConfigurationError(
            "DATA_ENCRYPTION_KEY deve decodificar exatamente 32 bytes."
        )
    return key


def encryption_configured() -> bool:
    try:
        _decode_key()
        return True
    except DataEncryptionConfigurationError:
        return False


def is_encrypted(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("__enc__") == "aesgcm-v1"
        and isinstance(value.get("nonce"), str)
        and isinstance(value.get("ciphertext"), str)
    )


def encrypt_value(value: Any) -> Any:
    if value in (None, "", [], {}):
        return value
    if is_encrypted(value):
        return value
    key = _decode_key()
    nonce = secrets.token_bytes(12)
    plaintext = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, b"arte-de-aprender-prereg-v1")
    return {
        "__enc__": "aesgcm-v1",
        "nonce": base64.urlsafe_b64encode(nonce).decode("ascii").rstrip("="),
        "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii").rstrip("="),
    }


def decrypt_value(value: Any) -> Any:
    if not is_encrypted(value):
        return value
    key = _decode_key()
    nonce = base64.urlsafe_b64decode(value["nonce"] + "=" * (-len(value["nonce"]) % 4))
    ciphertext = base64.urlsafe_b64decode(value["ciphertext"] + "=" * (-len(value["ciphertext"]) % 4))
    plaintext = AESGCM(key).decrypt(nonce, ciphertext, b"arte-de-aprender-prereg-v1")
    return json.loads(plaintext.decode("utf-8"))


def encrypt_preregistration_data(data: dict) -> dict:
    result = deepcopy(data if isinstance(data, dict) else {})
    for field in SENSITIVE_PREREG_FIELDS:
        if field in result:
            result[field] = encrypt_value(result[field])
    people = result.get("authorizedPeople")
    if isinstance(people, list):
        protected = []
        for person in people:
            item = deepcopy(person) if isinstance(person, dict) else {}
            if "document" in item:
                item["document"] = encrypt_value(item["document"])
            protected.append(item)
        result["authorizedPeople"] = protected
    return result


def decrypt_preregistration_data(data: dict) -> dict:
    result = deepcopy(data if isinstance(data, dict) else {})
    for field in SENSITIVE_PREREG_FIELDS:
        if field in result:
            result[field] = decrypt_value(result[field])
    people = result.get("authorizedPeople")
    if isinstance(people, list):
        restored = []
        for person in people:
            item = deepcopy(person) if isinstance(person, dict) else {}
            if "document" in item:
                item["document"] = decrypt_value(item["document"])
            restored.append(item)
        result["authorizedPeople"] = restored
    return result


def preregistration_needs_migration(data: dict) -> bool:
    source = data if isinstance(data, dict) else {}
    for field in SENSITIVE_PREREG_FIELDS:
        if source.get(field) not in (None, "", [], {}) and not is_encrypted(source.get(field)):
            return True
    for person in source.get("authorizedPeople") if isinstance(source.get("authorizedPeople"), list) else []:
        if isinstance(person, dict) and person.get("document") and not is_encrypted(person.get("document")):
            return True
    return False
