//! speech.rs — 语音识别：有聊天 Key 走 OpenAI 兼容 /audio/transcriptions，
//! 否则用 Windows 自带 System.Speech 离线识别。前端只传 base64 WAV，避免 IPC 大数组。

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::process::Command;

const SAPI: &str = r#"
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Globalization;
using System.Speech.Recognition;
using System.Speech.AudioFormat;
public class SapiWav16 {
  public static string Run(string path) {
    byte[] b = File.ReadAllBytes(path);
    int rate = 0, channels = 1, bits = 16, dataOff = -1, dataLen = 0;
    int p = 12;
    while (p + 8 <= b.Length) {
      string id = Encoding.ASCII.GetString(b, p, 4);
      int sz = BitConverter.ToInt32(b, p + 4);
      if (id == "fmt " && sz >= 16) {
        channels = BitConverter.ToInt16(b, p + 10);
        rate = BitConverter.ToInt32(b, p + 12);
        bits = BitConverter.ToInt16(b, p + 22);
      } else if (id == "data") {
        dataOff = p + 8;
        dataLen = Math.Min(sz, b.Length - dataOff);
        break;
      }
      p += 8 + sz + (sz & 1);
    }
    if (dataOff < 0 || rate <= 0 || channels < 1 || bits != 16) return "";
    int frames = dataLen / (2 * channels);
    if (frames < 1) return "";
    float[] mono = new float[frames];
    for (int i = 0; i < frames; i++) {
      short s = BitConverter.ToInt16(b, dataOff + i * 2 * channels);
      mono[i] = s / 32768f;
    }
    int target = 16000;
    int outLen = Math.Max(1, (int)Math.Round(frames * (double)target / rate));
    short[] pcm = new short[outLen];
    for (int i = 0; i < outLen; i++) {
      double src = i * (double)rate / target;
      int i0 = (int)Math.Floor(src);
      int i1 = Math.Min(frames - 1, i0 + 1);
      double f = src - i0;
      double v = mono[Math.Min(frames - 1, i0)] * (1 - f) + mono[i1] * f;
      if (v > 1) v = 1; if (v < -1) v = -1;
      pcm[i] = (short)Math.Round(v * 32767);
    }
    byte[] bytes = new byte[pcm.Length * 2];
    for (int i = 0; i < pcm.Length; i++) {
      bytes[i * 2] = (byte)(pcm[i] & 0xff);
      bytes[i * 2 + 1] = (byte)((pcm[i] >> 8) & 0xff);
    }
    var ms = new MemoryStream(bytes);
    var rec = new SpeechRecognitionEngine(new CultureInfo("zh-CN"));
    rec.LoadGrammar(new DictationGrammar());
    rec.SetInputToAudioStream(ms, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
    var text = new StringBuilder();
    var done = new ManualResetEvent(false);
    rec.SpeechRecognized += (s, e) => { if (e.Result != null && e.Result.Text != null) text.Append(e.Result.Text).Append(" "); };
    rec.RecognizeCompleted += (s, e) => { done.Set(); };
    rec.RecognizeAsync(RecognizeMode.Multiple);
    done.WaitOne(TimeSpan.FromSeconds(20));
    try { rec.RecognizeAsyncCancel(); } catch { }
    rec.Dispose(); ms.Dispose();
    return text.ToString().Trim();
  }
}
'@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Speech
[Console]::Out.Write([SapiWav16]::Run('__PATH__'))
"#;

fn decode(b64: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(b64).map_err(|e| format!("音频数据无效：{e}"))
}

fn clean_text(s: &str) -> String {
    s.trim()
        .replace("威信", "微信")
        .replace("微星", "微信")
        .replace("当我打开", "帮我打开")
        .replace("扣扣", "QQ")
        .replace("球球", "QQ")
        .replace("谷歌游览器", "谷歌浏览器")
        .replace("任务管理期", "任务管理器")
}

async fn cloud(cfg: &Value, bytes: &[u8], language: &str) -> Result<String, String> {
    let key = cfg.get("apiKey").and_then(Value::as_str).unwrap_or("").trim();
    if key.is_empty() {
        return Err("没有可用的语音识别 Key".into());
    }
    let base = cfg
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/')
        .to_string();
    let url = format!("{base}/audio/transcriptions");
    let part = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", "whisper-1")
        .text("response_format", "json");
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    let res = crate::net::HTTP
        .post(url)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("语音识别请求失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("语音识别 HTTP {}：{}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("语音识别返回无效：{}", text.chars().take(200).collect::<String>()))?;
    let out = v.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    if out.trim().is_empty() {
        return Err("没有识别到文字".into());
    }
    Ok(clean_text(&out))
}

fn sapi(bytes: &[u8]) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!(
        "cm-stt-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
    ));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let ps_path = path.to_string_lossy().replace('\'', "''");
    let script = SAPI.replace("__PATH__", &ps_path);
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let enc = STANDARD.encode(utf16);
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &enc]);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().map_err(|e| format!("本机语音识别启动失败：{e}"))?;
    let _ = std::fs::remove_file(&path);
    if !out.status.success() {
        return Err("本机语音识别失败".into());
    }
    let text = clean_text(&String::from_utf8_lossy(&out.stdout));
    if text.is_empty() {
        return Err("本机没有听清".into());
    }
    Ok(text)
}

async fn run(cfg: Option<Value>, audio_b64: String, language: Option<String>) -> Result<Value, String> {
    let bytes = decode(&audio_b64)?;
    if bytes.len() < 64 {
        return Err("录音太短".into());
    }
    let lang = language.unwrap_or_else(|| "auto".into());
    let cfg = cfg.unwrap_or(Value::Null);
    match cloud(&cfg, &bytes, &lang).await {
        Ok(text) => Ok(json!({ "text": text, "local": false, "engine": "whisper" })),
        Err(cloud_err) => {
            let wav = bytes.clone();
            let local = tokio::task::spawn_blocking(move || sapi(&wav))
                .await
                .map_err(|e| e.to_string())?;
            match local {
                Ok(text) => Ok(json!({ "text": text, "local": true, "engine": "sapi", "warning": cloud_err })),
                Err(local_err) => Err(format!("{cloud_err}；{local_err}")),
            }
        }
    }
}

#[tauri::command(rename = "ai:speechToText")]
pub async fn speech_to_text(cfg: Option<Value>, audio_b64: String, language: Option<String>) -> Result<Value, String> {
    run(cfg, audio_b64, language).await
}

#[tauri::command(rename = "ai:speechLocal")]
pub async fn speech_local(audio_b64: String, language: Option<String>) -> Result<Value, String> {
    let bytes = decode(&audio_b64)?;
    if bytes.len() < 64 {
        return Err("录音太短".into());
    }
    let _ = language;
    let wav = bytes;
    let text = tokio::task::spawn_blocking(move || sapi(&wav))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({ "text": text, "local": true, "engine": "sapi" }))
}
