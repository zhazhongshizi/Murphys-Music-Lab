"""Generate the offline, locked Stage G distribution notices (Python 3.13+).

Reads source/dependency metadata only; never reads application data or credentials.
The generated inventory covers the new Node providers/runtime and changed Rust
dependencies, plus the existing frontend and QQ runtime dependency closures.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import sys
import tomllib

from packaging.requirements import Requirement


ROOT = Path(__file__).resolve().parents[1]
BASELINE = "07f53de64f1150508f1ee270dd3d03311b9c2437"
NOTICE = re.compile(r"^(licen[cs]e|copying|copyright|notice|unlicense)(?:[._-].*)?$", re.I)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def baseline_file(path: str) -> str:
    # Checked-in public dependency snapshots also work from a source archive.
    return (ROOT / "scripts/provider-notices-baseline" / path).read_text(encoding="utf-8")


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", value)


def package_notices(directory: Path) -> list[Path]:
    found = [p for p in directory.iterdir() if p.is_file() and NOTICE.match(p.name)]
    for name in ("licenses", "license", "LICENSES"):
        nested = directory / name
        if nested.is_dir():
            found.extend(p for p in nested.rglob("*") if p.is_file())
    return sorted(set(found))


class Inventory:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.entries: list[dict] = []
        self.inputs: dict[str, str] = {}
        self.issues: list[str] = []

    def input(self, relative: str) -> None:
        self.inputs[relative] = digest(ROOT / relative)

    def notices(self, name: str, paths: list[Path]) -> list[dict]:
        result = []
        if not paths:
            self.issues.append(f"Missing actual license/notice text: {name}")
        for path in paths:
            data = path.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            target = f"notices/{safe_name(name)}/{safe_name(path.name)}"
            # Distinguish same-named notices in nested license directories.
            if target in self.files and self.files[target] != data:
                target = f"notices/{safe_name(name)}/{sha[:12]}-{safe_name(path.name)}"
            self.files[target] = data
            result.append({"path": target, "sha256": sha})
        return result

    def node_provider(self, provider: str) -> None:
        relative = f"providers/node/{provider}"
        folder = ROOT / relative
        self.input(f"{relative}/package.json")
        self.input(f"{relative}/package-lock.json")
        lock = load(folder / "package-lock.json")
        pkg = load(folder / "package.json")
        if lock["packages"][""]["dependencies"] != pkg["dependencies"]:
            raise ValueError(f"{provider}: package.json dependency lock drift")
        for installed_path, item in sorted(lock["packages"].items()):
            if not installed_path or item.get("dev"):
                continue
            installed = folder / installed_path
            actual = load(installed / "package.json")
            if actual["version"] != item["version"]:
                raise ValueError(f"{provider}: installed version mismatch: {installed_path}")
            name = actual["name"]
            if "biu" == name.lower() or "polyform" in str(actual.get("license", "")).lower():
                raise ValueError(f"Excluded noncommercial dependency: {name}")
            license_id = actual.get("license", item.get("license", "UNKNOWN"))
            if license_id != item.get("license", license_id):
                self.issues.append(f"{provider}/{name}: package/license lock mismatch")
            tree = hashlib.sha256()
            file_count = 0
            for path in sorted(installed.rglob("*")):
                if path.is_file() and "node_modules" not in path.relative_to(installed).parts:
                    tree.update(path.relative_to(installed).as_posix().encode())
                    tree.update(b"\0")
                    tree.update(bytes.fromhex(digest(path)))
                    file_count += 1
            self.entries.append({
                "kind": "npm", "usedBy": provider, "name": name,
                "version": item["version"], "source": item["resolved"],
                "integrity": item["integrity"], "license": license_id,
                "installedPackageJsonSha256": digest(installed / "package.json"),
                "installedTreeSha256": tree.hexdigest(), "installedFileCount": file_count,
                "notices": self.notices(f"npm-{name}-{item['version']}", package_notices(installed)),
                "retention": "Retain the full license and copyright notices referenced here.",
            })

    def upstreams(self) -> None:
        relative = "providers/node/netease/upstream-lock.json"
        self.input(relative)
        lock = load(ROOT / relative)
        for name, expected in lock["files"].items():
            path = ROOT / "providers/node/netease/upstream" / name
            if digest(path) != expected:
                raise ValueError(f"NetEase upstream hash mismatch: {name}")
        actual = {p.relative_to(ROOT / "providers/node/netease/upstream").as_posix()
                  for p in (ROOT / "providers/node/netease/upstream").rglob("*") if p.is_file()}
        if actual != set(lock["files"]):
            raise ValueError("NetEase upstream contains unlisted files")
        pkg = load(ROOT / "providers/node/netease/upstream/package.json")
        if pkg != {"private": True, "type": "commonjs"}:
            raise ValueError("NetEase local CJS package shim changed")
        self.entries.append({
            "kind": "vendored-source", "name": "NeteaseCloudMusicApiEnhanced/api-enhanced",
            "version": lock["version"], "commit": lock["commit"], "source": lock["repository"],
            "integrity": {"algorithm": "sha256", "files": lock["files"]},
            "license": "MIT", "notices": self.notices("api-enhanced-4.41.1", [ROOT / "providers/node/netease/upstream/LICENSE"]),
            "retention": "Copyright (c) 2013-2022 Binaryify; retain complete MIT license.",
            "scope": "23 locked files: 22 fixed upstream files and one local package.json CJS shim (19 from 3b plus four 3d modules). The shim is not an original upstream package manifest. Version/commit come from upstream-lock.json; runtime dependency closure is the dedicated provider package-lock.json, not the upstream whole application.",
        })
        relative = "providers/node/bilibili/reference-lock.json"
        self.input(relative)
        references = load(ROOT / relative)
        for item in references["files"]:
            if digest(ROOT / "providers/node/bilibili" / item["path"]) != item["sha256"]:
                raise ValueError(f"Bilibili reference hash mismatch: {item['path']}")
        for key, name, file, copyright in (
            ("bbplayer", "BBPlayer", "BBPlayer-LICENSE", "Copyright (c) 2025 Roitium."),
            ("bridge", "bili-music", "bili-music-LICENSE", "Copyright (c) 2026 Jmiao11"),
        ):
            ref = references[key]
            integrity = {i["path"]: i["sha256"] for i in references["files"]
                         if i["path"].endswith(file) or
                         (key == "bbplayer" and i["path"].endswith(".ts.txt")) or
                         (key == "bridge" and i["path"].endswith("proxy.rs.txt"))}
            self.entries.append({
                "kind": "implementation-reference", "name": name, "commit": ref["commit"],
                "source": f"https://github.com/{ref['repository']}", "integrity": integrity,
                "license": "MIT", "notices": self.notices(name, [ROOT / "providers/node/bilibili/reference" / file]),
                "retention": f"{copyright}; retain complete MIT license and reference attribution. Reference/probe source files are not production providers.",
            })

    def node_runtime(self) -> None:
        self.input("providers/node/runtime.json")
        runtime = load(ROOT / "providers/node/runtime.json")
        directory = ROOT / f"output/node-{runtime['version']}/bundled/node-v{runtime['version']}-win-x64"
        if digest(directory / "node.exe") != runtime["executableSha256"]:
            raise ValueError("Bundled Node executable hash mismatch")
        self.entries.append({
            "kind": "runtime", "name": "Node.js", "version": runtime["version"],
            "source": runtime["archiveUrl"], "integrity": {
                "archiveSha256": runtime["archiveSha256"], "executableSha256": runtime["executableSha256"]},
            "license": "MIT AND bundled third-party licenses (see complete Node LICENSE)",
            "notices": self.notices(f"node-{runtime['version']}", [directory / "LICENSE"]),
            "retention": "Retain complete Node LICENSE, including all embedded third-party texts and notices.",
        })

    def rust_changes(self) -> None:
        self.input("src-tauri/Cargo.toml")
        self.input("src-tauri/Cargo.lock")
        self.input("scripts/provider-notices-baseline/src-tauri/Cargo.toml")
        old = tomllib.loads(baseline_file("src-tauri/Cargo.toml"))
        new = tomllib.loads((ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8"))
        lock = tomllib.loads((ROOT / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
        old_dependencies = dict(old["dependencies"])
        new_dependencies = dict(new["dependencies"])
        old_dependencies.update(old["target"]["cfg(windows)"]["dependencies"])
        new_dependencies.update(new["target"]["cfg(windows)"]["dependencies"])
        registry = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo"))) / "registry/src"
        for name, spec in sorted(new_dependencies.items()):
            if spec == old_dependencies.get(name):
                continue
            wanted = spec.get("version", "") if isinstance(spec, dict) else spec
            items = [p for p in lock["package"] if p["name"] == name and p["version"] == wanted.lstrip("=")]
            if len(items) != 1:
                raise ValueError(f"Ambiguous changed Rust dependency: {name}")
            item = items[0]
            sources = list(registry.glob(f"*/{name}-{item['version']}"))
            if len(sources) != 1:
                raise ValueError(f"Rust source missing/ambiguous: {name}")
            directory = sources[0]
            actual = tomllib.loads((directory / "Cargo.toml").read_text(encoding="utf-8"))["package"]
            self.entries.append({
                "kind": "rust-change", "name": name, "version": item["version"],
                "source": actual.get("repository", item["source"]), "integrity": f"sha256-{item['checksum']}",
                "license": actual["license"],
                "features": spec.get("features", []) if isinstance(spec, dict) else [],
                "previousSpecification": old_dependencies.get(name),
                "notices": self.notices(f"rust-{name}-{item['version']}", package_notices(directory)),
                "retention": "Retain full supplied license/notice texts; alternative licenses remain available as stated upstream.",
            })

    def frontend(self) -> None:
        self.input("package.json")
        self.input("pnpm-lock.yaml")
        package = load(ROOT / "package.json")
        self.input("scripts/provider-notices-baseline/package.json")
        old = json.loads(baseline_file("package.json"))
        lock_text = (ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
        changed = package.get("dependencies", {}) != old.get("dependencies", {})
        pending = [(ROOT, name) for name in package["dependencies"]]
        seen: set[Path] = set()
        while pending:
            parent, requested = pending.pop()
            candidates = [parent / "node_modules" / requested]
            candidates.extend(p / "node_modules" / requested for p in parent.parents)
            directory = next((p.resolve() for p in candidates if (p / "package.json").is_file()), None)
            if directory is None:
                raise ValueError(f"Missing frontend runtime package: {requested}")
            if directory in seen:
                continue
            seen.add(directory)
            item = load(directory / "package.json")
            locked = re.search(
                r"^  '?" + re.escape(f"{item['name']}@{item['version']}") + r"'?:\s*\n((?:    .*\n|\n)*)",
                lock_text, re.MULTILINE,
            )
            if locked is None:
                raise ValueError(f"Installed frontend package absent from lock: {item['name']}@{item['version']}")
            integrity_match = re.search(r"\bintegrity:\s*([^,}\s]+)", locked.group(1))
            if integrity_match is None:
                raise ValueError(f"Missing frontend package tarball integrity: {item['name']}")
            pending.extend((directory, name) for name in item.get("dependencies", {}))
            self.entries.append({
                "kind": "frontend-runtime", "name": item["name"], "version": item["version"],
                "source": item.get("repository", f"https://www.npmjs.com/package/{item['name']}"),
                "integrity": {"tarball": integrity_match.group(1), "packageJsonSha256": digest(directory / "package.json"), "lockSha256": self.inputs["pnpm-lock.yaml"]},
                "license": item.get("license", "UNKNOWN"), "newDependencyInMultiProvider": changed,
                "notices": self.notices(f"frontend-{item['name']}-{item['version']}", package_notices(directory)),
                "retention": "Retain complete license/copyright notices in binary distributions.",
            })
        self.input("vendor/rhine/LICENSE")
        self.input("vendor/rhine/README.md")
        self.entries.append({
            "kind": "vendored-frontend", "name": "LBEILC/RhineLabUI",
            "commit": "3f4b9c9e8fdc9c6aa689e8c0b2faa5c53df93826",
            "additionalOpeningCommit": "ee5779741c6c0c916e416705fa634c7abf905c73",
            "source": "https://github.com/LBEILC/RhineLabUI",
            "integrity": {"licenseSha256": self.inputs["vendor/rhine/LICENSE"], "provenanceSha256": self.inputs["vendor/rhine/README.md"]},
            "license": "MIT", "notices": self.notices("RhineLabUI", [ROOT / "vendor/rhine/LICENSE", ROOT / "vendor/rhine/README.md"]),
            "retention": "Copyright (c) 2026 LBEILC. Retain MIT license and resource-rights boundaries in the accompanying provenance README.",
        })

    def python_runtime(self) -> None:
        self.input("provider/requirements.lock")
        self.input("provider/pyproject.toml")
        locked = {}
        for line in (ROOT / "provider/requirements.lock").read_text(encoding="utf-8").splitlines():
            if "==" in line and not line.lstrip().startswith("#"):
                name, version = line.strip().split("==", 1)
                locked[re.sub(r"[-_.]+", "-", name).lower()] = version
        # Follow only active runtime requirements, not optional test/build extras.
        pending = ["qqmusic-api-python"]
        seen: set[str] = set()
        while pending:
            requested = pending.pop()
            dist = metadata.distribution(requested)
            name = dist.metadata["Name"]
            normalized = re.sub(r"[-_.]+", "-", name).lower()
            if locked.get(normalized) != dist.version:
                raise ValueError(f"Installed QQ runtime version differs from requirements.lock: {name}=={dist.version}")
            if normalized in seen:
                continue
            seen.add(normalized)
            for raw in dist.requires or []:
                req = Requirement(raw)
                if req.marker is None or req.marker.evaluate({"extra": ""}):
                    pending.append(req.name)
            license_id = dist.metadata.get("License-Expression") or dist.metadata.get("License")
            classifiers = [v for v in dist.metadata.get_all("Classifier", []) if v.startswith("License ::")]
            paths = []
            record = []
            for f in dist.files or []:
                path = Path(dist.locate_file(f))
                if path.is_file() and (NOTICE.match(path.name) or "licenses" in f.parts):
                    paths.append(path)
                if str(f).endswith(".dist-info/RECORD"):
                    record.append(path)
            source = dist.metadata.get_all("Project-URL", []) or [dist.metadata.get("Home-page", "https://pypi.org/project/" + name)]
            notices = self.notices(f"python-{name}-{dist.version}", sorted(set(paths)))
            supplemental_sources = []
            if normalized == "paho-mqtt":
                self.input("scripts/generate-provider-notices.sources.json")
                supplement = load(ROOT / "scripts/generate-provider-notices.sources.json")
                if supplement["ref"] != f"v{dist.version}":
                    raise ValueError("Paho supplemental license version drift")
                for filename, original in sorted(supplement["files"].items()):
                    data = base64.b64decode(original["content"])
                    blob = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
                    if original["encoding"] != "base64" or blob != original["sha"]:
                        raise ValueError("Paho supplemental license Git blob mismatch")
                    relative = f"notices/python-{name}-{dist.version}/{filename}"
                    self.files[relative] = data
                    notices.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest()})
                    supplemental_sources.append({"url": original["display_url"], "gitBlobSha1": blob})
            # Classifiers do not provide SPDX expressions for these installed wheels;
            # their actual bundled license texts have also been inspected.
            if normalized == "qqmusic-api-python":
                license_id = "GPL-3.0-or-later"
            elif normalized == "qh3":
                license_id = "BSD-3-Clause"
            self.entries.append({
                "kind": "python-runtime", "name": name, "version": dist.version,
                "source": source, "integrity": {"metadataSha256": hashlib.sha256((dist.read_text("METADATA") or "").encode()).hexdigest(), "recordSha256": [digest(p) for p in record]},
                "license": license_id or classifiers or "UNKNOWN", "notices": notices,
                "supplementalNoticeSources": supplemental_sources,
                "retention": "Retain complete supplied license/copyright texts. Python runtime closure is separate from locked development/build tools.",
            })
        python_license = Path(sys.base_prefix) / "LICENSE.txt"
        self.entries.append({
            "kind": "runtime", "name": "CPython", "version": ".".join(map(str, sys.version_info[:3])),
            "source": "https://www.python.org/", "integrity": {"licenseSha256": digest(python_license)},
            "license": "PSF-2.0 AND embedded third-party notices", "notices": self.notices("CPython", [python_license]),
            "retention": "Retain complete Python LICENSE.txt and embedded third-party notices.",
        })

    def render(self) -> dict[str, bytes]:
        document = {
            "schemaVersion": 1, "baselineCommit": BASELINE,
            "scope": "Stage G Node runtime/providers (all npm runtime dependencies), changed Rust dependencies/features since baseline, frontend runtime closure (no new frontend dependency), and QQ Python runtime closure. Existing other Rust/OS/framework components remain governed by THIRD_PARTY_NOTICES.md and upstream terms; this is not a claim of a complete pre-existing Rust SBOM.",
            "inputs": dict(sorted(self.inputs.items())),
            "entries": sorted(self.entries, key=lambda v: (v["kind"], v["name"], v.get("version", ""), v.get("usedBy", ""))),
            "issues": self.issues,
        }
        self.files["dependencies.json"] = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode()
        lines = ["# Stage G dependency sources and third-party notices", "", "Generated offline by `scripts/generate-provider-notices.py`; exact input hashes and notices are in `dependencies.json`.", "", document["scope"], "", "Retain this directory and THIRD_PARTY_NOTICES.md when redistributing the portable package. All notice files are copied byte-for-byte from installed/locked upstream resources. No reference/probe executable is supplied here.", "", f"Entries: {len(self.entries)}. Missing/mismatched notice texts: {len(self.issues)}.", "", "| Kind | Name | Version / commit | License |", "| --- | --- | --- | --- |"]
        for entry in document["entries"]:
            license_id = str(entry["license"]).replace("|", "\\|").replace("\n", " ")
            lines.append(f"| {entry['kind']} | {entry['name']} | {entry.get('version', entry.get('commit', ''))} | {license_id} |")
        if self.issues:
            lines.extend(["", "## Issues", "", *[f"- {issue}" for issue in self.issues]])
        self.files["README.md"] = ("\n".join(lines) + "\n").encode()
        return self.files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "licenses/provider-g")
    parser.add_argument("--check", action="store_true", help="Check generated files against source metadata without writing")
    args = parser.parse_args()
    inventory = Inventory()
    inventory.node_runtime()
    inventory.upstreams()
    inventory.node_provider("netease")
    inventory.node_provider("bilibili")
    inventory.rust_changes()
    inventory.frontend()
    inventory.python_runtime()
    expected = inventory.render()
    if args.check:
        for name, data in expected.items():
            path = args.output / name
            if not path.is_file() or path.read_bytes() != data:
                raise ValueError(f"Generated notice drift: {path}")
        actual = {p.relative_to(args.output).as_posix() for p in args.output.rglob("*") if p.is_file()}
        if actual != set(expected):
            raise ValueError("Generated notice directory has unlisted files")
    else:
        # Do not silently leave stale notices after dependency changes.
        actual = {p.relative_to(args.output).as_posix() for p in args.output.rglob("*") if p.is_file()}
        stale = actual - set(expected)
        if stale:
            raise ValueError(f"Stale notices require explicit review/removal: {sorted(stale)}")
        for name, data in expected.items():
            path = args.output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    print(f"Stage G notices: {len(inventory.entries)} entries, {len(expected)} files, {len(inventory.issues)} issues; {args.output}")
    for issue in inventory.issues:
        print(f"ISSUE: {issue}")
    return 1 if inventory.issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
