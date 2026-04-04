from pydantic import AliasChoices, BaseModel, Field, field_validator


class SendOTPRequest(BaseModel):
    phone_number: str = Field(..., validation_alias=AliasChoices("phone_number", "phone"), min_length=10, max_length=10)

    @field_validator("phone_number")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        v = (v or "").strip()
        if (not v.isdigit()) or len(v) != 10 or v[0] not in {"6", "7", "8", "9"}:
            raise ValueError("Please enter a valid Indian 10-digit mobile number")
        return v


class VerifyOTPRequest(BaseModel):
    phone_number: str = Field(..., validation_alias=AliasChoices("phone_number", "phone"), min_length=10, max_length=10)
    otp: str = Field(..., min_length=6, max_length=6)
    # When true, mint a JWT with `type="admin"` (requires the user to be an admin).
    admin: bool = False

    @field_validator("phone_number")
    @classmethod
    def validate_phone_verify(cls, v: str) -> str:
        v = (v or "").strip()
        if (not v.isdigit()) or len(v) != 10 or v[0] not in {"6", "7", "8", "9"}:
            raise ValueError("Please enter a valid Indian 10-digit mobile number")
        return v


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user_id: int
    is_new_user: bool = False


class RefreshRequest(BaseModel):
    refresh_token: str
    # When true, attempt to mint a JWT with `type="admin"` (requires the user to be an admin).
    admin: bool = False

    @field_validator("refresh_token")
    @classmethod
    def token_not_empty(cls, v: str) -> str:
        val = (v or "").strip()
        if not val:
            raise ValueError("Refresh token is required")
        return val
