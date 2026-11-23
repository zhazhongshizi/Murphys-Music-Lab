"""QQ request identities. Preserve SDK-owned profiles; override only proven exceptions."""

from __future__ import annotations

from dataclasses import dataclass, replace
from types import MappingProxyType
from typing import Any

from qqmusic_api.core.request import CgiRequest, HttpRequest
from qqmusic_api.core.versioning import Platform


@dataclass(frozen=True, slots=True)
class RequestIdentity:
    platform: Platform
    reason: str
    sdk_defined: bool = False


DEFAULT_IDENTITY = RequestIdentity(
    Platform.DESKTOP,
    "Keep QR login, credential refresh, MV and other unlisted operations on Desktop.",
)
_ANDROID_CHECK = RequestIdentity(
    Platform.ANDROID, "GetLoginUserInfo accepts credentials rejected by the Desktop profile.",
)
_ANDROID_ADD = RequestIdentity(
    Platform.ANDROID, "Playlist additions and likes share the AddSonglist endpoint.",
)
_ANDROID_REMOVE = RequestIdentity(
    Platform.ANDROID,
    "Desktop removals were rejected during live acceptance; DelSonglist also needs Android.",
)
_SDK_SEARCH = RequestIdentity(
    Platform.ANDROID, "QQMusicApi 0.8.2 fixes typed search to Android.", sdk_defined=True,
)
REQUEST_IDENTITIES = MappingProxyType({
    "auth.credential.check": _ANDROID_CHECK,
    "playlist.addSongs": _ANDROID_ADD,
    "song.like": _ANDROID_ADD,
    "playlist.removeSongs": _ANDROID_REMOVE,
    "song.unlike": _ANDROID_REMOVE,
    "recommend.guess": RequestIdentity(
        Platform.ANDROID, "The same credential succeeds on Android but returns 1000 on Desktop.",
    ),
    # Internal operation name: playback.resolve may also invoke the Desktop MV path.
    "playback.original": RequestIdentity(
        Platform.ANDROID, "Some recordings return an original audio URL only on Android.",
    ),
    "search.songs": _SDK_SEARCH,
    "search.artists": _SDK_SEARCH,
    "search.albums": _SDK_SEARCH,
    "search.playlists": _SDK_SEARCH,
    "song.detail": RequestIdentity(
        Platform.WEB, "QQMusicApi 0.8.2 fixes song detail to Web.", sdk_defined=True,
    ),
})

def identity_for(operation: str) -> RequestIdentity:
    return REQUEST_IDENTITIES.get(operation, DEFAULT_IDENTITY)


def apply_request_identity[RequestT: CgiRequest[Any] | HttpRequest[Any]](
    operation: str, request: RequestT,
) -> RequestT:
    """Copy a descriptor only for an explicit application override; never mutate the client."""
    identity = REQUEST_IDENTITIES.get(operation)
    if identity is not None and not identity.sdk_defined and isinstance(request, CgiRequest):
        return replace(request, platform=identity.platform)
    return request
