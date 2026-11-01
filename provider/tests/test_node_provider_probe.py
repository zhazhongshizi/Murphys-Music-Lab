"""Step-2 real child-process handshake checked against the frozen v2 schema."""
import json
from pathlib import Path
import subprocess

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
NODE = ROOT / "output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe"
SCHEMA = json.loads((ROOT / "contracts/protocol-v2.schema.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("provider", ["netease", "bilibili"])
def test_real_bundled_node_handshake_schema(provider: str) -> None:
    if not NODE.is_file():
        pytest.skip("Run scripts/bootstrap-node-runtime.ps1 to prepare the pinned runtime")
    request = {"v": 2, "id": "schema-check", "method": "system.handshake", "params": {"protocolVersion": 2, "providerId": provider}}
    child = subprocess.run(
        [str(NODE), str(ROOT / "providers/node/handshake-probe.mjs"), provider],
        input=json.dumps(request) + "\n", text=True, capture_output=True, timeout=5,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert child.returncode == 0
    assert child.stderr == ""
    response = json.loads(child.stdout)
    Draft202012Validator(SCHEMA).validate(response)
    Draft202012Validator({"$defs": SCHEMA["$defs"], "$ref": "#/$defs/handshake"}).validate(response["result"])
    assert response["id"] == request["id"]
    assert response["result"]["provider"]["id"] == provider
    assert response["result"]["implementedMethods"] == ["system.handshake", "system.ping"]
