//! Synthetic offline subprocess. Never imports an upstream SDK or opens a socket.
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    thread,
    time::Duration,
};
fn emit(v: Value) {
    let mut o = io::stdout().lock();
    writeln!(o, "{v}").unwrap();
    o.flush().unwrap();
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let provider = args.get(1).map(String::as_str).unwrap_or("netease");
    let scenario = args.get(2).map(String::as_str).unwrap_or("normal");
    let marker = args.get(3).map(PathBuf::from);
    let mut boot = 1;
    if let Some(p) = &marker {
        let n = fs::read_to_string(p)
            .ok()
            .and_then(|x| x.parse::<u64>().ok())
            .unwrap_or(0);
        fs::write(p, (n + 1).to_string()).unwrap();
        boot = n + 1;
    }
    let c: Value = serde_json::from_str(include_str!(
        "../../../contracts/protocol-v2.constants.json"
    ))
    .unwrap();
    let methods: Vec<_> = c["methods"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, s)| {
            s["providers"]
                .as_array()
                .unwrap()
                .contains(&json!(provider))
        })
        .map(|(m, _)| m.clone())
        .collect();
    let mut held: Option<Value> = None;
    for line in io::stdin().lock().lines() {
        let r: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let method = r["method"].as_str().unwrap();
        if method == "system.handshake" && scenario == "slow-handshake" {
            thread::sleep(Duration::from_millis(120));
        }
        if scenario == "crash-ready" && method == "search.songs" {
            if let Some(m) = &marker {
                fs::write(m.with_extension("exit"), b"synthetic-exit").unwrap();
            }
            thread::sleep(Duration::from_millis(5));
            std::process::exit(7);
        }
        let mut result = match method {
            "system.handshake" => {
                json!({"protocolVersion":2,"provider":{"id":provider,"name":c["providerNames"][provider],"version":"test-3a"},"maxLineBytes":1048576,"capabilities":c["capabilities"][provider],"implementedMethods":methods})
            }
            "system.ping" => json!({"alive":true}),
            "auth.qr.start" => {
                json!({"sessionId":"synthetic-session","mimeType":"image/png","imageBase64":"AA==","expiresAtMs":100000,"pollAfterMs":1000})
            }
            "auth.qr.poll" => {
                json!({"sessionId":r["params"]["sessionId"],"state":"authenticated","account":{"id":"123","displayName":"Synthetic"},"credential":{"version":1,"providerId":provider,"payload":"SYNTHETIC_TEST_ONLY"}})
            }
            "auth.credential.restore" => json!({"account":{"id":"123","displayName":"Synthetic"}}),
            "auth.credential.check" => {
                json!({"valid":true,"account":{"id":"123","displayName":"Synthetic"}})
            }
            "auth.qr.cancel" => json!({"sessionId":r["params"]["sessionId"],"state":"cancelled"}),
            "auth.logout" => json!({"upstreamRevoked":false}),
            _ => {
                emit(
                    json!({"v":2,"id":r["id"],"ok":false,"error":{"code":"unsupported_capability","retryable":false}}),
                );
                continue;
            }
        };
        if ["auth.qr.poll", "auth.credential.restore"].contains(&method) {
            let id = match scenario {
                "account44" => Some("汉".repeat(44)),
                "account128" => Some("汉".repeat(128)),
                "account129-once" if boot == 1 => Some("汉".repeat(129)),
                _ => None,
            };
            if let Some(id) = id {
                result["account"]["id"] = json!(id);
            }
        }
        if method == "system.handshake" {
            match scenario {
                "wrong-name" => result["provider"]["name"] = json!("bilibili-provider"),
                "wrong-version" => result["provider"]["version"] = json!("other"),
                "wrong-capability" => result["capabilities"]["lyrics"] = json!(false),
                "missing-method" => {
                    result["implementedMethods"] = json!(["system.handshake", "system.ping"])
                }
                _ => {}
            }
        } else {
            if scenario.starts_with("cooldown-") && method == "auth.credential.restore" {
                let after = match scenario {
                    "cooldown-zero" => json!(0),
                    "cooldown-max" => json!(86400000),
                    "cooldown-over" => json!(86400001),
                    "cooldown-negative" => json!(-1),
                    "cooldown-huge" => json!(u64::MAX),
                    _ => json!(1e300),
                };
                emit(
                    json!({"v":2,"id":r["id"],"ok":false,"error":{"code":"rate_limited","retryable":false,"retryAfterMs":after}}),
                );
                continue;
            }
            if scenario == "crash" {
                std::process::exit(7);
            }
            if [
                "network_unavailable",
                "rate_limited",
                "verification_required",
                "credential_invalid",
            ]
            .contains(&scenario)
                && method == "auth.credential.restore"
            {
                emit(
                    json!({"v":2,"id":r["id"],"ok":false,"error":{"code":scenario,"retryable":false,"retryAfterMs":120}}),
                );
                continue;
            }
            if scenario == "delay" {
                thread::sleep(Duration::from_millis(120));
            }
            if scenario == "invalid-utf8" {
                io::stdout().write_all(&[0xff, b'\n']).unwrap();
                io::stdout().flush().unwrap();
                continue;
            }
            if scenario == "wrong-result" {
                result = json!({"alive":true,"secret":"SYNTHETIC_TEST_ONLY"});
            }
            if scenario == "wrong-session" && method == "auth.qr.poll" {
                result["sessionId"] = json!("other");
            }
        }
        let mut frame = json!({"v":2,"id":r["id"],"ok":true,"result":result,"warnings":[]});
        if scenario == "v1" {
            frame["v"] = json!(1);
        }
        if scenario == "unknown" && method != "system.handshake" {
            frame["id"] = json!("unknown");
        }
        if scenario == "out-of-order" && method != "system.handshake" {
            if let Some(v) = held.take() {
                emit(frame);
                emit(v);
            } else {
                held = Some(frame);
            }
            continue;
        }
        if method != "system.handshake"
            && [
                "exact-lf",
                "exact-crlf",
                "oversize",
                "bad-escape",
                "float-version",
            ]
            .contains(&scenario)
        {
            let mut text = frame.to_string();
            match scenario {
                "bad-escape" => text = "{\"v\":2,\"id\":\"x\\q\"}".into(),
                "float-version" => text = text.replace("\"v\":2", "\"v\":2.0"),
                _ => text.push_str(
                    &" ".repeat(1048576 - text.len() + usize::from(scenario == "oversize")),
                ),
            }
            let mut out = io::stdout().lock();
            out.write_all(text.as_bytes()).unwrap();
            out.write_all(if scenario == "exact-crlf" {
                b"\r\n"
            } else {
                b"\n"
            })
            .unwrap();
            out.flush().unwrap();
            continue;
        }
        emit(frame.clone());
        if method == "system.handshake" && scenario == "no-read" {
            thread::sleep(Duration::from_secs(10));
        }
        if scenario == "duplicate" && method != "system.handshake" {
            emit(frame);
        }
    }
}
