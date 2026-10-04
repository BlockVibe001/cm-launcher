//! 规则匹配：与 Electron 版 minecraft/rules.js 对齐。
//! Windows-only，os.name 恒为 windows、arch 取编译目标。

use serde_json::Value;

const OS_NAME: &str = "windows";
const ARCH: &str = if cfg!(target_arch = "x86_64") {
    "x64"
} else if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    "x86"
};

fn os_matches(os_rule: &Value) -> bool {
    if let Some(name) = os_rule.get("name").and_then(Value::as_str) {
        if name != OS_NAME {
            return false;
        }
    }
    if let Some(arch) = os_rule.get("arch").and_then(Value::as_str) {
        if arch != ARCH {
            return false;
        }
    }
    // os.version 正则：对 Windows 内核版本号匹配；非法正则忽略（对齐 JS try/catch）
    if let Some(pattern) = os_rule.get("version").and_then(Value::as_str) {
        let release = windows_release();
        match regex::Regex::new(pattern) {
            Ok(re) => {
                if !re.is_match(&release) {
                    return false;
                }
            }
            Err(_) => {}
        }
    }
    true
}

fn windows_release() -> String {
    // 与 os.release() 近似：Win10/11 均为 10.0 开头
    "10.0".to_string()
}

/// 库规则（无 features）
pub fn matches_rules_value(rules: &Value) -> bool {
    matches_rules_features(rules, None)
}

pub fn matches_rules_features(rules: &Value, features: Option<&Value>) -> bool {
    let arr = match rules.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return true,
    };
    let mut allowed = false;
    for rule in arr {
        let mut applies = true;
        if let Some(os_rule) = rule.get("os") {
            applies = os_matches(os_rule);
        }
        if applies {
            if let Some(rule_features) = rule.get("features").and_then(Value::as_object) {
                if let Some(feat) = features {
                    for (key, expected) in rule_features {
                        let actual = feat.get(key).and_then(Value::as_bool).unwrap_or(false);
                        if actual != expected.as_bool().unwrap_or(false) {
                            applies = false;
                            break;
                        }
                    }
                } else {
                    applies = false;
                }
            }
        }
        if applies {
            allowed = rule.get("action").and_then(Value::as_str) == Some("allow");
        }
    }
    allowed
}
