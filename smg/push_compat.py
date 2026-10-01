from __future__ import annotations

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import webpush


def _b64url_decode(value: str) -> bytes:
    clean = str(value or "").strip()
    if not clean:
        return b""
    return base64.urlsafe_b64decode(clean + "=" * (-len(clean) % 4))


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def private_key_pem(vapid: dict) -> str:
    """Return a PKCS8 PEM key without rotating existing VAPID subscriptions.

    Older Arte de Aprender installations stored the raw P-256 private scalar as base64url
    under ``privateKey``. Converting the same scalar preserves the public key and
    therefore keeps existing browser subscriptions valid.
    """
    existing = str(vapid.get("privateKeyPem") or "")
    if existing.strip():
        return existing

    raw = _b64url_decode(str(vapid.get("privateKey") or ""))
    if len(raw) != 32:
        raise RuntimeError("Chave VAPID antiga inválida; não foi possível convertê-la com segurança.")

    scalar = int.from_bytes(raw, "big")
    if scalar <= 0:
        raise RuntimeError("Chave VAPID antiga inválida; escalar privado vazio.")

    try:
        private = ec.derive_private_key(scalar, ec.SECP256R1())
    except ValueError as exc:
        raise RuntimeError("Chave VAPID antiga fora da curva P-256 esperada.") from exc

    stored_public = _b64url_decode(str(vapid.get("publicKey") or ""))
    if stored_public:
        derived_public = private.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        if derived_public != stored_public:
            raise RuntimeError(
                "A chave VAPID privada não corresponde à chave pública armazenada; envio bloqueado para preservar as inscrições existentes."
            )

    return private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")


def send_web_push(subscription: dict, payload: str, vapid: dict, subject: str, ttl: int = 600) -> None:
    pem = private_key_pem(vapid)
    try:
        private_key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Chave VAPID privada inválida.") from exc
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise RuntimeError("Chave VAPID privada inválida.")

    private_der = private_key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    webpush(
        subscription_info=subscription,
        data=payload,
        vapid_private_key=_b64url_encode(private_der),
        vapid_claims={"sub": subject},
        ttl=ttl,
    )
