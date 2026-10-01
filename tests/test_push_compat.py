import base64
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from smg.push_compat import private_key_pem


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def test_legacy_vapid_scalar_is_converted_without_rotating_public_key():
    private = ec.generate_private_key(ec.SECP256R1())
    private_value = private.private_numbers().private_value.to_bytes(32, "big")
    public = private.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )

    pem = private_key_pem({"privateKey": b64url(private_value), "publicKey": b64url(public)})
    restored = serialization.load_pem_private_key(pem.encode("ascii"), password=None)

    assert restored.public_key().public_numbers() == private.public_key().public_numbers()


def test_existing_pem_is_used_as_is():
    private = ec.generate_private_key(ec.SECP256R1())
    pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")

    assert private_key_pem({"privateKeyPem": pem}) == pem


def test_vapid_sender_does_not_write_private_key_to_temporary_file():
    source = (Path(__file__).resolve().parents[1] / "smg" / "push_compat.py").read_text(encoding="utf-8")
    assert "NamedTemporaryFile" not in source
    assert "tempfile" not in source
    assert "serialization.Encoding.DER" in source
    assert "vapid_private_key=_b64url_encode(private_der)" in source
