//! Strict v2 payload boundary. Shares only bounded bytes/JSON syntax with v1.
use super::OnlineProviderId;
use crate::provider::{parse_json_value, MAX_LINE_BYTES};
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashMap, io::BufRead, sync::OnceLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Upstream(super::ErrorCode),
    Frame,
    Schema,
    Context,
    Handshake,
    Unavailable,
    Timeout,
    Cancelled,
    Stale,
    Storage,
    Cooldown,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "provider_v2_{self:?}")
    }
}
impl std::error::Error for Error {}
pub fn constants() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/protocol-v2.constants.json"
        ))
        .unwrap()
    })
}
fn schema() -> &'static Value {
    static V: OnceLock<Value> = OnceLock::new();
    V.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/protocol-v2.schema.json")).unwrap()
    })
}
pub fn name(provider: OnlineProviderId) -> &'static str {
    match provider {
        OnlineProviderId::Netease => "netease",
        OnlineProviderId::Bilibili => "bilibili",
        OnlineProviderId::Qqmusic => "qqmusic",
    }
}
// This interpreter intentionally implements exactly the vocabulary in the frozen
// local schema. Unknown keywords fail closed; no remote refs or schema fetching.
fn matches(s: &Value, v: &Value) -> bool {
    let Some(o) = s.as_object() else { return false };
    if o.keys().any(|k| {
        ![
            "$ref",
            "type",
            "const",
            "enum",
            "properties",
            "required",
            "additionalProperties",
            "minLength",
            "maxLength",
            "pattern",
            "minimum",
            "maximum",
            "items",
            "minItems",
            "maxItems",
            "uniqueItems",
            "oneOf",
            "anyOf",
            "allOf",
            "not",
            "if",
            "then",
            "else",
        ]
        .contains(&k.as_str())
    }) {
        return false;
    }
    if let Some(r) = s["$ref"].as_str() {
        return r
            .strip_prefix("#/$defs/")
            .is_some_and(|k| matches(&schema()["$defs"][k], v));
    }
    if let Some(t) = s["type"].as_str() {
        if !match t {
            "object" => v.is_object(),
            "array" => v.is_array(),
            "string" => v.is_string(),
            "integer" => v.as_i64().is_some() || v.as_u64().is_some(),
            "boolean" => v.is_boolean(),
            "null" => v.is_null(),
            _ => false,
        } {
            return false;
        }
    }
    if o.contains_key("const") && s["const"] != *v {
        return false;
    }
    if let Some(xs) = s["enum"].as_array() {
        if !xs.contains(v) {
            return false;
        }
    }
    for (key, minimum, maximum) in [
        ("oneOf", 1, 1),
        ("anyOf", 1, usize::MAX),
        ("allOf", usize::MAX, usize::MAX),
    ] {
        if let Some(xs) = s[key].as_array() {
            let n = xs.iter().filter(|x| matches(x, v)).count();
            if (key == "allOf" && n != xs.len()) || (key != "allOf" && (n < minimum || n > maximum))
            {
                return false;
            }
        }
    }
    if o.contains_key("not") && matches(&s["not"], v) {
        return false;
    }
    if o.contains_key("if") {
        let k = if matches(&s["if"], v) { "then" } else { "else" };
        if o.contains_key(k) && !matches(&s[k], v) {
            return false;
        }
    }
    if let Some(obj) = v.as_object() {
        if s["required"]
            .as_array()
            .is_some_and(|ks| ks.iter().any(|k| !obj.contains_key(k.as_str().unwrap())))
        {
            return false;
        }
        for (k, x) in obj {
            if let Some(p) = s["properties"].get(k) {
                if !matches(p, x) {
                    return false;
                }
            } else if s["additionalProperties"] == false {
                return false;
            }
        }
    }
    if let Some(xs) = v.as_array() {
        if s["minItems"]
            .as_u64()
            .is_some_and(|n| xs.len() < n as usize)
            || s["maxItems"]
                .as_u64()
                .is_some_and(|n| xs.len() > n as usize)
        {
            return false;
        }
        if o.contains_key("items") && xs.iter().any(|x| !matches(&s["items"], x)) {
            return false;
        }
        if s["uniqueItems"] == true && xs.iter().enumerate().any(|(i, x)| xs[..i].contains(x)) {
            return false;
        }
    }
    if let Some(text) = v.as_str() {
        let n = text.chars().count() as u64;
        if s["minLength"].as_u64().is_some_and(|x| n < x)
            || s["maxLength"].as_u64().is_some_and(|x| n > x)
        {
            return false;
        }
        if let Some(p) = s["pattern"].as_str() {
            static PATTERNS: OnceLock<HashMap<String, Regex>> = OnceLock::new();
            let ps = PATTERNS.get_or_init(|| {
                fn collect(v: &Value, ps: &mut HashMap<String, Regex>) {
                    match v {
                        Value::Object(o) => {
                            if let Some(p) = o.get("pattern").and_then(Value::as_str) {
                                ps.insert(
                                    p.into(),
                                    Regex::new(&p.replace("(?![\\s\\S])", "\\z")).unwrap(),
                                );
                            }
                            for x in o.values() {
                                collect(x, ps);
                            }
                        }
                        Value::Array(xs) => {
                            for x in xs {
                                collect(x, ps);
                            }
                        }
                        _ => {}
                    }
                }
                let mut ps = HashMap::new();
                collect(schema(), &mut ps);
                ps
            });
            if !ps.get(p).is_some_and(|r| r.is_match(text)) {
                return false;
            }
        }
    }
    if let Some(n) = v.as_f64() {
        if !n.is_finite()
            || s["minimum"].as_f64().is_some_and(|x| n < x)
            || s["maximum"].as_f64().is_some_and(|x| n > x)
        {
            return false;
        }
    }
    true
}
pub fn validate(def: &str, value: &Value) -> Result<(), Error> {
    if matches(&schema()["$defs"][def], value) {
        Ok(())
    } else {
        Err(Error::Schema)
    }
}
pub fn parse(bytes: &[u8]) -> Result<Value, Error> {
    if bytes.is_empty() || bytes.len() > MAX_LINE_BYTES {
        return Err(Error::Frame);
    }
    let v = parse_json_value(bytes).map_err(|_| Error::Frame)?;
    if v.get("v").and_then(Value::as_u64) != Some(2) {
        return Err(Error::Frame);
    }
    Ok(v)
}
pub fn read<R: BufRead>(r: &mut R) -> Result<Option<Value>, Error> {
    let mut bytes = Vec::new();
    let n = std::io::Read::take(r, (MAX_LINE_BYTES + 3) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| Error::Frame)?;
    if n == 0 {
        return Ok(None);
    }
    if bytes.pop() != Some(b'\n') {
        return Err(Error::Frame);
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    parse(&bytes).map(Some)
}
pub fn encode(v: &Value) -> Result<Vec<u8>, Error> {
    let mut b = serde_json::to_vec(v).map_err(|_| Error::Frame)?;
    parse(&b)?;
    b.push(b'\n');
    Ok(b)
}
pub fn encode_request(
    provider: OnlineProviderId,
    id: &str,
    method: &str,
    params: Value,
) -> Result<Vec<u8>, Error> {
    encode(&request(provider, id, method, params)?)
}
pub fn decode_request(provider: OnlineProviderId, bytes: &[u8]) -> Result<Value, Error> {
    let v = parse(bytes)?;
    request(
        provider,
        v["id"].as_str().ok_or(Error::Schema)?,
        v["method"].as_str().ok_or(Error::Schema)?,
        v["params"].clone(),
    )?;
    validate("request", &v)?;
    Ok(v)
}
pub fn encode_response(
    provider: OnlineProviderId,
    method: &str,
    params: &Value,
    v: &Value,
) -> Result<Vec<u8>, Error> {
    response(provider, method, params, v)?;
    encode(v)
}
pub fn decode_response(
    provider: OnlineProviderId,
    method: &str,
    params: &Value,
    bytes: &[u8],
) -> Result<Value, Error> {
    let v = parse(bytes)?;
    response(provider, method, params, &v)?;
    Ok(v)
}
pub fn encode_event(v: &Value) -> Result<Vec<u8>, Error> {
    event(v)?;
    encode(v)
}
pub fn decode_event(bytes: &[u8]) -> Result<Value, Error> {
    let v = parse(bytes)?;
    event(&v)?;
    Ok(v)
}
pub fn request(
    provider: OnlineProviderId,
    id: &str,
    method: &str,
    params: Value,
) -> Result<Value, Error> {
    if method=="library.verify" {
        let m=params["method"].as_str().ok_or(Error::Schema)?;
        if !["library.setLiked","library.setSubscribed","library.addItems","library.removeItems"].contains(&m)
            || !constants()["methods"][m]["providers"].as_array().is_some_and(|ps|ps.contains(&json!(name(provider)))) { return Err(Error::Context); }
    }
    let spec = &constants()["methods"][method];
    if !spec["providers"]
        .as_array()
        .is_some_and(|ps| ps.contains(&json!(name(provider))))
    {
        return Err(Error::Context);
    }
    let frame = json!({"v":2,"id":id,"method":method,"params":params});
    validate("request", &frame)?;
    validate(
        spec["params"].as_str().ok_or(Error::Schema)?,
        &frame["params"],
    )?;
    context(provider, &frame["params"])?;
    Ok(frame)
}
pub fn response(
    provider: OnlineProviderId,
    method: &str,
    params: &Value,
    v: &Value,
) -> Result<(), Error> {
    validate(
        if v["ok"] == true {
            "success"
        } else {
            "failure"
        },
        v,
    )?;
    if v["ok"] == true {
        validate(
            constants()["methods"][method]["result"]
                .as_str()
                .ok_or(Error::Schema)?,
            &v["result"],
        )?;
        context(provider, &v["result"])?;
        for k in ["sessionId", "songId", "bvid", "track", "page"] {
            if let Some(expected) = params.get(k) {
                if let Some(actual) = v["result"].get(k) {
                    if actual != expected {
                        return Err(Error::Context);
                    }
                }
            }
        }
        if let Some(size) = params["pageSize"].as_u64() {
            if v["result"]["items"]
                .as_array()
                .is_some_and(|a| a.len() > size as usize)
            {
                return Err(Error::Context);
            }
        }
        if method == "song.detail" && v["result"]["ref"]["songId"] != params["songId"] {
            return Err(Error::Context);
        }
        if method == "video.parts"
            && v["result"]["items"]
                .as_array()
                .is_some_and(|items| items.iter().any(|x| x["ref"]["bvid"] != params["bvid"]))
        {
            return Err(Error::Context);
        }
    }
    Ok(())
}
pub fn event(v: &Value) -> Result<(), Error> {
    validate("event", v)
}
pub fn handshake(
    provider: OnlineProviderId,
    expected_version: &str,
    methods: &[String],
    capabilities: &super::ProviderCapabilities,
    result: &Value,
) -> Result<(), Error> {
    validate("handshake", result)?;
    if result["provider"]["id"] != name(provider)
        || result["provider"]["name"] != constants()["providerNames"][name(provider)]
        || result["provider"]["version"] != expected_version
        || result["capabilities"]
            != serde_json::to_value(capabilities).map_err(|_| Error::Handshake)?
    {
        return Err(Error::Handshake);
    }
    let xs = result["implementedMethods"]
        .as_array()
        .ok_or(Error::Handshake)?;
    if methods.iter().any(|m| !xs.contains(&json!(m)))
        || xs.iter().any(|m| {
            !constants()["methods"][m.as_str().unwrap()]["providers"]
                .as_array()
                .is_some_and(|ps| ps.contains(&json!(name(provider))))
        })
    {
        return Err(Error::Handshake);
    }
    Ok(())
}
fn context(provider: OnlineProviderId, v: &Value) -> Result<(), Error> {
    match v {
        Value::Object(o) => {
            if let Some(q) = o.get("preferredQuality") {
                if !constants()["capabilities"][name(provider)]["qualities"]
                    .as_array()
                    .is_some_and(|xs| xs.contains(q))
                {
                    return Err(Error::Context);
                }
            }
            if let Some(p) = o.get("providerId") {
                if p != name(provider) {
                    return Err(Error::Context);
                }
            }
            if let Some(k) = o.get("kind").and_then(Value::as_str) {
                if (k == "song" && provider != OnlineProviderId::Netease)
                    || (["video", "videoPart"].contains(&k)
                        && provider != OnlineProviderId::Bilibili)
                {
                    return Err(Error::Context);
                }
            }
            if o.contains_key("payload")
                && o.contains_key("version")
                && serde_json::to_vec(v).map_err(|_| Error::Schema)?.len() > 65536
            {
                return Err(Error::Schema);
            }
            for x in o.values() {
                context(provider, x)?;
            }
        }
        Value::Array(xs) => {
            for x in xs {
                context(provider, x)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};
    #[test]
    fn frozen_exchanges_use_method_specific_response_validation() {
        let xs: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/provider-v2/exchanges.json"
        ))
        .unwrap();
        for x in xs.as_array().unwrap() {
            let id = if x["providerId"] == "netease" {
                OnlineProviderId::Netease
            } else {
                OnlineProviderId::Bilibili
            };
            let r = &x["request"];
            let method = r["method"].as_str().unwrap();
            assert!(
                request(id, r["id"].as_str().unwrap(), method, r["params"].clone()).is_ok(),
                "{}",
                x["name"]
            );
            assert!(
                response(id, method, &r["params"], &x["response"]).is_ok(),
                "{}",
                x["name"]
            );
            let mut bad = x["response"].clone();
            if bad["result"].is_array() {bad["result"].as_array_mut().unwrap().push(json!({"extra":"SYNTHETIC_TEST_ONLY"}));}
            else {bad["result"]["extra"] = json!("SYNTHETIC_TEST_ONLY");}
            assert!(response(id, method, &r["params"], &bad).is_err());
        }
    }
    #[test]
    fn strict_lexical_frames_and_exact_limits() {
        for p in [
            b"{\"v\":2.0}".as_slice(),
            b"{\"v\":2e0}",
            b"{\"v\":2,\"v\":2}",
            b"{\"v\":2,\"x\":\"\\q\"}",
            b"\xef\xbb\xbf{\"v\":2}",
            b"{\"v\":2,\"x\":NaN}",
            b"\xff",
            b"",
        ] {
            assert!(parse(p).is_err(), "{p:?}");
        }
        let prefix = b"{\"v\":2,\"x\":\"";
        let suffix = b"\"}";
        let mut exact = prefix.to_vec();
        exact.extend(vec![b'a'; MAX_LINE_BYTES - prefix.len() - suffix.len()]);
        exact.extend(suffix);
        assert!(parse(&exact).is_ok());
        for ending in [b"\n".as_slice(), b"\r\n"] {
            let mut b = exact.clone();
            b.extend(ending);
            let mut r = BufReader::with_capacity(7, Cursor::new(b));
            assert!(read(&mut r).unwrap().is_some());
            assert!(read(&mut r).unwrap().is_none());
        }
        exact.insert(12, b'a');
        assert!(parse(&exact).is_err());
        let deep = format!("{{\"v\":2,\"x\":{}{}}}", "[".repeat(128), "]".repeat(128));
        assert!(parse(deep.as_bytes()).is_err());
        let unicode="{\"v\":2,\"id\":\"utf8\",\"ok\":true,\"result\":{\"title\":\"测试🎵\"},\"warnings\":[]}";
        assert!(read(&mut BufReader::with_capacity(
            1,
            Cursor::new(format!("{unicode}\n").into_bytes())
        ))
        .unwrap()
        .is_some());
    }
    #[test]
    fn method_schema_context_errors_events_and_secret_bounds() {
        assert!(request(OnlineProviderId::Bilibili,"quality","playback.resolve",json!({"track":{"kind":"videoPart","bvid":"BV1fK4y1t7hj","cid":"123"},"preferredQuality":"flac"})).is_err());
        assert!(request(
            OnlineProviderId::Netease,
            "valid",
            "system.ping",
            json!({"unexpected":1})
        )
        .is_err());
        for id in ["x\n", "x\r", "x\u{2028}", "_bad", ""] {
            assert!(request(OnlineProviderId::Netease, id, "system.ping", json!({})).is_err());
        }
        assert!(request(OnlineProviderId::Netease,"ok","auth.credential.restore",json!({"credential":{"version":1,"providerId":"bilibili","payload":"SYNTHETIC_TEST_ONLY"}})).is_err());
        let fail = json!({"v":2,"id":"ok","ok":false,"error":{"code":"verification_required","retryable":false}});
        assert!(response(OnlineProviderId::Netease, "system.ping", &json!({}), &fail).is_ok());
        assert!(event(&json!({"v":2,"event":"auth.qr.progress","payload":{"sessionId":"test","state":"authenticated","credential":"SYNTHETIC_TEST_ONLY"}})).is_err());
        assert!(event(&json!({"v":2,"event":"auth.qr.progress","payload":{"sessionId":"test","state":"waitingScan"}})).is_ok());
        let r = json!({"v":2,"id":"ok","ok":true,"result":{"page":2,"hasMore":false,"total":0,"items":[]},"warnings":[]});
        assert!(response(
            OnlineProviderId::Netease,
            "search.songs",
            &json!({"page":1,"pageSize":20}),
            &r
        )
        .is_err());
    }
    #[test]
    fn failure_retry_after_bounds_are_enforced_before_registry_duration() {
        for after in [json!(0), json!(86400000)] {
            let v = json!({"v":2,"id":"bounded","ok":false,"error":{"code":"rate_limited","retryable":false,"retryAfterMs":after}});
            assert!(response(
                OnlineProviderId::Netease,
                "auth.credential.restore",
                &json!({}),
                &v
            )
            .is_ok());
        }
        for after in [
            json!(-1),
            json!(86400001),
            json!(u64::MAX),
            json!(1e300),
            json!(1.5),
        ] {
            let v = json!({"v":2,"id":"bounded","ok":false,"error":{"code":"rate_limited","retryable":false,"retryAfterMs":after}});
            assert_eq!(
                response(
                    OnlineProviderId::Netease,
                    "auth.credential.restore",
                    &json!({}),
                    &v
                ),
                Err(Error::Schema)
            );
        }
    }
}
