import hashlib
import hmac
import secrets
from typing import Union


def secure_token_hex(nbytes: int = 32) -> str:
    return secrets.token_hex(nbytes)


def sha256_hex(data: Union[str, bytes]) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hmac_sha256(secret: str, message: Union[str, bytes]) -> str:
    if isinstance(message, str):
        message = message.encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
