"""Shared SDK failure classification, independent of public service error types."""

from dataclasses import dataclass
from enum import Enum

from pydantic import ValidationError
from qqmusic_api import (
    ApiDataError,
    CredentialExpiredError,
    CredentialInvalidError,
    HTTPError,
    NetworkError,
    RatelimitedError,
)


class UpstreamErrorCode(str, Enum):
    NETWORK_UNAVAILABLE = "network_unavailable"
    RATE_LIMITED = "rate_limited"
    AUTHENTICATION_REQUIRED = "authentication_required"
    UPSTREAM_SCHEMA_CHANGED = "upstream_schema_changed"
    UPSTREAM_UNAVAILABLE = "upstream_unavailable"


@dataclass(frozen=True, slots=True)
class UpstreamFailure:
    code: UpstreamErrorCode
    retryable: bool = False


def classify_upstream_error(error: Exception) -> UpstreamFailure:
    """Parsing/device failures never establish account expiry; unknown failures stay temporary."""
    if isinstance(error, NetworkError | HTTPError):
        return UpstreamFailure(UpstreamErrorCode.NETWORK_UNAVAILABLE, retryable=True)
    if isinstance(error, RatelimitedError):
        return UpstreamFailure(UpstreamErrorCode.RATE_LIMITED, retryable=True)
    if isinstance(error, CredentialExpiredError | CredentialInvalidError):
        return UpstreamFailure(UpstreamErrorCode.AUTHENTICATION_REQUIRED)
    if isinstance(error, ApiDataError | ValidationError | KeyError | TypeError | ValueError):
        return UpstreamFailure(UpstreamErrorCode.UPSTREAM_SCHEMA_CHANGED)
    return UpstreamFailure(UpstreamErrorCode.UPSTREAM_UNAVAILABLE, retryable=True)
