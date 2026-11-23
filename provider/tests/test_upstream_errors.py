"""Public error contracts stay aligned while authentication keeps its domain errors."""

import pytest
from pydantic import ValidationError
from qqmusic_api import (
    ApiDataError,
    BaseApiException,
    CredentialExpiredError,
    CredentialInvalidError,
    CredentialRefreshError,
    HTTPError,
    LoginAccountRestrictedError,
    LoginAuthExpiredError,
    LoginDeviceLimitError,
    LoginRateLimitError,
    NetworkError,
    RatelimitedError,
)

from qqmusic_provider.auth import _map_upstream_error as auth_error
from qqmusic_provider.catalog import _map_upstream_error as catalog_error
from qqmusic_provider.library import _map_upstream_error as library_error
from qqmusic_provider.playback import _map_upstream_error as playback_error


@pytest.mark.parametrize(("error", "code", "auth_code", "retryable"), [
    (NetworkError("fixture"), "network_unavailable", "auth_network_unavailable", True),
    (HTTPError("fixture", 503), "network_unavailable", "auth_network_unavailable", True),
    (RatelimitedError(code=2001), "rate_limited", "auth_rate_limited", True),
    (CredentialExpiredError(code=1000), "authentication_required", "credential_invalid", False),
    (CredentialInvalidError("fixture"), "authentication_required", "credential_invalid", False),
    (ApiDataError("fixture"), "upstream_schema_changed", "upstream_schema_changed", False),
    (ValueError("fixture"), "upstream_schema_changed", "upstream_schema_changed", False),
    (TypeError("fixture"), "upstream_schema_changed", "upstream_schema_changed", False),
    (KeyError("fixture"), "upstream_schema_changed", "upstream_schema_changed", False),
    (ValidationError.from_exception_data("fixture", []),
     "upstream_schema_changed", "upstream_schema_changed", False),
    (BaseApiException("fixture"), "upstream_unavailable", "upstream_unavailable", True),
    (RuntimeError("fixture"), "upstream_unavailable", "upstream_unavailable", True),
])
def test_shared_errors_keep_each_public_contract(error, code, auth_code, retryable):
    for mapper in (catalog_error, library_error, playback_error):
        result = mapper(error)
        assert (result.code, result.retryable) == (code, retryable)
    result = auth_error(error)
    assert (result.code, result.retryable) == (auth_code, retryable)


@pytest.mark.parametrize(("error", "code", "retryable"), [
    (LoginRateLimitError(code=104604), "auth_rate_limited", True),
    (LoginAccountRestrictedError(code=20277), "auth_account_restricted", False),
    (LoginDeviceLimitError(code=20279), "auth_device_limit", False),
    (LoginAuthExpiredError(code=104401), "credential_invalid", False),
    (CredentialRefreshError(code=104401), "credential_invalid", False),
])
def test_login_domain_errors_remain_distinct(error, code, retryable):
    result = auth_error(error)
    assert (result.code, result.retryable) == (code, retryable)


def test_only_local_credential_deserialization_maps_schema_errors_to_invalid():
    error = ValueError("fixture")
    assert auth_error(error).code == "upstream_schema_changed"
    assert auth_error(error, credential_payload=True).code == "credential_invalid"
    # A transport or upstream schema failure is not evidence of a malformed stored secret.
    assert auth_error(ApiDataError("fixture"), credential_payload=True).code == (
        "upstream_schema_changed"
    )
