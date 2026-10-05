//! 首页信息模块：填补 home:news / home:playLog 空壳（此前前端只有 STUB 兜底）。
//! - home:news：拉取 Mojang 官方启动器新闻，24h 本地缓存；失败返回 errors 供前端展示。
//! - home:playLog：返回 config["playLog"]（游玩统计）。

use crate::error::CmdResult;
use crate::net::HTTP;
use serde_json::{json, Value};
use std::time::Duration;

const NEWS_URL: &str = "https://launchercontent.mojang.com/v2/news.json";
const CACHE_TTL_MS: i64 = 24 * 3600 * 1000;
/// 缓存结构版本：字段调整（如 url 取 readMoreLink）时 +1，旧缓存自动失效重拉
const CACHE_VER: i64 = 2;

fn cache_path() -> std::path::PathBuf {
    crate::config::user_data_dir().join("home_news_cache.json")
}

fn read_cache() -> Option<(i64, Vec<Value>)> {
    let t = std::fs::read_to_string(cache_path()).ok()?;
    let v: Value = serde_json::from_str(&t).ok()?;
    if v.get("v").and_then(Value::as_i64) != Some(CACHE_VER) {
        return None;
    }
    let ts = v.get("t").and_then(Value::as_i64)?;
    let items = v.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    Some((ts, items))
}

fn write_cache(items: &[Value]) {
    let v = json!({ "v": CACHE_VER, "t": chrono::Utc::now().timestamp_millis(), "items": items });
    if let Ok(s) = serde_json::to_string(&v) {
        let _ = std::fs::write(cache_path(), s);
    }
}

/// channel: home:news —— 首页新闻（force=true 强制刷新；失败带 errors 不抛错，前端有重试）
#[tauri::command(rename = "home:news")]
pub async fn home_news(force: Option<bool>) -> CmdResult<Value> {
    let force = force.unwrap_or(false);
    if !force {
        if let Some((ts, items)) = read_cache() {
            let now = chrono::Utc::now().timestamp_millis();
            if now - ts < CACHE_TTL_MS && !items.is_empty() {
                return Ok(json!({ "items": items, "errors": [] }));
            }
        }
    }

    let fut = HTTP.get(NEWS_URL).send();
    let res = match tokio::time::timeout(Duration::from_secs(12), fut).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Ok(json!({ "items": [], "errors": [format!("网络错误：{e}")] })),
        Err(_) => return Ok(json!({ "items": [], "errors": ["获取新闻超时，请检查网络"] })),
    };
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(json!({}));
    if status < 200 || status >= 300 {
        return Ok(json!({ "items": [], "errors": [format!("新闻源 HTTP {status}")] }));
    }

    let items: Vec<Value> = data
        .get("entries")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let title = e.get("title").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    if title.is_empty() {
                        return None;
                    }
                    let tag_raw = e.get("tag").and_then(Value::as_str).unwrap_or("").to_string();
                    let tag = match tag_raw.as_str() {
                        "Article" => "文章",
                        "News" => "新闻",
                        "Changelog" => "更新",
                        other => other,
                    };
                    let date = e.get("date").and_then(Value::as_str).unwrap_or("").to_string();
                    // ISO 时间截到日期，前端直接显示
                    let date_short = date.chars().take(10).collect::<String>();
                    let text = e.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                    // Mojang 字段：链接在 readMoreLink；图片在 playPageImage/newsPageImage.url（相对路径）
                    let url = e
                        .get("readMoreLink")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let mut image = e
                        .get("playPageImage")
                        .and_then(|v| v.get("url"))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            e.get("newsPageImage")
                                .and_then(|v| v.get("url"))
                                .and_then(Value::as_str)
                        })
                        .unwrap_or("")
                        .to_string();
                    if !image.is_empty() && !image.starts_with("http") {
                        image = format!("https://launchercontent.mojang.com{image}");
                    }
                    Some(json!({
                        "title": title,
                        "tag": tag,
                        "date": date_short,
                        "text": text,
                        "url": url,
                        "image": image,
                    }))
                })
                .take(20)
                .collect()
        })
        .unwrap_or_default();

    if items.is_empty() {
        return Ok(json!({ "items": [], "errors": ["新闻源没有返回内容"] }));
    }
    write_cache(&items);
    Ok(json!({ "items": items, "errors": [] }))
}

/// channel: home:playLog —— 游玩记录统计（config["playLog"]）
#[tauri::command(rename = "home:playLog")]
pub fn home_play_log() -> Value {
    crate::config::get("playLog")
}
