use base64::{engine::general_purpose::STANDARD, Engine};
use msedge_tts::tts::{client::connect, SpeechConfig};
use serde_json::{json, Value};

fn edge_voice(id: &str) -> &'static str {
    match id {
        "nova" => "zh-CN-XiaoxiaoNeural",
        "shimmer" => "zh-CN-XiaoyiNeural",
        "onyx" => "zh-CN-YunjianNeural",
        "echo" => "zh-CN-YunxiNeural",
        "alloy" => "zh-CN-YunxiaNeural",
        "fable" => "zh-CN-YunyangNeural",
        "ava" | "auto" => "en-US-AvaMultilingualNeural",
        "emma" => "en-US-EmmaMultilingualNeural",
        "andrew" => "en-US-AndrewMultilingualNeural",
        "brian" => "en-US-BrianMultilingualNeural",
        "seraphina" => "de-DE-SeraphinaMultilingualNeural",
        "vivienne" => "fr-FR-VivienneMultilingualNeural",
        "florian" => "de-DE-FlorianMultilingualNeural",
        "remy" => "fr-FR-RemyMultilingualNeural",
        _ => "zh-CN-XiaoxiaoNeural",
    }
}

#[tauri::command(rename = "ai:ttsVoices")]
pub fn tts_voices() -> Value {
    json!([
        {"id":"nova","label":"温柔女声 · Nova"},
        {"id":"shimmer","label":"清亮女声 · Shimmer"},
        {"id":"onyx","label":"磁性男声 · Onyx"},
        {"id":"echo","label":"沉稳男声 · Echo"},
        {"id":"alloy","label":"清朗少年 · Alloy"},
        {"id":"fable","label":"播报男声 · Fable"},
        {"id":"ava","label":"全球女声 · Ava"},
        {"id":"emma","label":"全球女声 · Emma"},
        {"id":"andrew","label":"全球男声 · Andrew"},
        {"id":"brian","label":"全球男声 · Brian"},
        {"id":"seraphina","label":"全球女声 · Seraphina"},
        {"id":"vivienne","label":"全球女声 · Vivienne"},
        {"id":"florian","label":"全球男声 · Florian"},
        {"id":"remy","label":"全球男声 · Remy"}
    ])
}

#[tauri::command(rename = "ai:ttsSpeech")]
pub async fn tts_speech(text: String, opts: Option<Value>) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("empty text".into());
    }
    let voice_id = opts
        .as_ref()
        .and_then(|o| o.get("voiceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();
    let speed = opts
        .as_ref()
        .and_then(|o| o.get("speed"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let rate = (((speed - 1.0) * 100.0).round() as i32).clamp(-50, 100);
    let voice_name = edge_voice(&voice_id).to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let config = SpeechConfig {
            voice_name,
            audio_format: "audio-24khz-48kbitrate-mono-mp3".into(),
            pitch: 0,
            rate,
            volume: 0,
        };
        let mut client = connect().map_err(|e| format!("Edge TTS 连接失败：{e}"))?;
        let audio = client
            .synthesize(&text, &config)
            .map_err(|e| format!("Edge TTS 合成失败：{e}"))?;
        if audio.audio_bytes.is_empty() {
            return Err("Edge TTS 返回空音频".into());
        }
        Ok(json!({
            "b64": STANDARD.encode(audio.audio_bytes),
            "mime": "audio/mpeg"
        }))
    })
    .await
    .map_err(|e| format!("Edge TTS 任务失败：{e}"))?
}
