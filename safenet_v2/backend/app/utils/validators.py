import re
from typing import Optional


_PHONE_IN = re.compile(r"^\d{10}$")


def normalize_phone(phone: str) -> Optional[str]:
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if _PHONE_IN.match(digits):
        return digits
    return None
