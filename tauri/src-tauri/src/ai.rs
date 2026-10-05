//! AI 对话 / 翻译（对齐 Electron 版 src/main/minecraft/translate.js）。
//! 注意：本文件中标了「跨模块契约」的 pub 函数（providers / chat_completions / translate_batch）
//! 是 lab:translateJar 复用的接口，签名冻结，不得改名或改参。
//!
//! 本文件由 OrganizeAgent 以 todo!() 骨架交付：把 todo!() 替换为真实实现即可，
//! 不得修改 #[tauri::command(rename = "...")] 通道名与函数签名。

use crate::error::{AppError, CmdResult};
use serde_json::{json, Value};
use std::time::Duration;

/// 常见服务商预设，方便一键填表（channel: ai:providers 直接返回）
pub fn providers() -> Value {
    json!([
        { "id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" },
        { "id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" },
        { "id": "dashscope", "name": "通义千问", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus" },
        { "id": "zhipu", "name": "智谱 GLM", "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4-flash" },
        { "id": "moonshot", "name": "月之暗面", "baseUrl": "https://api.moonshot.cn/v1", "model": "moonshot-v1-8k" },
        { "id": "siliconflow", "name": "硅基流动", "baseUrl": "https://api.siliconflow.cn/v1", "model": "Qwen/Qwen2.5-7B-Instruct" },
        { "id": "ollama", "name": "Ollama（本地）", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b" },
    ])
}

/// 【跨模块契约】调用 OpenAI 兼容 chat/completions，返回助手回复文本。
/// 对应 Electron translate.js 的 callAI(cfg, messages)。
pub async fn chat_completions(cfg: &Value, messages: &Value) -> CmdResult<String> {
    let base = cfg
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    let api_key = cfg.get("apiKey").and_then(Value::as_str).unwrap_or("");
    let model = cfg.get("model").and_then(Value::as_str).unwrap_or("gpt-4o-mini");
    let body = json!({"model": model, "messages": messages, "temperature": 0.2});
    let res = crate::net::HTTP
        .post(format!("{base}/chat/completions"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !status.is_success() {
        let cut: String = text.chars().take(200).collect();
        return Err(AppError::Msg(format!("AI 接口返回 {status}：{cut}")));
    }
    let data: Value = serde_json::from_str(&text)?;
    let content = data
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    if content.is_empty() {
        return Err(AppError::Msg("AI 未返回内容".into()));
    }
    Ok(content.to_string())
}

/// 宽松解析模型返回的 JSON：剥 ```json 围栏，取首个 { 到末个 }（对齐 parseJsonLoose）
fn parse_json_loose(text: &str) -> CmdResult<Value> {
    let mut t = text.trim().to_string();
    if let Some(rest) = t.strip_prefix("```") {
        t = rest.trim_start().to_string();
        if let Some(rest) = t.strip_prefix("json") {
            t = rest.trim_start().to_string();
        }
    }
    if let Some(stripped) = t.strip_suffix("```") {
        t = stripped.trim_end().to_string();
    }
    let i = t.find('{');
    let j = t.rfind('}');
    if let (Some(i), Some(j)) = (i, j) {
        if j > i {
            t = t[i..=j].to_string();
        }
    }
    Ok(serde_json::from_str(&t)?)
}

/// 【跨模块契约】批量翻译一组 key:value（Electron translateBatch）。
/// 失败时按 Electron 语义返回原样值映射（调用方兜底），不抛错。
pub async fn translate_batch(cfg: &Value, entries: &[(String, String)], target_lang: &str) -> CmdResult<Value> {
    let mut payload = serde_json::Map::new();
    for (k, v) in entries {
        payload.insert(k.clone(), json!(v));
    }
    let payload = Value::Object(payload);
    let sys = "你是 Minecraft 模组本地化专家。把给定的 JSON 中每个 value 翻译成简体中文，保持 %s、%d、%1$s 等格式占位符原样不变，保持 key 不变，只输出 JSON，不要解释。";
    let messages = json!([
        {"role": "system", "content": sys},
        {"role": "user", "content": format!("目标语言：{target_lang}\n{}", serde_json::to_string(&payload)?)},
    ]);
    let out = chat_completions(cfg, &messages).await?;
    // 解析失败回退原样映射（不抛错，调用方兜底）
    match parse_json_loose(&out) {
        Ok(v) => Ok(v),
        Err(_) => Ok(payload),
    }
}

/// channel: ai:providers —— 返回服务商预设数组
#[tauri::command(rename = "ai:providers")]
pub fn ai_providers() -> Value {
    providers()
}

/// channel: ai:test —— 测试 AI 接口连通性
/// 入参 cfg: Value（可为 null，对应前端传 undefined）
/// 返回 { ok: bool, endpoint: String, models: [String], reply?: String }（对齐 Electron testConnection）
#[tauri::command(rename = "ai:test")]
pub async fn ai_test(cfg: Value) -> CmdResult<Value> {
    let base_url = cfg.get("baseUrl").and_then(Value::as_str).unwrap_or("");
    if base_url.is_empty() {
        return Err(AppError::Msg("请先填写接口地址".into()));
    }
    let base = base_url.trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(AppError::Msg("接口地址需以 http:// 或 https:// 开头".into()));
    }
    let models_url = format!("{base}/models");

    // 先试 GET /models（12s 超时，带 Bearer）
    let mut req = crate::net::HTTP.get(&models_url);
    if let Some(key) = cfg.get("apiKey").and_then(Value::as_str) {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }
    let models = match tokio::time::timeout(Duration::from_secs(12), req.send()).await {
        Ok(Ok(res)) if res.status().is_success() => {
            match res.json::<Value>().await {
                Ok(data) => data
                    .get("data")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                            .take(40)
                            .collect()
                    })
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        }
        _ => Vec::new(),
    };
    if !models.is_empty() {
        return Ok(json!({"ok": true, "endpoint": models_url, "models": models}));
    }

    // /models 不可用 → 退化为一次最小对话
    let mut cfg2 = cfg.clone();
    if cfg2.get("apiKey").and_then(Value::as_str).map(|s| s.is_empty()).unwrap_or(true) {
        cfg2["apiKey"] = json!("none");
    }
    let reply = chat_completions(&cfg2, &json!([{"role":"user","content":"ping"}])).await?;
    Ok(json!({
        "ok": true,
        "endpoint": format!("{base}/chat/completions"),
        "models": [],
        "reply": reply.chars().take(60).collect::<String>(),
    }))
}

/// channel: ai:translate —— 翻译一段普通文本（自动分段）
/// 入参 cfg: Value（可为 null，前端可能传配置对象）、text: String、targetLang: String
/// 返回 { text: String, chunks: usize }（对齐 Electron translateText）
#[tauri::command(rename = "ai:translate")]
pub async fn ai_translate(cfg: Value, text: String, target_lang: String) -> CmdResult<Value> {
    let src = text.trim().to_string();
    if src.is_empty() {
        return Err(AppError::Msg("请输入要翻译的内容".into()));
    }
    if cfg.get("apiKey").and_then(Value::as_str).map(|s| s.is_empty()).unwrap_or(true) {
        return Err(AppError::Msg("请先填写 AI 的 API Key".into()));
    }
    const MAX: usize = 1800;
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for chunk in chars.chunks(MAX) {
        let c: String = chunk.iter().collect();
        let messages = json!([
            {"role":"system","content": format!("你是专业翻译。把用户输入的文本翻译成{target_lang}，只输出译文，不要解释、不要加引号。")},
            {"role":"user","content": c},
        ]);
        out.push(chat_completions(&cfg, &messages).await?);
    }
    let n = out.len();
    Ok(json!({"text": out.join("\n"), "chunks": n}))
}
