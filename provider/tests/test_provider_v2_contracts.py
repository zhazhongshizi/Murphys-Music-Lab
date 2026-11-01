"""Offline schema/fixture conformance. This is not a v2 runtime implementation."""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from qqmusic_provider.protocol import ProtocolViolation, parse_request

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests/fixtures/provider-v2"
SCHEMA = json.loads((ROOT / "contracts/protocol-v2.schema.json").read_text(encoding="utf-8"))
PUBLIC = json.loads((ROOT / "contracts/providers-public.schema.json").read_text(encoding="utf-8"))
CONSTANTS = json.loads((ROOT / "contracts/protocol-v2.constants.json").read_text(encoding="utf-8"))
EXCHANGES = json.loads((FIXTURES / "exchanges.json").read_text(encoding="utf-8"))
PUBLIC_CASES = json.loads((FIXTURES / "public.json").read_text(encoding="utf-8"))

def test_verification_required_and_failed_are_distinct() -> None:
    cases = json.loads((FIXTURES / "errors.json").read_text(encoding="utf-8"))
    for case in cases:
        Draft202012Validator(SCHEMA).validate(case)
        definition(PUBLIC, "errorCode").validate(case["error"]["code"])
    assert {case["error"]["code"] for case in cases} == {"verification_required", "verification_failed"}

def test_public_writes_have_strict_source_and_identity_boundaries() -> None:
    validator = definition(PUBLIC, "writeRequest")
    good = {"providerId": "netease", "accountId": "42", "operation": {"kind": "setLiked", "trackId": "netease:track:1", "liked": True}}
    validator.validate(good)
    for change in ({**good, "generation": 1}, {**good, "providerId": "bilibili"}, {**good, "operation": {**good["operation"], "ownerId": "42"}}, {**good, "operation": {"kind": "addItems", "containerId": "netease:playlist:7", "trackIds": ["bilibili:video:BV17x411w7KC:123"]}}):
        assert not validator.is_valid(change)
    validator.validate({"providerId": "bilibili", "accountId": "42", "operation": {"kind": "addItems", "containerId": "bilibili:favorite:7", "trackIds": ["bilibili:video:BV17x411w7KC:123", "bilibili:video:BV17x411w7KC:124"]}})

def test_verified_cooldown_is_bounded_and_public_safe() -> None:
    case = {"v": 2, "id": "cooldown", "ok": False,
            "error": {"code": "rate_limited", "retryable": False, "retryAfterMs": 120}}
    Draft202012Validator(SCHEMA).validate(case)
    definition(PUBLIC, "snapshot").validate({
        "providerId": "netease", "state": "disabled", "error": "rate_limited",
        "capabilities": CONSTANTS["capabilities"]["netease"], "retryAfterMs": 120,
    })
    for invalid in (-1, 1.5, 86400001, "raw upstream text"):
        case["error"]["retryAfterMs"] = invalid
        assert not Draft202012Validator(SCHEMA).is_valid(case)


def definition(schema: dict, name: str) -> Draft202012Validator:
    return Draft202012Validator({"$defs": schema["$defs"], "$ref": f"#/$defs/{name}"})


def test_bilibili_aac_backups_and_dash_are_explicit_private_extensions() -> None:
    result = copy.deepcopy(next(c for c in EXCHANGES if c["name"] == "bilibili.playback.resolve")["response"]["result"])
    validator = definition(SCHEMA, "resolution")
    validator.validate(result)
    for field, value in (("backupUrls", ["https://backup.invalid/same"] * 9),
                         ("dash", {"initialization": "0-9", "indexRange": "10-20", "url": "https://evil.invalid"}),
                         ("track", {"kind": "song", "songId": "1"}),
                         ("quality", "320k")):
        changed = {**result, field: value}
        assert not validator.is_valid(changed)
    netease = next(c for c in EXCHANGES if c["providerId"] == "netease" and c["request"]["method"] == "playback.resolve")["response"]["result"]
    validator.validate(netease)
    assert not validator.is_valid({**netease, "backupUrls": []})
    assert not validator.is_valid({**netease, "dash": result["dash"]})


def test_schemas_are_valid_and_every_method_has_an_exchange() -> None:
    Draft202012Validator.check_schema(SCHEMA)
    Draft202012Validator.check_schema(PUBLIC)
    assert set(CONSTANTS["methods"]) == {case["request"]["method"] for case in EXCHANGES}
    v1 = json.loads((ROOT / "contracts/protocol-v1.constants.json").read_text())
    assert v1["protocolVersion"] == 1
    assert CONSTANTS["protocolVersion"] == 2
    for field in ("maxLineBytes", "maxJsonDepth", "versionEncoding", "requestIdPattern"):
        assert CONSTANTS[field] == v1[field]


@pytest.mark.parametrize("case", EXCHANGES, ids=lambda case: case["name"])
def test_correlated_method_exchange(case: dict) -> None:
    validator = Draft202012Validator(SCHEMA)
    validator.validate(case["request"])
    validator.validate(case["response"])
    method = CONSTANTS["methods"][case["request"]["method"]]
    assert case["providerId"] in method["providers"]
    assert case["request"]["id"] == case["response"]["id"]
    definition(SCHEMA, method["params"]).validate(case["request"]["params"])
    definition(SCHEMA, method["result"]).validate(case["response"]["result"])
    # Success result validation must use the pending request, not merely the envelope.
    wrong = copy.deepcopy(case["response"]["result"])
    if isinstance(wrong, list):
        wrong.append({"unrecognizedUpstreamResponse": "SYNTHETIC_SECRET"})
    else:
        wrong["unrecognizedUpstreamResponse"] = "SYNTHETIC_SECRET"
    with pytest.raises(ValidationError):
        definition(SCHEMA, method["result"]).validate(wrong)
    request = copy.deepcopy(case["request"])
    request["params"]["unexpected"] = True
    with pytest.raises(ValidationError):
        validator.validate(request)


def test_v1_decoder_still_rejects_v2_instead_of_silent_negotiation() -> None:
    request = json.dumps(EXCHANGES[0]["request"]).encode()
    with pytest.raises(ProtocolViolation, match="protocol_version_mismatch"):
        parse_request(request)


@pytest.mark.parametrize("case", PUBLIC_CASES, ids=lambda case: case["definition"])
def test_public_dto_excludes_private_fields(case: dict) -> None:
    validator = definition(PUBLIC, case["definition"])
    validator.validate(case["value"])
    for key in ("credential", "cookie", "url", "headers", "generation", "rawResponse"):
        value = {**case["value"], key: "SYNTHETIC_SECRET"}
        with pytest.raises(ValidationError):
            validator.validate(value)


def test_nested_public_account_rejects_credentials_and_wrong_platform() -> None:
    sample = copy.deepcopy(PUBLIC_CASES[1]["value"])
    sample["account"]["cookie"] = "SYNTHETIC_SECRET"
    with pytest.raises(ValidationError):
        definition(PUBLIC, "snapshot").validate(sample)
    sample["account"].pop("cookie")
    sample["account"]["providerId"] = "bilibili"
    with pytest.raises(ValidationError):
        definition(PUBLIC, "snapshot").validate(sample)


def test_schema_and_shared_identity_vectors_agree() -> None:
    data = json.loads((FIXTURES / "identities.json").read_text(encoding="utf-8"))
    validator = definition(PUBLIC, "trackRef")
    for case in data["tracks"]:
        providers = ("qqmusic", "netease", "bilibili", "local")
        for provider in providers:
            valid = validator.is_valid({"id": case["id"], "providerId": provider})
            assert valid == (case["providerId"] == provider), case


def test_raw_ids_and_media_headers_are_bounded_and_platform_neutral() -> None:
    track = definition(SCHEMA, "rawTrack")
    for bad in ("netease:track:123", "0", "01", "123\n", "1e3", 123):
        assert not track.is_valid({"kind": "song", "songId": bad})
    resolution = copy.deepcopy(next(c for c in EXCHANGES if c["request"]["method"] == "playback.resolve")["response"]["result"])
    resolution["headers"]["Cookie"] = "SYNTHETIC_SECRET"
    assert not definition(SCHEMA, "resolution").is_valid(resolution)
    resolution["headers"] = {}
    resolution["url"] = "http://127.0.0.1:1234/private"
    assert not definition(SCHEMA, "resolution").is_valid(resolution)


def test_write_auth_and_read_semantics_are_distinct() -> None:
    for method, contract in CONSTANTS["methods"].items():
        if method.startswith(("library.set", "library.add", "library.remove", "auth.qr.")):
            assert contract["semantics"] == "neverReplay"
        if method.startswith(("search.", "library.", "lyrics.", "playback.", "video.", "song.")):
            assert contract["access"] == "ready"
    assert CONSTANTS["methods"]["auth.credential.refresh"]["providers"] == ["netease"]
    assert CONSTANTS["capabilities"]["bilibili"]["qualities"] == ["auto", "aac"]
    assert not CONSTANTS["capabilities"]["bilibili"]["lyrics"]
    for profile in CONSTANTS["capabilities"].values():
        assert "playlist.create" not in profile["writeActions"]
        assert "playlist.delete" not in profile["writeActions"]


def test_unknown_method_version_and_raw_error_text_are_rejected() -> None:
    validator = Draft202012Validator(SCHEMA)
    request = copy.deepcopy(EXCHANGES[0]["request"])
    request["v"] = 1
    assert not validator.is_valid(request)
    request["v"] = 2
    request["method"] = "http.request"
    assert not validator.is_valid(request)
    error = {"v": 2, "id": "fixture", "ok": False, "error": {"code": "outcome_unknown", "retryable": False}}
    validator.validate(error)
    error["error"]["message"] = "upstream URL and cookie"
    assert not validator.is_valid(error)


def test_video_metadata_survives_without_creating_a_playable_summary() -> None:
    part = next(case["value"] for case in PUBLIC_CASES if case["definition"] == "track")
    assert part["video"]["title"] != part["video"]["partTitle"]
    missing = copy.deepcopy(part)
    missing.pop("video")
    assert not definition(PUBLIC, "track").is_valid(missing)
    wrong = copy.deepcopy(part)
    wrong["video"]["partNumber"] = 0
    assert not definition(PUBLIC, "track").is_valid(wrong)
    video = next(case["value"] for case in PUBLIC_CASES if case["definition"] == "video")
    assert not definition(PUBLIC, "trackRef").is_valid(video)
    for status in ("deleted", "permissionDenied", "processing", "noAudio"):
        definition(PUBLIC, "video").validate({**video, "availability": status})
    definition(SCHEMA, "errorCode").validate("preview_only")
    assert PUBLIC["$defs"]["container"]["properties"]["allowedActions"] == PUBLIC["$defs"]["capabilities"]["properties"]["writeActions"]
